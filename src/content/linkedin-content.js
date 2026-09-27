// LinkedIn content script: reads posts/comments/replies from the page as you
// browse, checks each comment with LinkedIn's own comment API (fresh impression
// count + whether it is a reply), and runs guided scans.
(function () {
  'use strict';
  const SIT = globalThis.SIT;
  if (!SIT || SIT.__liContentLoaded) return;
  SIT.__liContentLoaded = true;

  const session = SIT.createSession();
  const saver = SIT.createSaver(session);
  const hints = new Map(); // record id -> impressions
  const minePostIds = new Set();
  const mineCommentIds = new Set();
  const mineThreads = new Set(); // top-level comment ids of threads you replied in
  let me = null;

  // ---------- impression hints from LinkedIn's JSON ----------

  function addHints(json) {
    if (saver.mode() === 'off') return; // nothing is collected outside a scan
    const found = SIT.li.extractImpressionHints(json);
    if (!found.length) return;
    const updates = [];
    for (const h of found) {
      hints.set(h.id, h.impressions);
      updates.push({ id: h.id, platform: 'linkedin', impressions: h.impressions });
    }
    // Partial updates: the background only applies them to items it already has.
    saver.push(updates);
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__sit !== 'net') return;
    if (typeof event.data.body !== 'string') return;
    try { addHints(JSON.parse(event.data.body)); } catch (_) { /* not JSON */ }
  });

  function readEmbeddedData() {
    for (const code of document.querySelectorAll('code[id^="bpr-guid-"], code[id^="datalet-bpr-guid-"]')) {
      const text = code.textContent || '';
      if (!/impression|impresion|impressõ|Impressionen|vertoning|gösterim/i.test(text)) continue;
      try { addHints(JSON.parse(text)); } catch (_) { /* ignore */ }
    }
  }

  // ---------- identity ----------

  function csrfToken() {
    const m = document.cookie.match(/(?:^|;\s*)JSESSIONID="?([^";]+)"?/);
    return m ? m[1] : null;
  }

  function voyagerHeaders(token) {
    return {
      'csrf-token': token,
      'x-restli-protocol-version': '2.0.0',
      accept: 'application/vnd.linkedin.normalized+json+2.1',
    };
  }

  async function fetchMe() {
    const token = csrfToken();
    if (!token) return null;
    try {
      const res = await fetch('/voyager/api/me', { credentials: 'include', headers: voyagerHeaders(token) });
      if (!res.ok) return null;
      return SIT.li.extractMe(await res.json());
    } catch (_) {
      return null;
    }
  }

  function domMe() {
    const photo = document.querySelector('.global-nav__me-photo, img.global-nav__me-photo');
    const name = photo && (photo.getAttribute('alt') || '').trim();
    const link = document.querySelector('.feed-identity-module a[href*="/in/"], a.profile-card-profile-link[href*="/in/"]');
    const slug = link ? SIT.li.profileKey(link.getAttribute('href')) : null;
    return name || slug ? { name: name || null, slug } : null;
  }

  function slugFromSetting(raw) {
    raw = String(raw || '').trim();
    const m = raw.match(/linkedin\.com\/in\/([^/?#]+)/i);
    if (m) return decodeURIComponent(m[1]);
    return raw && !/[/\s]/.test(raw) ? raw : null;
  }

  const DAY = 24 * 3600e3;
  const known = new Map(); // comment ref -> what storage already knows (kind, threadRef, replies, apiAt, createdAt)
  let visits = {};

  async function initIdentity() {
    const { settings = {}, identity = {}, records = {} } = await chrome.storage.local.get(['settings', 'identity', 'records']);
    const override = slugFromSetting(settings.linkedinProfile);
    const cached = identity.linkedin || null;

    for (const key in records) {
      const r = records[key];
      if (r.platform !== 'linkedin' || !r.ref) continue;
      if (/^li:comment:/.test(r.id)) {
        known.set(r.ref, { kind: r.kind, threadRef: r.threadRef, replies: r.replies, apiAt: r.apiAt, createdAt: r.createdAt, direction: r.direction, urn: r.urn });
      }
      if (r.direction !== 'mine') continue;
      if (r.kind === 'post') minePostIds.add(r.ref);
      else mineCommentIds.add(r.ref);
      if (r.kind === 'reply' && r.threadRef) mineThreads.add(r.threadRef);
    }
    visits = (await SIT.send({ type: 'visits:get' })) || {};

    const fresh = await fetchMe();
    let next = fresh || cached || null;
    if (!next || (!next.slug && !next.name)) {
      next = await SIT.waitFor(domMe, 15000, 600);
    }
    if (override) next = Object.assign({}, next, { slug: override });
    if (!next) return;

    me = next;
    if (fresh) SIT.send({ type: 'identity:set', platform: 'linkedin', identity: fresh });
  }

  // Your follower count, once per page load, from LinkedIn's network-info endpoint.
  let followersSent = false;
  async function reportFollowers() {
    if (followersSent || !me || !(me.profileId || me.slug) || saver.mode() !== 'scan') return;
    followersSent = true;
    const token = csrfToken();
    if (!token) return;
    try {
      const who = encodeURIComponent(me.profileId || me.slug);
      const res = await fetch('/voyager/api/identity/profiles/' + who + '/networkinfo', { credentials: 'include', headers: voyagerHeaders(token) });
      if (!res.ok) return;
      const json = await res.json();
      const n = json && (typeof json.followersCount === 'number' ? json.followersCount : json.data && typeof json.data.followersCount === 'number' ? json.data.followersCount : null);
      if (n != null) SIT.send({ type: 'followers:set', platform: 'linkedin', count: n });
    } catch (_) { /* not important enough to retry */ }
  }

  function waitForMe(timeoutMs) {
    return SIT.waitFor(() => (me && me.slug ? me : null), timeoutMs, 500);
  }

  function markVisited(patch) {
    Object.assign(visits, patch);
    return SIT.send({ type: 'visits:set', visits: patch });
  }

  // ---------- comment API lookups ----------

  const checked = new Set(); // comment refs already handled on this page
  const queue = [];
  const waitingOthers = new Map(); // thread id -> others' replies seen before we knew you were in that thread
  const threadsToVisit = new Map(); // thread id -> { threadId, postType, postId, sig, createdAt }
  const PRIORITY = { mine: 0, received: 1, other: 2 };
  const RECHECK_MS = 6 * 3600e3;
  const FRESH_MS = 14 * DAY; // top-level comments this recent can still gain replies
  const CONCURRENCY = 4;
  let active = 0;

  function involved(threadId) {
    return mineCommentIds.has(threadId) || mineThreads.has(threadId);
  }

  // Whether something is a reply never changes, so a comment checked before only needs
  // another look while it is recent enough to be gaining replies.
  function needsLookup(r) {
    const k = known.get(r.ref);
    if (!k || !k.apiAt) return true;
    if (Date.now() - k.apiAt < RECHECK_MS) return false;
    return k.kind === 'comment' && (r.createdAt || 0) > Date.now() - FRESH_MS;
  }

  function noteThread(r, kind, threadId, replies) {
    if (r.direction !== 'mine') return;
    const ids = SIT.li.parseCommentUrn(r.urn);
    if (!ids || !ids.postId) return;
    if (kind === 'reply' && threadId) {
      threadsToVisit.set(threadId, { threadId, postType: ids.postType, postId: ids.postId, sig: 'r', createdAt: r.createdAt });
    } else if (kind === 'comment' && replies > 0) {
      threadsToVisit.set(r.ref, { threadId: r.ref, postType: ids.postType, postId: ids.postId, sig: replies, createdAt: r.createdAt });
    }
  }

  function queueLookups(records) {
    for (const r of records) {
      if (!r.urn || !/^li:comment:/.test(r.id) || checked.has(r.ref)) continue;
      checked.add(r.ref);
      if (needsLookup(r)) {
        queue.push(r);
      } else {
        const k = known.get(r.ref);
        noteThread(r, k.kind, k.threadRef, k.replies);
      }
    }
    // Your own items first, so thread ownership is known before others' replies are checked.
    queue.sort((a, b) => PRIORITY[a.direction] - PRIORITY[b.direction]);
    pump();
  }

  const halted = () => !!(adapter.control && adapter.control.shouldStop());
  const holding = () => !!(adapter.control && adapter.control.isPaused());

  function pump() {
    if (halted()) { queue.length = 0; return; }
    if (holding()) { setTimeout(pump, 400); return; } // a paused scan makes no requests
    while (active < CONCURRENCY && queue.length) {
      const r = queue.shift();
      active++;
      lookupComment(r.urn, r.ref)
        .then((info) => { if (info) applyCommentInfo(r, info); })
        .catch(() => {})
        .then(() => {
          active--;
          setTimeout(pump, 120);
        });
    }
  }

  const busy = () => !halted() && (active > 0 || queue.length > 0);

  function saveOthersReply(r, threadId) {
    saver.push([Object.assign({}, r, { direction: 'received', kind: 'reply', threadRef: threadId, confidence: 2, source: 'api', apiAt: Date.now() })]);
  }

  function applyCommentInfo(r, info) {
    const threadId = info.isReply ? info.parentId : r.ref;

    if (r.direction === 'other') {
      // Someone else's comment on someone else's post: keep it only when it is a
      // reply in a thread you started or joined.
      if (!info.isReply) return;
      if (involved(threadId)) saveOthersReply(r, threadId);
      else (waitingOthers.get(threadId) || waitingOthers.set(threadId, []).get(threadId)).push(r);
      return;
    }

    const kind = info.isReply ? 'reply' : 'comment';
    const update = Object.assign({}, r, { kind, threadRef: threadId, confidence: 2, source: 'api', apiAt: Date.now() });
    if (!info.isReply && info.replyCount != null) update.replies = info.replyCount;
    if (r.direction === 'mine' && info.impressions != null) update.impressions = info.impressions;
    saver.push([update]);
    known.set(r.ref, { kind, threadRef: threadId, replies: update.replies, apiAt: update.apiAt, createdAt: r.createdAt, direction: r.direction, urn: r.urn });
    if (r.direction !== 'mine') return;

    if (info.isReply) mineThreads.add(threadId);
    noteThread(r, kind, threadId, update.replies);
    const waiting = waitingOthers.get(threadId);
    if (waiting) {
      waitingOthers.delete(threadId);
      for (const o of waiting) saveOthersReply(o, threadId);
    }
  }

  async function lookupComment(urn, commentId) {
    const ids = SIT.li.parseCommentUrn(urn);
    const token = csrfToken();
    if (!ids || !ids.postId || !token) return null;
    const dashUrn = 'urn:li:fsd_comment:(' + ids.commentId + ',urn:li:' + ids.postType + ':' + ids.postId + ')';
    try {
      const res = await fetch('/voyager/api/voyagerSocialDashComments/' + encodeURIComponent(dashUrn), {
        credentials: 'include',
        headers: voyagerHeaders(token),
      });
      if (!res.ok) return null;
      return SIT.li.readCommentInfo(await res.json(), commentId);
    } catch (_) {
      return null;
    }
  }

  // ---------- DOM parsing ----------

  const parseCache = new WeakMap(); // unchanged cards and comments aren't re-read

  function parseNow() {
    if (!me || saver.mode() === 'off') return;
    const scanning = saver.mode() === 'scan';
    const records = SIT.li.parseDocument(document, me, Date.now(), { minePostIds, path: location.pathname, keepOthers: true, cache: parseCache });
    const own = [];
    const others = [];
    for (const r of records) {
      if (r.direction === 'other') {
        others.push(r);
        continue;
      }
      if (r.impressions == null && hints.has(r.id)) r.impressions = hints.get(r.id);
      if (r.direction === 'mine') (r.kind === 'post' ? minePostIds : mineCommentIds).add(r.ref);
      own.push(r);
    }
    saver.push(own);
    // LinkedIn's comment API is only asked during a scan, never while you just browse.
    if (!scanning) return;
    queueLookups(own);
    // Others' comments on someone else's post only matter when you're in the conversation.
    if (others.length && own.some((r) => r.kind !== 'post')) queueLookups(others);
  }

  let parseTimer = null;
  function scheduleParse() {
    if (parseTimer) return;
    parseTimer = setTimeout(() => {
      parseTimer = null;
      parseNow();
    }, 2500);
  }

  // ---------- guided scan ----------

  const commentCount = () => document.querySelectorAll(SIT.li.COMMENT2_SEL + ', ' + SIT.li.COMMENT_SEL).length;

  // "See previous replies" / "Load more comments" are short text elements (a <p> in the
  // 2026 layout). Only small leaf elements are checked, which keeps this cheap on long pages.
  function expandControls() {
    const pattern = SIT.li.MORE_CONTROL;
    const out = [];
    for (const e of document.querySelectorAll('button, a, [role="button"], p, span')) {
      if (e.childElementCount > 2) continue;
      const raw = e.textContent;
      if (!raw || raw.length > 40) continue;
      if (!pattern.test(raw.replace(/\s+/g, ' ').trim())) continue;
      if (e.parentElement && out.includes(e.parentElement)) continue;
      out.push(e);
    }
    // Keep the innermost element of nested matches.
    return out.filter((e) => !out.some((o) => o !== e && e.contains(o)));
  }

  async function expandThreads({ shouldStop }) {
    for (let n = 0; n < 8 && !shouldStop(); n++) {
      if (adapter.control) await adapter.control.whilePaused();
      const controls = expandControls();
      if (!controls.length) break;
      const before = commentCount();
      for (const c of controls) c.click();
      await SIT.waitFor(() => commentCount() > before, 3000, 150);
    }
    parseNow();
  }

  // After scrolling your posts, queue a visit to each recent post whose comment count
  // changed since the last scan.
  async function queueCommentedPosts({ task, update }) {
    if (!task.expandComments) return;
    parseNow();
    const posts = [];
    let unchanged = 0;
    for (const card of document.querySelectorAll(SIT.li.CARD2_SEL)) {
      const info = SIT.li.parseCardV2(card, me, Date.now());
      const r = info && info.record;
      if (!r || !(r.replies > 0) || (r.createdAt || 0) < task.cutoffTs) continue;
      if (visits['li:post:' + info.ids.id] === r.replies) { unchanged++; continue; }
      posts.push('li:post|' + info.ids.type + ':' + info.ids.id);
    }
    if (!posts.length) return;
    update('Opening ' + posts.length + ' posts with new comments' + (unchanged ? ' (' + unchanged + ' unchanged, skipped)' : ''));
    await SIT.send({ type: 'scan:insert', steps: posts.slice(0, 40) });
  }

  async function visitPost(ctx) {
    await expandThreads(ctx);
    const [, postId] = String(ctx.arg).split(':');
    const card = document.querySelector(SIT.li.CARD2_SEL);
    const info = card && SIT.li.parseCardV2(card, me, Date.now());
    if (info && info.record && info.ids.id === postId && info.record.replies != null) {
      await markVisited({ ['li:post:' + postId]: info.record.replies });
    }
  }

  // After your comments page, open threads where replies changed since the last scan:
  // your comments whose reply count moved, and threads you replied in during the last week.
  async function queueThreadVisits({ task, update }) {
    if (!task.expandComments) return;
    await settle();
    const steps = [];
    let unchanged = 0;
    for (const t of threadsToVisit.values()) {
      if ((t.createdAt || 0) < task.cutoffTs) continue;
      if (typeof t.sig === 'number') {
        if (visits['li:thread:' + t.threadId] === t.sig) { unchanged++; continue; }
      } else if ((t.createdAt || 0) < Date.now() - 7 * DAY || Date.now() - (visits['li:rthread:' + t.threadId] || 0) < DAY) {
        unchanged++;
        continue;
      }
      steps.push('li:thread|' + [t.postType, t.postId, t.threadId, t.sig].join(':'));
    }
    if (!steps.length) return;
    update('Opening ' + steps.length + ' threads with new replies' + (unchanged ? ' (' + unchanged + ' unchanged, skipped)' : ''));
    await SIT.send({ type: 'scan:insert', steps: steps.slice(0, 40) });
  }

  async function visitThread(ctx) {
    await expandThreads(ctx);
    const [, , threadId, sig] = String(ctx.arg).split(':');
    if (!threadId) return;
    await markVisited(sig === 'r' ? { ['li:rthread:' + threadId]: Date.now() } : { ['li:thread:' + threadId]: Number(sig) });
  }

  function settle() {
    parseNow();
    return SIT.waitFor(() => !busy(), 120000, 250);
  }

  // Wait for the page's content instead of sleeping a fixed time.
  function ready(step) {
    const selector = step.comments ? SIT.li.COMMENT2_SEL + ', ' + SIT.li.COMMENT_SEL : SIT.li.CARD2_SEL + ', ' + SIT.li.POST_SEL;
    return SIT.waitFor(() => document.querySelector(selector), 8000, 150);
  }

  const adapter = {
    platform: 'linkedin',
    label: 'LinkedIn',
    session,
    saver,
    waitForMe,
    parseNow,
    settle,
    ready,
    beforeScroll: async () => { parseNow(); },
    steps: {
      'li:posts': {
        label: 'your posts',
        url: (m) => 'https://www.linkedin.com/in/' + encodeURIComponent(m.slug) + '/recent-activity/all/',
        after: queueCommentedPosts,
      },
      'li:post': {
        label: 'new comments on one of your posts',
        url: (m, arg) => 'https://www.linkedin.com/feed/update/urn:li:' + String(arg).split(':').slice(0, 2).join(':') + '/',
        rounds: 0,
        comments: true,
        after: visitPost,
      },
      'li:comments': {
        label: 'your comments & replies',
        url: (m) => 'https://www.linkedin.com/in/' + encodeURIComponent(m.slug) + '/recent-activity/comments/',
        after: queueThreadVisits,
      },
      // arg = "activity:POST_ID:THREAD_ID:SIG"; opening with commentUrn loads that thread.
      'li:thread': {
        label: 'new replies in one of your comment threads',
        url: (m, arg) => {
          const [type, postId, threadId] = String(arg).split(':');
          const commentUrn = 'urn:li:comment:(' + type + ':' + postId + ',' + threadId + ')';
          return 'https://www.linkedin.com/feed/update/urn:li:' + type + ':' + postId + '/?commentUrn=' + encodeURIComponent(commentUrn);
        },
        rounds: 0,
        comments: true,
        after: visitThread,
      },
    },
  };

  SIT.onReady(async () => {
    await initIdentity();
    if ((await SIT.startTab(adapter)) === 'off') return;
    reportFollowers();
    readEmbeddedData();
    parseNow();
    new MutationObserver(scheduleParse).observe(document.body, { childList: true, subtree: true });
  });

  window.addEventListener('pagehide', () => { saver.flush(); });
})();
