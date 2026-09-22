// Service worker: owns all writes to storage, coordinates guided scans, and keeps
// a frozen copy of your stats for every finished scan.
'use strict';

if (typeof importScripts === 'function') importScripts('lib/common.js', 'lib/stats.js');

const DAY = 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 20;
const WRITE_DELAY_MS = 600;

const SCAN_STEPS = {
  x: ['x:posts', 'x:replies', 'x:mentions'],
  linkedin: ['li:posts', 'li:comments'],
};

const DEFAULT_SETTINGS = {
  xHandle: '',
  linkedinProfile: '',
  expandComments: true,
};

// Whether tabs outside a scan report your own new comments and replies (never added to
// your stats; see noteActivity).
const TRACK_ACTIVITY = false;

// ---------- serialised storage access ----------

let chain = Promise.resolve();
function serialized(fn) {
  const run = chain.then(fn, fn);
  chain = run.catch(() => {});
  return run;
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return Object.assign({}, DEFAULT_SETTINGS, settings || {});
}

// ---------- records (cached in memory, written in batches) ----------

let cache = null; // { records, meta, twins: Map(bucket -> [id]) }
let writeTimer = null;

const twinBucket = (ts) => Math.floor(ts / 3000);

function indexTwin(twins, rec) {
  if (rec.platform !== 'linkedin' || rec.kind !== 'post' || !rec.tsPrecise || !rec.createdAt) return;
  const b = twinBucket(rec.createdAt);
  (twins.get(b) || twins.set(b, []).get(b)).push(rec.id);
}

async function loadCache() {
  if (!cache) {
    const { records = {}, meta = {} } = await chrome.storage.local.get(['records', 'meta']);
    const twins = new Map();
    for (const id in records) indexTwin(twins, records[id]);
    cache = { records, meta, twins, dirty: false };
  }
  return cache;
}

function scheduleWrite() {
  if (!writeTimer) writeTimer = setTimeout(() => { serialized(writeNow); }, WRITE_DELAY_MS);
}

// Call only from inside serialized().
async function writeNow() {
  clearTimeout(writeTimer);
  writeTimer = null;
  if (!cache || !cache.dirty) return;
  cache.dirty = false;
  await chrome.storage.local.set({ records: cache.records, meta: cache.meta });
}

const MERGE_SKIP = new Set(['id', 'firstSeen', 'updatedAt']);

function mergeRecord(old, incoming, now) {
  if (!old) {
    return Object.assign({}, incoming, { confidence: incoming.confidence || 0, firstSeen: now, updatedAt: now });
  }
  const out = Object.assign({}, old);
  const weaker = (incoming.confidence || 0) < (old.confidence || 0);
  for (const key of Object.keys(incoming)) {
    const v = incoming[key];
    if (MERGE_SKIP.has(key) || v == null || v === '') continue;
    if (weaker && (key === 'kind' || key === 'direction' || key === 'thread' || key === 'confidence')) continue;
    out[key] = v;
  }
  if (typeof old.impressions === 'number' && typeof incoming.impressions === 'number') {
    out.impressions = Math.max(old.impressions, incoming.impressions);
  }
  if (old.tsPrecise && !incoming.tsPrecise) out.createdAt = old.createdAt;
  if (old.tsPrecise || incoming.tsPrecise) out.tsPrecise = true;
  return out;
}

function sameContent(a, b) {
  const keys = new Set(Object.keys(a).concat(Object.keys(b)));
  for (const k of keys) {
    if (k === 'updatedAt') continue;
    if (a[k] !== b[k]) return false;
  }
  return true;
}

// The same LinkedIn post can surface as urn:li:activity:… or urn:li:ugcPost:…
// Both ids are minted within milliseconds of each other, so match on time.
function findLinkedInTwin(c, rec) {
  if (rec.platform !== 'linkedin' || rec.kind !== 'post' || !rec.tsPrecise || !rec.createdAt) return null;
  const b = twinBucket(rec.createdAt);
  for (const bucket of [b - 1, b, b + 1]) {
    for (const id of c.twins.get(bucket) || []) {
      const r = c.records[id];
      if (r && id !== rec.id && r.direction === rec.direction && Math.abs(r.createdAt - rec.createdAt) < 3000) return r;
    }
  }
  return null;
}

