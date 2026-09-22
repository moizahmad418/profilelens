// Runs src/background.js against an in-memory fake of the chrome.* APIs.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadBackground(initialLocal) {
  const areas = { local: structuredClone(initialLocal || {}), session: {} };
  const tabs = [];
  const sentToTabs = [];
  const tabReplies = {}; // message type -> what the tab answers
  let activeTab = null;
  let onMessage = null;
  let onRemoved = null;

  const area = (name) => ({
    get: async (keys) => {
      const out = {};
      const list = keys == null ? Object.keys(areas[name]) : [].concat(keys); // get(null) returns everything, like Chrome
      for (const k of list) if (k in areas[name]) out[k] = structuredClone(areas[name][k]);
      return out;
    },
    set: async (obj) => { Object.assign(areas[name], structuredClone(obj)); },
    remove: async (keys) => { for (const k of [].concat(keys)) delete areas[name][k]; },
  });

  const chrome = {
    storage: { local: area('local'), session: area('session') },
    runtime: { onMessage: { addListener: (fn) => { onMessage = fn; } } },
    tabs: {
      create: async ({ url }) => { const tab = { id: tabs.length + 1, url }; tabs.push(tab); return tab; },
      update: async (id, { url }) => {
        if (!tabs[id - 1] || tabs[id - 1].closed) throw new Error('No tab with id ' + id);
        if (url) tabs[id - 1].url = url;
        return tabs[id - 1];
      },
      get: async (id) => {
        if (!tabs[id - 1] || tabs[id - 1].closed) throw new Error('No tab with id ' + id);
        return tabs[id - 1];
      },
      reload: async () => {},
      query: async (q) => (q && q.active && activeTab ? [activeTab] : []),
      sendMessage: (tabId, msg) => {
        sentToTabs.push({ tabId, msg });
        if (!tabs[tabId - 1] || tabs[tabId - 1].closed) return Promise.reject(new Error('Receiving end does not exist'));
        return Promise.resolve(tabReplies[msg.type]);
      },
      onRemoved: { addListener: (fn) => { onRemoved = fn; } },
    },
  };

  const code = fs.readFileSync(path.join(__dirname, '..', 'src', 'background.js'), 'utf8');
  const context = { chrome, console, structuredClone, setTimeout, clearTimeout };
  context.importScripts = (...files) => {
    for (const f of files) vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'src', f), 'utf8'), context);
  };
  context.globalThis = context;
  vm.createContext(context);
  vm.runInContext(code, context);

  // Objects created inside the vm context have their own prototypes; compare plain copies.
  const plain = (v) => (v == null ? v : JSON.parse(JSON.stringify(v)));
  const send = (msg, sender = {}) => new Promise((resolve) => onMessage(msg, sender, (v) => resolve(plain(v))));
  const flush = () => send({ type: 'records:flush' });
  return {
    send, flush, areas, tabs, sentToTabs, tabReplies,
    removeTab: (id) => { if (tabs[id - 1]) tabs[id - 1].closed = true; return onRemoved(id); },
    openTab: (url) => chrome.tabs.create({ url }),
    setActiveTab: (id) => { activeTab = tabs[id - 1]; },
  };
}

const post = (over) => Object.assign({
  id: 'x:1', platform: 'x', ref: '1', kind: 'post', direction: 'mine', createdAt: 1757000000000,
  tsPrecise: true, impressions: 100, text: 'hello', confidence: 2,
}, over);

test('upsert adds, merges and ignores unchanged records', async () => {
  const bg = loadBackground();
  assert.deepEqual(await bg.send({ type: 'records:upsert', records: [post()] }), { added: 1, updated: 0, total: 1 });
  assert.deepEqual(await bg.send({ type: 'records:upsert', records: [post()] }), { added: 0, updated: 0, total: 1 });

  const res = await bg.send({ type: 'records:upsert', records: [post({ impressions: 250, text: null })] });
  assert.equal(res.updated, 1);
  await bg.flush();
  const saved = bg.areas.local.records['x:1'];
  assert.equal(saved.impressions, 250);
  assert.equal(saved.text, 'hello', 'null fields never wipe stored values');
  assert.ok(bg.areas.local.meta.lastUpdated.x > 0);
});

