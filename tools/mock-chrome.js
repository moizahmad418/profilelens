// Fake chrome.* API with generated sample data, used only by tools/preview-server.js.
(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const empty = params.has('empty');
  const DAY = 86400000;
  const now = Date.now();

  let seed = 7;
  const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

  const texts = {
    post: ['Shipped our new onboarding flow today — here is what we learned', 'Three lessons from hiring our first 10 engineers',
      'Why we stopped doing weekly status meetings', 'A thread on pricing experiments that actually worked',
      'We just crossed 10,000 users. Thank you!', 'Hot take: most dashboards are never opened twice'],
    comment: ['Great breakdown, the second point is underrated', 'We saw the same thing when we switched to usage pricing',
      'Congrats on the launch!', 'This matches my experience at two startups', 'Saving this for the team'],
    myReply: ['Exactly — and it compounds over time', 'Happy to share the template if useful', 'Fair point, I should have been clearer'],
    theirReply: ['Would love the template!', 'How long did the migration take?', 'Disagree slightly — what about small teams?', 'Thanks, this helped a lot'],
  };
  const people = { x: ['@sara_builds', '@devnotes', '@kofi_ux'], linkedin: ['Priya Raman', 'Jonas Weber', 'Elena Park'] };
  const pick = (list) => list[Math.floor(rand() * list.length)];

  const records = {};
  if (!empty) {
    let n = 1000;
    const add = (r) => {
      r.ref = String(n++);
      r.id = r.platform + ':' + r.ref;
      r.url = r.platform === 'x' ? 'https://x.com/i/web/status/' + r.ref : 'https://www.linkedin.com/feed/';
      records[r.id] = r;
      return r;
    };
    const imp = (base) => Math.round(base * (0.25 + rand() * rand() * 3));

    for (let d = 0; d < 130; d++) {
      for (const platform of ['linkedin', 'x']) {
        const t0 = now - d * DAY - Math.floor(rand() * 12) * 3600e3;
        if (rand() < 0.25) {
          add({ platform, kind: 'post', direction: 'mine', createdAt: t0, impressions: imp(platform === 'linkedin' ? 1800 : 1100), text: pick(texts.post), replies: Math.floor(rand() * 6) });
          if (rand() < 0.7) add({ platform, kind: 'comment', direction: 'received', onMyPost: true, createdAt: t0 + 3600e3, text: pick(texts.theirReply), author: pick(people.x), authorName: pick(people.linkedin) });
        }
        if (rand() > 0.75) continue;
        // One of my comments, sometimes growing into a conversation.
        const onMyPost = rand() < 0.2;
        const c = add({
          platform, kind: 'comment', direction: 'mine', createdAt: t0, impressions: platform === 'linkedin' && rand() < 0.1 ? null : imp(160),
          text: pick(texts.comment), onMyPost, parentAuthor: platform === 'x' && !onMyPost ? pick(people.x) : null,
          postAuthor: platform === 'linkedin' && !onMyPost ? pick(people.linkedin) : null, parentRef: 'post' + d,
        });
        if (platform === 'linkedin') c.threadRef = c.ref;
        if (rand() > 0.45) continue;
        const who = platform === 'x' ? pick(people.x) : pick(people.linkedin);
        const r1 = add({ platform, kind: 'reply', direction: 'received', createdAt: t0 + 2 * 3600e3, text: pick(texts.theirReply), author: who, authorName: who, parentRef: c.ref, threadRef: c.ref, onMyPost });
        if (rand() > 0.55) continue;
        const r2 = add({ platform, kind: 'reply', direction: 'mine', createdAt: t0 + 5 * 3600e3, impressions: imp(55), text: pick(texts.myReply), parentAuthor: platform === 'x' ? who : null, postAuthor: c.postAuthor, parentRef: r1.ref, threadRef: c.ref, onMyPost });
        if (rand() > 0.5) continue;
        add({ platform, kind: 'reply', direction: 'received', createdAt: t0 + 9 * 3600e3, text: pick(texts.theirReply), author: who, authorName: who, parentRef: r2.ref, threadRef: c.ref, onMyPost });
      }
    }
  }

  const store = {
    local: {
      records,
      identity: empty ? {} : { x: { id: '1', handle: 'alex_builds' }, linkedin: { slug: 'alex-morgan', name: 'Alex Morgan' } },
      settings: { xHandle: '', linkedinProfile: '', expandComments: true },
      meta: { lastUpdated: { x: now - 4 * 60e3, linkedin: now - 9 * 60e3 } },
    },
    session: {},
  };
  const listeners = [];

  // Sample scan history: each snapshot holds the records as they were, with lower
  // impression counts the further back it was taken.
  if (!empty) {
    const history = [];
    const makeScan = (n, platform, status, mode, hoursAgo, seconds, factor, days) => {
      days = days || 30;
      const finishedAt = now - hoursAgo * 3600e3;
      const snap = {};
      const totals = { post: 0, comment: 0, reply: 0 };
      for (const id in records) {
        const r = records[id];
        if (r.createdAt > finishedAt) continue;
        const copy = Object.assign({}, r);
        if (typeof r.impressions === 'number') copy.impressions = Math.round(r.impressions * factor);
        snap[id] = copy;
        if (copy.direction === 'mine' && copy.platform === platform && copy.createdAt > finishedAt - days * DAY) totals[copy.kind] += copy.impressions || 0;
      }
      store.local['snap:scan-' + n] = { id: 'scan-' + n, takenAt: finishedAt, records: snap };
      history.unshift({
        id: 'scan-' + n, n, platform, status, mode, rangeLabel: days + 'D', range: { type: 'days', days }, pausedMs: 0,
        startedAt: finishedAt - seconds * 1000, finishedAt,
        windowStart: finishedAt - days * DAY, found: Math.round(Object.keys(snap).length / 2),
        itemCount: Object.keys(snap).length, totals, waiting: 3,
        message: status === 'failed' ? "Couldn't detect your X account." : '',
      });
    };
    makeScan(1, 'linkedin', 'done', 'full', 24 * 9, 512, 0.55);
    makeScan(2, 'x', 'failed', 'full', 24 * 6, 21, 0.7);
    makeScan(3, 'x', 'done', 'full', 24 * 6 - 1, 98, 0.7);
    makeScan(4, 'linkedin', 'stopped', 'range', 24 * 2, 44, 0.85, 7);
    makeScan(5, 'linkedin', 'done', 'range', 3, 71, 1, 10);
    store.local.scanHistory = history;
    store.local.scanCounter = 5;
  }

  function area(name) {
    return {
      get(keys) {
        const out = {};
        const list = keys == null ? Object.keys(store[name]) : [].concat(keys);
        for (const k of list) if (k in store[name]) out[k] = JSON.parse(JSON.stringify(store[name][k]));
        return Promise.resolve(out);
      },
      set(obj) {
        Object.assign(store[name], obj);
        const changes = {};
        for (const k in obj) changes[k] = { newValue: obj[k] };
        setTimeout(() => listeners.forEach((l) => l(changes, name)));
        return Promise.resolve();
      },
      remove(keys) {
        for (const k of [].concat(keys)) delete store[name][k];
        setTimeout(() => listeners.forEach((l) => l({}, name)));
        return Promise.resolve();
      },
    };
  }

  // ?scanning shows a running scan whose progress moves; add &paused for a paused one.
  if (params.has('scanning')) {
    store.session.scan = {
      platform: 'linkedin', status: params.has('paused') ? 'paused' : 'running', autoPaused: params.get('paused') === 'auto',
      index: 1, steps: ['li:posts', 'li:post|activity:1', 'li:post|activity:2', 'li:comments'], rangeLabel: '7D',
      range: { type: 'days', days: 7 }, progress: 0.31, found: 18, foundLive: 24, startedAt: now - 40e3,
    };
    setInterval(() => {
      const scan = store.session.scan;
      if (!scan || scan.status !== 'running') return;
      area('session').set({ scan: Object.assign({}, scan, { progress: Math.min(0.97, scan.progress + 0.02), foundLive: scan.foundLive + 1 }) });
    }, 1000);
  }

  window.chrome = {
    storage: { local: area('local'), session: area('session'), onChanged: { addListener: (fn) => listeners.push(fn) } },
    runtime: {
      sendMessage(msg) {
        if (msg.type === 'scan:status') return Promise.resolve(store.session.scan || null);
        if (msg.type === 'scan:pause' || msg.type === 'scan:resume') {
          const scan = store.session.scan;
          if (scan) area('session').set({ scan: Object.assign({}, scan, { status: msg.type === 'scan:pause' ? 'paused' : 'running', autoPaused: false }) });
          return Promise.resolve({ ok: true });
        }
        if (msg.type === 'scan:stop') return area('session').remove('scan').then(() => ({ ok: true }));
        if (msg.type === 'data:clear') return area('local').remove(['records', 'meta', 'identity']).then(() => ({ ok: true }));
        return Promise.resolve({ ok: true });
      },
    },
    tabs: { create: ({ url }) => window.open(url, '_blank') },
  };
})();