function upsertRecords(incoming) {
  return serialized(async () => {
    const c = await loadCache();
    const now = Date.now();
    let added = 0;
    let updated = 0;
    const touched = new Set();

    for (const rec of incoming || []) {
      if (!rec || typeof rec.id !== 'string' || !rec.platform) continue;
      let key = rec.id;
      let old = c.records[key];
      if (!old) {
        const twin = findLinkedInTwin(c, rec);
        if (twin) { key = twin.id; old = twin; }
      }
      if (!old && !rec.kind) continue; // partial updates only apply to known items
      const merged = mergeRecord(old, rec, now);
      merged.id = key;
      if (!old) {
        added++;
        indexTwin(c.twins, merged);
      } else if (sameContent(old, merged)) {
        continue;
      } else {
        merged.updatedAt = now;
        updated++;
      }
      c.records[key] = merged;
      touched.add(rec.platform);
    }

    if (added || updated) {
      c.meta.lastUpdated = Object.assign({}, c.meta.lastUpdated);
      for (const p of touched) c.meta.lastUpdated[p] = now;
      c.dirty = true;
      scheduleWrite();
    }
    return { added, updated, total: Object.keys(c.records).length };
  });
}

function flushRecords() {
  return serialized(writeNow).then(() => ({ ok: true }));
}

function setIdentity(platform, identity) {
  return serialized(async () => {
    if (!identity || (platform !== 'x' && platform !== 'linkedin')) return { ok: false };
    const { identity: all = {} } = await chrome.storage.local.get('identity');
    const prev = all[platform] || {};
    // A different account id means the user switched accounts: start fresh.
    const base = (identity.id && prev.id && identity.id !== prev.id) ||
      (identity.profileId && prev.profileId && identity.profileId !== prev.profileId) ? {} : prev;
    const next = Object.assign({}, base);
    for (const k of Object.keys(identity)) if (identity[k]) next[k] = identity[k];
    next.updatedAt = Date.now();
    all[platform] = next;
    await chrome.storage.local.set({ identity: all });
    return { ok: true, identity: next };
  });
}

// Pages/threads a scan already opened, with the comment count seen then, so the next
// scan can skip anything that hasn't changed.
function getVisits() {
  return chrome.storage.local.get('visits').then(({ visits }) => visits || {});
}

function setVisits(patch) {
  return serialized(async () => {
    const { visits = {} } = await chrome.storage.local.get('visits');
    for (const k of Object.keys(patch || {})) visits[k] = patch[k];
    await chrome.storage.local.set({ visits });
    return { ok: true };
  });
}

// ---------- scan history ----------

const SNAPSHOT_FIELDS = ['id', 'platform', 'ref', 'kind', 'direction', 'createdAt', 'impressions', 'text', 'url', 'author',
  'authorName', 'parentRef', 'threadRef', 'parentCommentRef', 'onMyPost', 'postAuthor', 'parentAuthor', 'replies', 'likes'];

function compactRecords(records) {
  const out = {};
  for (const id in records) {
    const r = records[id];
    const c = {};
    for (const f of SNAPSHOT_FIELDS) if (r[f] != null && r[f] !== '') c[f] = r[f];
    if (c.text && c.text.length > 160) c.text = Array.from(c.text).slice(0, 159).join('') + '…';
    out[id] = c;
  }
  return out;
}