test('impressions never go down and weaker sources cannot reclassify', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'records:upsert', records: [post({ impressions: 500 })] });
  await bg.send({ type: 'records:upsert', records: [post({ impressions: 40, kind: 'comment', confidence: 0 })] });
  await bg.flush();
  const saved = bg.areas.local.records['x:1'];
  assert.equal(saved.impressions, 500);
  assert.equal(saved.kind, 'post');
});

test('partial updates only apply to known items', async () => {
  const bg = loadBackground();
  const res = await bg.send({ type: 'records:upsert', records: [{ id: 'li:comment:9', platform: 'linkedin', impressions: 12 }] });
  assert.equal(res.total, 0);
  await bg.send({ type: 'records:upsert', records: [post({ id: 'li:comment:9', platform: 'linkedin', kind: 'comment', impressions: null })] });
  await bg.send({ type: 'records:upsert', records: [{ id: 'li:comment:9', platform: 'linkedin', impressions: 12 }] });
  await bg.flush();
  assert.equal(bg.areas.local.records['li:comment:9'].impressions, 12);
  assert.equal(bg.areas.local.records['li:comment:9'].kind, 'comment');
});

test('the same LinkedIn post under activity and ugcPost urns is stored once', async () => {
  const bg = loadBackground();
  const base = { platform: 'linkedin', kind: 'post', direction: 'mine', tsPrecise: true, confidence: 1 };
  await bg.send({ type: 'records:upsert', records: [Object.assign({ id: 'li:activity:1', createdAt: 1757000000000, impressions: 10 }, base)] });
  const res = await bg.send({ type: 'records:upsert', records: [Object.assign({ id: 'li:ugcPost:2', createdAt: 1757000000400, impressions: 30 }, base)] });
  assert.equal(res.total, 1);
  await bg.flush();
  assert.equal(bg.areas.local.records['li:activity:1'].impressions, 30);
});

test('concurrent upserts do not lose writes', async () => {
  const bg = loadBackground();
  await Promise.all(Array.from({ length: 20 }, (_, i) =>
    bg.send({ type: 'records:upsert', records: [post({ id: 'x:' + i, ref: String(i) })] })));
  await bg.flush();
  assert.equal(Object.keys(bg.areas.local.records).length, 20);
});

test('identity resets when the account changes', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'identity:set', platform: 'x', identity: { id: '1', handle: 'old', name: 'Old' } });
  await bg.send({ type: 'identity:set', platform: 'x', identity: { id: '2', handle: 'new' } });
  const x = bg.areas.local.identity.x;
  assert.equal(x.id, '2');
  assert.equal(x.handle, 'new');
  assert.equal(x.name, undefined);
});

test('scan lifecycle: start, step through, finish', async () => {
  const bg = loadBackground();
  bg.areas.local.identity = { x: { id: '1', handle: 'alex' } };
  const start = await bg.send({ type: 'scan:start', platform: 'x' });
  assert.equal(start.ok, true);
  assert.equal(bg.tabs[0].url, 'https://x.com/alex', 'X scans start on the Posts tab');

  const sender = { tab: { id: bg.tabs[0].id } };
  assert.equal(await bg.send({ type: 'scan:get' }, { tab: { id: 99 } }), null, 'other tabs are not scanning');
  const task = await bg.send({ type: 'scan:get' }, sender);
  assert.deepEqual(task.steps, ['x:posts', 'x:replies', 'x:mentions']);

  const next = await bg.send({ type: 'scan:advance', found: 12 }, sender);
  assert.equal(next.index, 1);
  await bg.send({ type: 'scan:advance', found: 0 }, sender);
  assert.equal(await bg.send({ type: 'scan:advance', found: 3 }, sender), null);
  const done = await bg.send({ type: 'scan:status' });
  assert.equal(done.status, 'done');
  assert.equal(done.found, 15);
});

test('scan navigation loops are cut off and stop from the popup notifies the tab', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'scan:start', platform: 'linkedin' });
  assert.equal(bg.tabs[0].url, 'https://www.linkedin.com/feed/', 'unknown profile starts on the feed');
  const sender = { tab: { id: 1 } };
  for (let i = 0; i < 3; i++) assert.equal((await bg.send({ type: 'scan:navigate', index: 0 }, sender)).ok, true);
  assert.equal((await bg.send({ type: 'scan:navigate', index: 0 }, sender)).ok, false);

  await bg.send({ type: 'scan:stop' });
  assert.equal((await bg.send({ type: 'scan:status' })).status, 'stopped');
  assert.deepEqual(JSON.parse(JSON.stringify(bg.sentToTabs)), [{ tabId: 1, msg: { type: 'scan:stopped' } }]);
});

