// X (Twitter) content script: turns captured API responses into records,
// with a light DOM fallback for view counts, and runs guided scans.
(function () {
  'use strict';
  const SIT = globalThis.SIT;
  if (!SIT || SIT.__xContentLoaded) return;
  SIT.__xContentLoaded = true;

  const session = SIT.createSession();
  const saver = SIT.createSaver(session);
  const memory = new Map(); // tweet id -> { mine, kind }
  const pending = [];
  let me = null;
  let handleOverride = '';

  // ---------- network payloads from net-hook.js ----------

  const seenOps = new Set(); // X timeline requests the page has made (by operation name)
  const pagerWaiters = new Map(); // command id -> { resolve, onProgress }

  function opName(url) {
    try {
      const path = new URL(url).pathname;
      const gql = path.match(/\/graphql\/[^/]+\/([^/]+)$/);
      if (gql) return gql[1];
      const rest = path.match(/\/i\/api\/(?:2|1\.1)\/(.+?)(?:\.json)?$/);
      return rest ? rest[1] : null;
    } catch (_) {
      return null;
    }
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data) return;
    if (event.data.__sit === 'pager') {
      const waiter = pagerWaiters.get(event.data.id);
      if (!waiter) return;
      if (event.data.done) {
        pagerWaiters.delete(event.data.id);
        waiter.resolve(event.data);
      } else if (waiter.onProgress) {
        waiter.onProgress(event.data);
      }
      return;
    }
    if (event.data.__sit !== 'net' || typeof event.data.body !== 'string') return;
    const op = opName(event.data.url);
    if (op && event.data.body.indexOf('"cursorType"') !== -1) seenOps.add(op);
    let json;
    try { json = JSON.parse(event.data.body); } catch (_) { return; }

    const viewer = SIT.x.extractViewer(json);
    if (viewer) setMe(viewer);

    if (!me) {
      if (pending.length < 80) pending.push(json);
      return;
    }
    ingest(json);
  });

  function ingest(json) {
    if (saver.mode() === 'off') return; // nothing is collected outside a scan
    const tweets = SIT.x.extractTweets(json);
    if (!tweets.length) return;
    if (memory.size > 50000) memory.clear();
    saver.push(SIT.x.toRecords(tweets, me, memory));
  }

  // ---------- identity ----------

  function readTwid() {
    const m = document.cookie.match(/(?:^|;\s*)twid=([^;]+)/);
    if (!m) return null;
    const value = decodeURIComponent(m[1]).replace(/"/g, '');
    const id = value.match(/u=(\d+)/);
    return id ? id[1] : null;
  }

  function domHandle() {
    const link = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const m = link && (link.getAttribute('href') || '').match(/^\/([A-Za-z0-9_]{1,15})\/?$/);
    return m ? m[1] : null;
  }

  function setMe(next) {
    const merged = Object.assign({}, me || {});
    if (next.id && merged.id && next.id !== merged.id) {
      // Different account than the cached one.
      merged.handle = null;
      merged.name = null;
    }
    for (const k of ['id', 'handle', 'name']) if (next[k]) merged[k] = next[k];
    if (handleOverride) merged.handle = handleOverride;
    if (!merged.id && !merged.handle) return;

    const changed = !me || me.id !== merged.id || me.handle !== merged.handle;
    me = merged;
    if (changed) {
      SIT.send({ type: 'identity:set', platform: 'x', identity: { id: me.id, handle: me.handle, name: me.name } });
      while (pending.length) ingest(pending.shift());
    }
  }

  async function initIdentity() {
    const { settings = {}, identity = {}, records = {} } = await chrome.storage.local.get(['settings', 'identity', 'records']);
    handleOverride = String(settings.xHandle || '').replace(/^@/, '').trim();

    // Seed reply matching with what we already know.
    for (const key in records) {
      const r = records[key];
      if (r.platform === 'x' && r.ref && r.direction === 'mine') memory.set(r.ref, { mine: true, kind: r.kind });
    }

    const twid = readTwid();
    const cached = identity.x || {};
    const sameAccount = !twid || !cached.id || cached.id === twid;
    setMe({
      id: twid || (sameAccount ? cached.id : null),
      handle: sameAccount ? cached.handle : null,
      name: sameAccount ? cached.name : null,
    });

    SIT.onReady(async () => {
      const handle = await SIT.waitFor(domHandle, 30000, 700);
      if (handle) setMe({ handle });
    });
  }

  function waitForMe(timeoutMs) {
    return SIT.waitFor(() => (me && me.handle ? me : null), timeoutMs, 500);
  }

  // ---------- DOM fallback (view counts on rendered posts) ----------

  function scanDom() {
    if (!me || saver.mode() === 'off') return;
    const updates = [];
    for (const article of document.querySelectorAll('article[data-testid="tweet"]')) {
      const t = SIT.x.parseArticle(article);
      if (!t) continue;
      const known = memory.get(t.id);
      if (known && known.kind) {
        if (known.mine && t.views != null) updates.push({ id: 'x:' + t.id, platform: 'x', impressions: t.views });
      } else if (!known && SIT.eqi(t.handle, me.handle)) {
        const kind = t.replyContext ? 'comment' : 'post';
        memory.set(t.id, { mine: true, kind });
        updates.push({
          id: 'x:' + t.id,
          platform: 'x',
          ref: t.id,
          kind,
          direction: 'mine',
          author: '@' + t.handle,
          url: 'https://x.com/' + t.handle + '/status/' + t.id,
          createdAt: t.createdAt,
          tsPrecise: true,
          impressions: t.views,
          source: 'dom',
          confidence: 0,
        });
      }
    }
    if (updates.length) saver.push(updates);
  }

  let domTimer = null;
  function scheduleDomScan() {
    if (domTimer) return;
    domTimer = setTimeout(() => {
      domTimer = null;
      scanDom();
    }, 2500);
  }

  // ---------- guided scan ----------

  // ---------- fast scans: page through X's own timeline requests ----------

  let pagerSeq = 0;
  let pagerPaused = false;
  const PAGER_IDLE_MS = 90 * 1000;

  function paginate(names, cutoffTs, onProgress) {
    const id = 'p' + (++pagerSeq) + '-' + Date.now();
    return new Promise((resolve) => {
      let lastSign = Date.now();
      let pages = 0;
      pagerWaiters.set(id, {
        resolve,
        onProgress: (p) => {
          lastSign = Date.now();
          pages = p.page || pages;
          if (onProgress) onProgress(p);
        },
      });
      window.postMessage({ __sit: 'cmd', op: 'paginate', id, names, cutoff: cutoffTs, maxPages: 80, delayMs: 350 }, location.origin);
      // Safety net: never wait forever on the page. Time spent paused doesn't count.
      const watch = setInterval(() => {
        if (!pagerWaiters.has(id)) return clearInterval(watch);
        if (pagerPaused) { lastSign = Date.now(); return; }
        if (Date.now() - lastSign < PAGER_IDLE_MS) return;
        clearInterval(watch);
        pagerWaiters.delete(id);
        window.postMessage({ __sit: 'cmd', op: 'stop' }, location.origin);
        resolve({ done: true, ok: pages > 0, pages, reason: 'timeout' });
      }, 2000);
    });
  }

  function timelineStep(label, url, ops) {
    return {
      label,
      url,
      ops,
      async run({ cutoffTs, update, tick }) {
        if (!ops.some((op) => seenOps.has(op))) return false; // page hasn't loaded this timeline: scroll instead
        const result = await paginate(ops, cutoffTs, (p) => {
          tick({ count: session.count() });
          if (p.newest) update('Reading page ' + p.page + ' · back to ' + SIT.formatDate(p.newest));
        });
        await SIT.sleep(400); // let the last page's records arrive
        // Fall back to scrolling only when paging couldn't start at all.
        return result.ok || result.reason === 'end' || result.reason === 'cutoff' || result.reason === 'stopped';
      },
    };
  }

  // Switch X tabs inside the app instead of reloading the whole page.
  async function softNavigate(url) {
    const path = new URL(url).pathname;
    const norm = (p) => p.replace(/\/+$/, '').toLowerCase();
    try {
      history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
    } catch (_) {
      return false;
    }
    const ok = await SIT.waitFor(() => norm(location.pathname) === norm(path) && document.querySelector('[data-testid="primaryColumn"]'), 4000, 200);
    return !!ok;
  }

  // Ready when the page has made its first request for the step's timeline.
  function ready(step) {
    if (!step.ops) return SIT.sleep(1200);
    return SIT.waitFor(() => step.ops.some((op) => seenOps.has(op)), 8000, 150);
  }

  const adapter = {
    platform: 'x',
    label: 'X',
    session,
    saver,
    waitForMe,
    parseNow: scanDom,
    softNavigate,
    ready,
    onStop: () => window.postMessage({ __sit: 'cmd', op: 'stop' }, location.origin),
    onPause: () => { pagerPaused = true; window.postMessage({ __sit: 'cmd', op: 'pause' }, location.origin); },
    onResume: () => { pagerPaused = false; window.postMessage({ __sit: 'cmd', op: 'resume' }, location.origin); },
    steps: {
      // X splits your profile: the Posts tab (UserOriginalsTimeline) has only originals,
      // the Replies tab (UserRepliesTimeline) only replies.
      'x:posts': timelineStep('your posts', (m) => 'https://x.com/' + encodeURIComponent(m.handle),
        ['UserOriginalsTimeline', 'UserTweets']),
      'x:replies': timelineStep('your comments & replies', (m) => 'https://x.com/' + encodeURIComponent(m.handle) + '/with_replies',
        ['UserRepliesTimeline', 'UserTweetsAndReplies']),
      'x:mentions': timelineStep('comments & replies you received', () => 'https://x.com/notifications/mentions',
        ['NotificationsTimeline', 'notifications/mentions']),
    },
  };

  initIdentity().then(() => {
    SIT.onReady(() => {
      SIT.startTab(adapter).then((mode) => {
        if (mode === 'off') return;
        new MutationObserver(scheduleDomScan).observe(document.body, { childList: true, subtree: true });
      });
    });
  });

  window.addEventListener('pagehide', () => { saver.flush(); });
})();