function recordHistory(scan) {
  return serialized(async () => {
    const c = await loadCache();
    await writeNow();
    const { scanHistory = [], scanCounter = 0 } = await chrome.storage.local.get(['scanHistory', 'scanCounter']);
    if (scanHistory.some((h) => h.platform === scan.platform && h.startedAt === scan.startedAt)) return null;

    const n = scanCounter + 1;
    const id = 'scan-' + n;
    const records = compactRecords(c.records);
    let totals = null;
    let waiting = 0;
    if (typeof SIT !== 'undefined' && SIT.stats) {
      // Totals cover what this scan covered: its own site and its own date range.
      const s = SIT.stats.summarize(records, { platform: scan.platform, range: scan.range || { type: 'days', days: FULL_SCAN_DAYS } }, scan.finishedAt);
      totals = { post: s.posts, comment: s.comments, reply: s.replies };
      waiting = s.needs.comment.concat(s.needs.reply).reduce((sum, e) => sum + e.pending.length, 0);
    }
    const entry = {
      id, n,
      platform: scan.platform,
      status: scan.status,
      mode: scan.mode || 'full',
      rangeLabel: scan.rangeLabel || null,
      message: scan.message || '',
      startedAt: scan.startedAt,
      finishedAt: scan.finishedAt,
      windowStart: scan.cutoffTs,
      range: scan.range || null,
      pausedMs: scan.pausedMs || 0,
      found: scan.found || 0,
      itemCount: Object.keys(records).length,
      totals,
      waiting,
    };
    const history = [entry].concat(scanHistory);
    const removed = history.splice(HISTORY_LIMIT);
    await chrome.storage.local.set({ scanHistory: history, scanCounter: n, ['snap:' + id]: { id, takenAt: scan.finishedAt, records } });
    if (removed.length) await chrome.storage.local.remove(removed.map((h) => 'snap:' + h.id));
    return entry;
  });
}

// ---------- guided scans ----------

const FULL_SCAN_DAYS = 30;
let TAB_REPLY_MS = 2500;

async function getScan() {
  const { scan } = await chrome.storage.session.get('scan');
  return scan || null;
}

async function setScan(scan) {
  if (scan) await chrome.storage.session.set({ scan });
  else await chrome.storage.session.remove('scan');
}

const scanActive = (scan) => !!scan && (scan.status === 'running' || scan.status === 'paused');

async function finishScan(scan, status, extra) {
  const now = Date.now();
  if (scan.status === 'paused' && scan.pausedAt) scan.pausedMs = (scan.pausedMs || 0) + (now - scan.pausedAt);
  Object.assign(scan, extra || {}, { status, finishedAt: now, pausedAt: null, autoPaused: false });
  if (status === 'done') scan.progress = 1;
  await setScan(scan);
  await recordHistory(scan);
}