test('closing the scan tab stops the scan', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'scan:start', platform: 'x' });
  await bg.removeTab(1);
  assert.equal((await bg.send({ type: 'scan:status' })).status, 'stopped');
});

test('settings override the detected LinkedIn profile for scans', async () => {
  const bg = loadBackground();
  bg.areas.local.settings = { linkedinProfile: 'https://www.linkedin.com/in/alex-morgan-123/' };
  await bg.send({ type: 'scan:start', platform: 'linkedin' });
  assert.equal(bg.tabs[0].url, 'https://www.linkedin.com/in/alex-morgan-123/recent-activity/all/');
});

test('scan:insert adds follow-up steps after the current one', async () => {
  const bg = loadBackground();
  bg.areas.local.identity = { linkedin: { slug: 'alex' } };
  await bg.send({ type: 'scan:start', platform: 'linkedin' });
  const sender = { tab: { id: 1 } };
  const res = await bg.send({ type: 'scan:insert', steps: ['li:post|activity:1', 'li:post|activity:2', 'li:post|activity:1'] }, sender);
  assert.equal(res.added, 2);
  assert.equal((await bg.send({ type: 'scan:insert', steps: ['li:post|activity:2'] }, sender)).added, 0, 'no duplicates');
  assert.equal((await bg.send({ type: 'scan:insert', steps: ['x'] }, { tab: { id: 5 } })).ok, false, 'only the scan tab can insert');
  const task = await bg.send({ type: 'scan:get' }, sender);
  assert.deepEqual(task.steps, ['li:posts', 'li:post|activity:1', 'li:post|activity:2', 'li:comments']);
  const next = await bg.send({ type: 'scan:advance', found: 1 }, sender);
  assert.equal(next.steps[next.index], 'li:post|activity:1');
});

const DAY = 86400000;

test('finished scans are saved to history with a frozen snapshot of the stats', async () => {
  const bg = loadBackground();
  bg.areas.local.identity = { x: { id: '1', handle: 'alex' } };
  await bg.send({ type: 'records:upsert', records: [post({ createdAt: Date.now() - DAY, impressions: 100, confidence: 2, source: 'api' })] });
  await bg.send({ type: 'scan:start', platform: 'x' });
  const sender = { tab: { id: 1 } };
  for (let i = 0; i < 3; i++) await bg.send({ type: 'scan:advance', found: 1 }, sender);

  const [entry] = bg.areas.local.scanHistory;
  assert.equal(entry.id, 'scan-1');
  assert.equal(entry.n, 1);
  assert.equal(entry.platform, 'x');
  assert.equal(entry.status, 'done');
  assert.equal(entry.mode, 'full');
  assert.equal(entry.found, 3);
  assert.equal(entry.itemCount, 1);
  assert.deepEqual(entry.totals, { post: 100, comment: 0, reply: 0 });
  assert.ok(entry.finishedAt >= entry.startedAt);

  const snap = bg.areas.local['snap:scan-1'];
  assert.equal(snap.records['x:1'].impressions, 100);
  assert.equal(snap.records['x:1'].confidence, undefined, 'snapshots keep only what the popup shows');

  // Later changes never touch the saved snapshot.
  await bg.send({ type: 'records:upsert', records: [post({ createdAt: Date.now() - DAY, impressions: 900 })] });
  await bg.flush();
  assert.equal(bg.areas.local.records['x:1'].impressions, 900);
  assert.equal(bg.areas.local['snap:scan-1'].records['x:1'].impressions, 100);
});

test('stopped, failed and closed scans are recorded too', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'scan:start', platform: 'x' });
  await bg.send({ type: 'scan:stop' });
  await bg.send({ type: 'scan:start', platform: 'linkedin' });
  await bg.send({ type: 'scan:fail', message: 'not signed in' }, { tab: { id: 2 } });
  await bg.send({ type: 'scan:start', platform: 'x' });
  await bg.removeTab(3);
  assert.deepEqual(bg.areas.local.scanHistory.map((h) => [h.n, h.platform, h.status]), [
    [3, 'x', 'stopped'], [2, 'linkedin', 'failed'], [1, 'x', 'stopped'],
  ]);
  assert.equal(bg.areas.local.scanHistory[1].message, 'not signed in');
});

test('a scan covers the range picked on the dashboard; a full scan covers 30 days', async () => {
  const bg = loadBackground();
  const now = Date.now();
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);

  const week = await bg.send({ type: 'scan:start', platform: 'x', range: { type: 'days', days: 7 } });
  assert.equal(week.scan.mode, 'range');
  assert.equal(week.scan.rangeLabel, '7D');
  assert.ok(Math.abs(week.scan.cutoffTs - (startOfToday - 6 * DAY)) <= 3600e3, '7D = today and the 6 days before');

  const today = await bg.send({ type: 'scan:start', platform: 'x', range: { type: 'days', days: 1 } });
  assert.equal(today.scan.rangeLabel, '1D');
  assert.ok(Math.abs(today.scan.cutoffTs - startOfToday) <= 3600e3);

  const d = new Date(now);
  const month = await bg.send({ type: 'scan:start', platform: 'linkedin', range: { type: 'month', year: d.getFullYear(), month: d.getMonth() } });
  assert.equal(month.scan.cutoffTs, new Date(d.getFullYear(), d.getMonth(), 1).getTime());

  // "Full scan" ignores the picked range, and so does a scan without a usable range.
  for (const msg of [{ mode: 'full', range: { type: 'days', days: 3 } }, {}, { range: { type: 'days', days: 'x' } }]) {
    const full = await bg.send(Object.assign({ type: 'scan:start', platform: 'x' }, msg));
    assert.equal(full.scan.mode, 'full');
    assert.equal(full.scan.rangeLabel, '30D');
    assert.ok(Math.abs(full.scan.cutoffTs - (startOfToday - 29 * DAY)) <= 3600e3, 'a full scan covers the last 30 days');
  }
});

test('nothing is saved outside a scan: only the scan tab can add records', async () => {
  const bg = loadBackground();
  const browsing = { tab: { id: 77 } };
  assert.deepEqual(await bg.send({ type: 'scan:hello' }, browsing), { task: null, track: false });
  const ignored = await bg.send({ type: 'records:upsert', records: [post()] }, browsing);
  assert.equal(ignored.ignored, true);
  await bg.flush();
  assert.equal(bg.areas.local.records, undefined, 'browsing LinkedIn or X adds nothing before a scan');

  const { scan } = await bg.send({ type: 'scan:start', platform: 'x', range: { type: 'days', days: 3 } });
  const scanTab = { tab: { id: scan.tabId } };
  assert.equal((await bg.send({ type: 'scan:hello' }, scanTab)).task.platform, 'x');
  assert.equal((await bg.send({ type: 'records:upsert', records: [post({ id: 'x:2', ref: '2' })] }, browsing)).ignored, true, 'another tab still cannot');
  assert.equal((await bg.send({ type: 'records:upsert', records: [post()] }, scanTab)).added, 1);

  await bg.send({ type: 'scan:stop' });
  assert.equal((await bg.send({ type: 'records:upsert', records: [post({ id: 'x:3', ref: '3' })] }, scanTab)).ignored, true, 'not after the scan ended either');
  await bg.flush();
  assert.deepEqual(Object.keys(bg.areas.local.records), ['x:1']);
});

test('items recorded before any scan (by earlier versions) are removed once', async () => {
  const stale = { records: { 'x:1': post() }, meta: { lastUpdated: { x: 1 } } };
  const bg = loadBackground(stale);
  await bg.send({ type: 'settings:get' });
  await bg.flush();
  assert.equal(bg.areas.local.records, undefined);
  assert.equal(bg.areas.local.scanOnly, true);

  const scanned = loadBackground({ records: { 'x:1': post() }, scanHistory: [{ id: 'scan-1', n: 1, platform: 'x', status: 'done' }] });
  await scanned.send({ type: 'settings:get' });
  await scanned.flush();
  assert.ok(scanned.areas.local.records['x:1'], 'data that came with scans is kept');
});