function linkedinSlug(settings, identity) {
  const raw = (settings.linkedinProfile || '').trim();
  const m = raw.match(/linkedin\.com\/in\/([^/?#]+)/i);
  if (m) return decodeURIComponent(m[1]);
  if (raw && !/[/\s]/.test(raw)) return raw;
  return identity && identity.slug;
}

async function firstUrl(platform) {
  const settings = await getSettings();
  const { identity = {} } = await chrome.storage.local.get('identity');
  if (platform === 'x') {
    const handle = (settings.xHandle || '').replace(/^@/, '').trim() || (identity.x && identity.x.handle);
    return handle ? 'https://x.com/' + encodeURIComponent(handle) : 'https://x.com/home';
  }
  const slug = linkedinSlug(settings, identity.linkedin);
  return slug
    ? 'https://www.linkedin.com/in/' + encodeURIComponent(slug) + '/recent-activity/all/'
    : 'https://www.linkedin.com/feed/';
}

// The range picked on the dashboard is the scan window: "7D" scans the last 7 calendar days
// (today included) and a month scans from that month's first day to now. A full scan, or a
// scan without a usable range, covers the last 30 days.
function scanWindow(range, forceFull, now) {
  let clean = null;
  if (!forceFull && range && range.type === 'month') {
    const year = Number(range.year);
    const month = Number(range.month);
    if (Number.isInteger(year) && Number.isInteger(month) && month >= 0 && month <= 11) clean = { type: 'month', year, month };
  } else if (!forceFull && range && range.type === 'days' && Number(range.days) >= 1) {
    clean = { type: 'days', days: Math.min(365, Math.floor(Number(range.days))) };
  }
  if (!clean) {
    const bounds = SIT.stats.rangeBounds({ type: 'days', days: FULL_SCAN_DAYS }, now);
    return { cutoffTs: bounds.start, mode: 'full', rangeLabel: FULL_SCAN_DAYS + 'D', range: { type: 'days', days: FULL_SCAN_DAYS } };
  }
  const bounds = SIT.stats.rangeBounds(clean, now);
  const label = clean.type === 'days' ? clean.days + 'D' : SIT.stats.MONTHS[clean.month].slice(0, 3) + ' ' + clean.year;
  return { cutoffTs: Math.min(bounds.start, now), mode: 'range', rangeLabel: label, range: clean };
}

async function startScan(platform, forceFull, pickedRange) {
  if (!SCAN_STEPS[platform]) return { ok: false, error: 'Unknown platform' };
  const previous = await getScan();
  if (scanActive(previous)) {
    if (previous.tabId != null) await tellTab(previous.tabId, { type: 'scan:stopped' });
    await finishScan(previous, 'stopped');
  }

  const settings = await getSettings();
  const url = await firstUrl(platform);
  const now = Date.now();
  const range = scanWindow(pickedRange, forceFull, now);
  // Open a blank tab first so the scan is saved before the site's content script asks for it.
  const tab = await chrome.tabs.create({ url: 'about:blank', active: true });
  const scan = {
    platform,
    steps: SCAN_STEPS[platform].slice(),
    index: 0,
    tabId: tab.id,
    startedAt: now,
    cutoffTs: range.cutoffTs,
    mode: range.mode,
    rangeLabel: range.rangeLabel,
    range: range.range,
    expandComments: !!settings.expandComments,
    navIndex: -1,
    navCount: 0,
    found: 0,
    progress: 0,
    pausedMs: 0,
    pausedAt: null,
    autoPaused: false,
    status: 'running',
    message: '',
  };
  await setScan(scan);
  await chrome.tabs.update(tab.id, { url });
  return { ok: true, scan };
}

// Sends a message to the scan tab and waits briefly for its answer (the tab saves what it
// has collected before answering). Resolves null when the tab is gone or doesn't answer.
function tellTab(tabId, msg) {
  let sent;
  try {
    sent = Promise.resolve(chrome.tabs.sendMessage(tabId, msg)).catch(() => null);
  } catch (_) {
    sent = Promise.resolve(null);
  }
  return Promise.race([sent, new Promise((resolve) => setTimeout(() => resolve(null), TAB_REPLY_MS))]);
}

async function pauseScan(scan, auto) {
  if (!scan || scan.status !== 'running') return { ok: false };
  Object.assign(scan, { status: 'paused', pausedAt: Date.now(), autoPaused: !!auto });
  await setScan(scan);
  if (scan.tabId != null) await tellTab(scan.tabId, { type: 'scan:paused', auto: !!auto });
  await flushRecords();
  return { ok: true };
}

async function frontTab(tabId) {
  try {
    const tab = await chrome.tabs.update(tabId, { active: true });
    if (tab && tab.windowId != null && chrome.windows && chrome.windows.update) await chrome.windows.update(tab.windowId, { focused: true });
    return true;
  } catch (_) {
    return false;
  }
}

const SITE_HOSTS = { x: /^https:\/\/(x|twitter)\.com\//i, linkedin: /^https:\/\/www\.linkedin\.com\//i };

// When you resume from the popup while looking at another tab of the same site (say the
// scan's page got stuck and you opened a new one), the scan moves to that tab.
async function tabToAdopt(scan) {
  try {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (active && active.id !== scan.tabId && SITE_HOSTS[scan.platform].test(active.url || '')) return active;
  } catch (_) { /* no tab to adopt */ }
  return null;
}

// Continues a paused scan from the step it stopped at. The scan carries on in place when its
// tab still answers; otherwise its page is loaded again (or a new tab is opened) and the
// current step starts over. Finished steps are never repeated.
async function resumeScan(scan, fromPopup) {
  if (!scan || scan.status !== 'paused') return { ok: false };
  const now = Date.now();
  // A scan that paused by itself (you left its tab) goes back to its own tab. Only a scan you
  // paused yourself can move to the tab you are looking at.
  const pausedByYou = !scan.autoPaused;
  Object.assign(scan, {
    status: 'running', pausedMs: (scan.pausedMs || 0) + (now - (scan.pausedAt || now)), pausedAt: null, autoPaused: false,
    navIndex: -1, navCount: 0,
  });
  const adopt = fromPopup && pausedByYou ? await tabToAdopt(scan) : null;
  if (adopt) {
    const oldTab = scan.tabId;
    scan.tabId = adopt.id;
    await setScan(scan);
    if (oldTab != null) tellTab(oldTab, { type: 'scan:stopped', moved: true });
    await loadScanPage(scan, adopt);
    return { ok: true, moved: true };
  }
  await setScan(scan);
  const alive = scan.tabId != null && (await frontTab(scan.tabId)) && (await tellTab(scan.tabId, { type: 'scan:resumed' }));
  if (!(alive && alive.ok)) {
    let tab = null;
    try { tab = scan.tabId != null ? await chrome.tabs.get(scan.tabId) : null; } catch (_) { tab = null; }
    await loadScanPage(scan, tab);
  }
  return { ok: true };
}

// (Re)loads the scan's start page in `tab`, or in a new tab when there is none. The content
// script there picks the scan up and goes to the current step.
async function loadScanPage(scan, tab) {
  const url = await firstUrl(scan.platform);
  if (tab) {
    try {
      if (tab.url === url && chrome.tabs.reload) await chrome.tabs.reload(tab.id);
      else await chrome.tabs.update(tab.id, { url, active: true });
      await frontTab(tab.id);
      return;
    } catch (_) { /* the tab is gone: open a new one */ }
  }
  const fresh = await chrome.tabs.create({ url: 'about:blank', active: true });
  scan.tabId = fresh.id;
  await setScan(scan);
  await chrome.tabs.update(fresh.id, { url });
}

// Scan messages are handled one at a time: each reads the scan, changes it and writes it back.
let scanChain = Promise.resolve();
function scanQueued(fn) {
  const run = scanChain.then(fn, fn);
  scanChain = run.catch(() => {});
  return run;
}

async function handleScanMessage(msg, sender) {
  const scan = await getScan();
  const tabId = sender.tab && sender.tab.id;
  const own = scanActive(scan) && tabId != null && scan.tabId === tabId;

  switch (msg.type) {
    case 'scan:hello':
      return { task: own ? scan : null, track: TRACK_ACTIVITY };

    case 'scan:get':
      return own ? scan : null;

    case 'scan:navigate': {
      if (!own) return { ok: false };
      if (scan.navIndex === msg.index) scan.navCount++;
      else { scan.navIndex = msg.index; scan.navCount = 1; }
      await setScan(scan);
      return { ok: scan.navCount <= 3 };
    }

    case 'scan:insert': {
      // Adds follow-up steps (e.g. one per post with comments) right after the current one.
      if (!own) return { ok: false };
      const extra = Array.from(new Set(Array.isArray(msg.steps) ? msg.steps : []))
        .filter((s) => typeof s === 'string' && !scan.steps.includes(s))
        .slice(0, 40);
      scan.steps.splice(scan.index + 1, 0, ...extra);
      await setScan(scan);
      return { ok: true, added: extra.length };
    }

    case 'scan:progress': {
      // Shown in the popup. It never moves backwards, even when follow-up steps are added.
      if (!own) return { ok: false };
      const p = Math.max(0, Math.min(0.99, Number(msg.progress) || 0));
      scan.progress = Math.max(scan.progress || 0, p);
      if (Number.isFinite(Number(msg.found))) scan.foundLive = Math.max(scan.found || 0, Number(msg.found));
      await setScan(scan);
      return { ok: true };
    }

    case 'scan:advance': {
      if (!own) return null;
      scan.found += Number(msg.found) || 0;
      scan.foundLive = scan.found;
      scan.index++;
      if (scan.index >= scan.steps.length) {
        await finishScan(scan, 'done');
        return null;
      }
      scan.progress = Math.max(scan.progress || 0, Math.min(0.99, scan.index / scan.steps.length));
      await setScan(scan);
      return scan;
    }

    case 'scan:fail':
      if (own) await finishScan(scan, 'failed', { message: String(msg.message || '') });
      return { ok: true };

    case 'scan:pause':
      // Only the scan's own tab pauses it automatically (when it goes to the background).
      if (msg.auto && !own) return { ok: false };
      return pauseScan(scan, !!msg.auto);

    case 'scan:resume':
      // Coming back to the tab only resumes a scan that paused by itself, never one you paused.
      if (msg.auto && !(own && scan.autoPaused)) return { ok: false };
      return resumeScan(scan, tabId == null);

    case 'scan:stop':
      if (scanActive(scan)) {
        // The scan tab saves what it has before the scan is closed (it already has when it asks itself).
        if (!own && scan.tabId != null) await tellTab(scan.tabId, { type: 'scan:stopped' });
        await finishScan(scan, 'stopped');
      }
      return { ok: true };

    case 'scan:status':
      return scan;

    case 'scan:start':
      // Scans are started from the popup, never by a page.
      if (tabId != null) return { ok: false, error: 'Not allowed' };
      return startScan(msg.platform, msg.mode === 'full', msg.range);
  }
  return null;
}

chrome.tabs.onRemoved.addListener((tabId) => scanQueued(async () => {
  const scan = await getScan();
  // A paused scan outlives its tab: Resume opens a new one.
  if (scan && scan.status === 'running' && scan.tabId === tabId) await finishScan(scan, 'stopped');
}));

// Earlier versions also recorded whatever loaded while you browsed, which gave partial,
// misleading numbers before any scan. Stats now come from scans only, so items stored
// before the first scan are removed once.
function dropUnscannedRecords() {
  return serialized(async () => {
    const { scanOnly, scanHistory = [], records } = await chrome.storage.local.get(['scanOnly', 'scanHistory', 'records']);
    if (scanOnly) return;
    if (!scanHistory.length && records && Object.keys(records).length) {
      cache = null;
      await chrome.storage.local.remove(['records', 'meta', 'visits']);
    }
    await chrome.storage.local.set({ scanOnly: true });
  });
}

// ---------- messaging ----------

async function clearAll() {
  await serialized(async () => {
    clearTimeout(writeTimer);
    writeTimer = null;
    cache = null;
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('snap:'));
    await chrome.storage.local.remove(keys.concat(['records', 'meta', 'identity', 'scanHistory', 'scanCounter', 'visits']));
  });
  return { ok: true };
}

async function handle(msg, sender) {
  if (!msg || typeof msg.type !== 'string') return null;
  if (msg.type.startsWith('scan:')) return scanQueued(() => handleScanMessage(msg, sender));
  switch (msg.type) {
    case 'records:upsert': {
      // Stats only ever come from scans: a tab that isn't the scan's tab can't add records.
      if (sender && sender.tab) {
        const scan = await getScan();
        if (!(scanActive(scan) && scan.tabId === sender.tab.id)) return { added: 0, updated: 0, ignored: true };
      }
      return upsertRecords(Array.isArray(msg.records) ? msg.records : []);
    }
    case 'records:flush':
      return flushRecords();
    case 'identity:set':
      return setIdentity(msg.platform, msg.identity);
    case 'visits:get':
      return getVisits();
    case 'visits:set':
      return setVisits(msg.visits);
    case 'settings:get':
      return getSettings();
    case 'data:clear':
      return sender && sender.tab ? { ok: false } : clearAll();
  }
  return null;
}

dropUnscannedRecords().catch(() => {});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  handle(msg, sender).then(sendResponse, (err) => sendResponse({ error: String(err && err.message || err) }));
  return true;
});