test('pause and resume: the scan keeps its step and carries on in its tab', async () => {
  const bg = loadBackground();
  const { scan } = await bg.send({ type: 'scan:start', platform: 'x', range: { type: 'days', days: 7 } });
  const scanTab = { tab: { id: scan.tabId } };
  await bg.send({ type: 'scan:advance', found: 5 }, scanTab);

  bg.tabReplies['scan:paused'] = { ok: true };
  bg.tabReplies['scan:resumed'] = { ok: true };
  assert.deepEqual(await bg.send({ type: 'scan:pause' }), { ok: true });
  let status = await bg.send({ type: 'scan:status' });
  assert.equal(status.status, 'paused');
  assert.equal(status.index, 1);
  assert.ok(bg.sentToTabs.some((m) => m.tabId === scan.tabId && m.msg.type === 'scan:paused'));
  assert.equal((await bg.send({ type: 'scan:hello' }, scanTab)).task.status, 'paused', 'a reloaded scan tab learns it is paused');
  assert.equal((await bg.send({ type: 'records:upsert', records: [post()] }, scanTab)).added, 1, 'the tab can still save what it had collected');

  const tabsBefore = bg.tabs.length;
  assert.equal((await bg.send({ type: 'scan:resume' })).ok, true);
  status = await bg.send({ type: 'scan:status' });
  assert.equal(status.status, 'running');
  assert.equal(status.index, 1, 'resumes at the step it was on');
  assert.equal(status.found, 5);
  assert.equal(bg.tabs.length, tabsBefore, 'the tab answered, so no new tab was opened');
  assert.ok(bg.sentToTabs.some((m) => m.msg.type === 'scan:resumed'));

  await bg.send({ type: 'scan:advance', found: 1 }, scanTab);
  assert.equal(await bg.send({ type: 'scan:advance', found: 1 }, scanTab), null);
  const entry = bg.areas.local.scanHistory[0];
  assert.equal(entry.status, 'done');
  assert.ok(entry.pausedMs >= 0);
});

test('a paused scan outlives its tab: resume opens a new tab at the same step', async () => {
  const bg = loadBackground();
  bg.areas.local.identity = { x: { id: '1', handle: 'alex' } };
  const { scan } = await bg.send({ type: 'scan:start', platform: 'x' });
  const oldTab = { tab: { id: scan.tabId } };
  await bg.send({ type: 'scan:advance', found: 2 }, oldTab);
  await bg.send({ type: 'scan:pause' });

  await bg.removeTab(scan.tabId);
  assert.equal((await bg.send({ type: 'scan:status' })).status, 'paused', 'closing the tab of a paused scan does not end it');

  await bg.send({ type: 'scan:resume' });
  const status = await bg.send({ type: 'scan:status' });
  assert.equal(status.status, 'running');
  assert.equal(status.index, 1);
  assert.notEqual(status.tabId, scan.tabId);
  assert.equal(bg.tabs[status.tabId - 1].url, 'https://x.com/alex');
  assert.equal(await bg.send({ type: 'scan:get' }, oldTab), null, 'the old tab no longer owns the scan');
  assert.equal((await bg.send({ type: 'scan:get' }, { tab: { id: status.tabId } })).index, 1);
});

test('resuming from the popup while another tab of the site is in front moves the scan there', async () => {
  const bg = loadBackground();
  bg.areas.local.identity = { linkedin: { slug: 'alex' } };
  const { scan } = await bg.send({ type: 'scan:start', platform: 'linkedin' });
  await bg.send({ type: 'scan:pause' });
  const other = await bg.openTab('https://www.linkedin.com/feed/');
  bg.setActiveTab(other.id);

  const res = await bg.send({ type: 'scan:resume' });
  assert.equal(res.moved, true);
  const status = await bg.send({ type: 'scan:status' });
  assert.equal(status.tabId, other.id);
  assert.equal(bg.tabs[other.id - 1].url, 'https://www.linkedin.com/in/alex/recent-activity/all/');
  assert.ok(bg.sentToTabs.some((m) => m.tabId === scan.tabId && m.msg.type === 'scan:stopped' && m.msg.moved));
});

test('leaving the scan tab pauses the scan and coming back resumes it, but never a scan you paused', async () => {
  const bg = loadBackground();
  const { scan } = await bg.send({ type: 'scan:start', platform: 'x' });
  const scanTab = { tab: { id: scan.tabId } };
  bg.tabReplies['scan:resumed'] = { ok: true };

  assert.equal((await bg.send({ type: 'scan:pause', auto: true }, { tab: { id: 99 } })).ok, false, 'only the scan tab');
  await bg.send({ type: 'scan:pause', auto: true }, scanTab);
  let status = await bg.send({ type: 'scan:status' });
  assert.deepEqual([status.status, status.autoPaused], ['paused', true]);
  await bg.send({ type: 'scan:resume', auto: true }, scanTab);
  assert.equal((await bg.send({ type: 'scan:status' })).status, 'running');

  await bg.send({ type: 'scan:pause' });
  assert.equal((await bg.send({ type: 'scan:resume', auto: true }, scanTab)).ok, false);
  assert.equal((await bg.send({ type: 'scan:status' })).status, 'paused');
});

test('progress reports never move backwards and never undo a step change', async () => {
  const bg = loadBackground();
  const { scan } = await bg.send({ type: 'scan:start', platform: 'x' });
  const scanTab = { tab: { id: scan.tabId } };
  // Sent together, like a progress tick racing the end of a step.
  await Promise.all([
    bg.send({ type: 'scan:progress', progress: 0.3, found: 12 }, scanTab),
    bg.send({ type: 'scan:advance', found: 12 }, scanTab),
    bg.send({ type: 'scan:progress', progress: 0.1, found: 3 }, scanTab),
  ]);
  const status = await bg.send({ type: 'scan:status' });
  assert.equal(status.index, 1);
  assert.ok(status.progress >= 1 / 3);
  assert.equal(status.foundLive, 12);
  assert.equal((await bg.send({ type: 'scan:progress', progress: 0.9 }, { tab: { id: 99 } })).ok, false);
});

test('a scan’s saved totals cover its own range and site, not always 30 days', async () => {
  const bg = loadBackground();
  const now = Date.now();
  const { scan } = await bg.send({ type: 'scan:start', platform: 'x', range: { type: 'days', days: 10 } });
  const scanTab = { tab: { id: scan.tabId } };
  await bg.send({ type: 'records:upsert', records: [
    post({ id: 'x:1', ref: '1', createdAt: now - 2 * DAY, impressions: 100 }),
    post({ id: 'x:2', ref: '2', createdAt: now - 20 * DAY, impressions: 5000 }),
    post({ id: 'li:activity:3', platform: 'linkedin', ref: '3', createdAt: now - 2 * DAY, impressions: 900 }),
  ] }, scanTab);
  await bg.send({ type: 'scan:stop' });
  const entry = bg.areas.local.scanHistory[0];
  assert.deepEqual(entry.range, { type: 'days', days: 10 });
  assert.equal(entry.rangeLabel, '10D');
  assert.equal(entry.totals.post, 100, 'only X items from the scanned 10 days');
});

test('history keeps the latest 20 scans and removes older snapshots', async () => {
  const bg = loadBackground();
  for (let i = 0; i < 22; i++) {
    await bg.send({ type: 'scan:start', platform: 'x' });
    await bg.send({ type: 'scan:stop' });
  }
  const history = bg.areas.local.scanHistory;
  assert.equal(history.length, 20);
  assert.equal(history[0].n, 22);
  assert.equal(history[19].n, 3);
  assert.equal('snap:scan-1' in bg.areas.local, false);
  assert.equal('snap:scan-2' in bg.areas.local, false);
  assert.equal('snap:scan-3' in bg.areas.local, true);
});

test('visits are remembered and clearing data removes history and snapshots', async () => {
  const bg = loadBackground();
  await bg.send({ type: 'visits:set', visits: { 'li:post:1': 3 } });
  await bg.send({ type: 'visits:set', visits: { 'li:thread:9': 2 } });
  assert.deepEqual(await bg.send({ type: 'visits:get' }), { 'li:post:1': 3, 'li:thread:9': 2 });

  await bg.send({ type: 'records:upsert', records: [post()] });
  await bg.send({ type: 'scan:start', platform: 'x' });
  await bg.send({ type: 'scan:stop' });
  assert.ok(bg.areas.local['snap:scan-1']);
  await bg.send({ type: 'data:clear' });
  for (const k of ['records', 'scanHistory', 'scanCounter', 'visits', 'snap:scan-1']) assert.equal(k in bg.areas.local, false, k);
  await bg.send({ type: 'records:upsert', records: [post({ id: 'x:2', ref: '2' })] });
  await bg.flush();
  assert.deepEqual(Object.keys(bg.areas.local.records), ['x:2'], 'the in-memory cache was reset too');
});

test('only the popup can start scans or clear data', async () => {
  const bg = loadBackground();
  const page = { tab: { id: 5 } };
  assert.equal((await bg.send({ type: 'scan:start', platform: 'x' }, page)).ok, false);
  assert.equal((await bg.send({ type: 'data:clear' }, page)).ok, false);
  assert.equal(bg.tabs.length, 0);
});
