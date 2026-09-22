// Aggregates stored records into totals for a platform + time range, scores each
// item's impressions against your usual level, and finds conversations waiting on you.
// Ranges are "by publish date": an item counts toward a range when it was
// created inside it, with its latest known lifetime impression count.
(function (root) {
  'use strict';
  const SIT = root.SIT || (root.SIT = {});

  const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
    'August', 'September', 'October', 'November', 'December'];
  const KINDS = ['post', 'comment', 'reply'];

  function startOfDay(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  }

  function addDays(ts, n) {
    const d = new Date(ts);
    d.setDate(d.getDate() + n);
    return d.getTime();
  }

  // range: { type: 'days', days: 7 } -> today plus the previous 6 calendar days
  //        { type: 'month', year: 2026, month: 8 } -> that calendar month (month is 0-based)
  function rangeBounds(range, now) {
    if (range && range.type === 'month') {
      const start = new Date(range.year, range.month, 1).getTime();
      const end = new Date(range.year, range.month + 1, 1).getTime();
      return { start, end };
    }
    const days = Math.max(1, (range && range.days) || 7);
    const today = startOfDay(now);
    return { start: addDays(today, -(days - 1)), end: addDays(today, 1) };
  }

  function toList(records) {
    if (!records) return [];
    return Array.isArray(records) ? records : Object.values(records);
  }

  function byImpressions(a, b) {
    return (b.impressions == null ? -1 : b.impressions) - (a.impressions == null ? -1 : a.impressions);
  }

  function inRange(ts, bounds) {
    return typeof ts === 'number' && ts >= bounds.start && ts < bounds.end;
  }

  // ---------- impression levels ----------

  const LEVELS = [
    null,
    { level: 1, key: 'very-low', label: 'Very low' },
    { level: 2, key: 'low', label: 'Low' },
    { level: 3, key: 'medium', label: 'Medium' },
    { level: 4, key: 'high', label: 'High' },
    { level: 5, key: 'very-high', label: 'Very high' },
  ];
  const MIN_SAMPLES = 5;

  function median(values) {
    const s = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }

  // Your usual impressions per platform + type (median of everything stored), with a
  // cross-platform fallback per type when one platform has too few items.
  function baselines(records) {
    const groups = new Map();
    const add = (key, v) => (groups.get(key) || groups.set(key, []).get(key)).push(v);
    for (const r of toList(records)) {
      if (!r || r.direction !== 'mine' || typeof r.impressions !== 'number' || KINDS.indexOf(r.kind) === -1) continue;
      add(r.platform + ':' + r.kind, r.impressions);
      add('*:' + r.kind, r.impressions);
    }
    const out = new Map();
    for (const [key, values] of groups) {
      if (values.length >= MIN_SAMPLES) out.set(key, median(values));
    }
    return out;
  }

  // Very high ≥ 2× your usual · High ≥ 1.25× · Medium ≥ 0.75× · Low ≥ 0.4× · Very low below that.
  function levelFor(value, platform, kind, base) {
    if (typeof value !== 'number' || !base) return null;
    let usual = base.get(platform + ':' + kind);
    if (usual == null) usual = base.get('*:' + kind);
    if (usual == null) return null;
    if (usual <= 0) return LEVELS[value > 0 ? 5 : 3];
    const ratio = value / usual;
    const n = ratio >= 2 ? 5 : ratio >= 1.25 ? 4 : ratio >= 0.75 ? 3 : ratio >= 0.4 ? 2 : 1;
    return Object.assign({ usual }, LEVELS[n]);
  }

  function levelOf(record, base) {
    return record ? levelFor(record.impressions, record.platform, record.kind, base) : null;
  }

  // ---------- conversations ----------

  const keyOf = (platform, ref) => platform + ':' + ref;

  // Builds, for every comment/reply of yours, the responses other people left on it and
  // which of those you haven't answered yet.
  //   X: replies form a tree, so a response is a direct reply to your item.
  //   LinkedIn: a thread is one top-level comment plus a flat list of replies, so a
  //   response belongs to the latest message of yours that came before it.
  function conversations(records) {
    const all = toList(records).filter((r) => r && r.ref && (r.kind === 'comment' || r.kind === 'reply'));
    const byKey = new Map(all.map((r) => [keyOf(r.platform, r.ref), r]));
    const convo = new Map(); // key of my item -> { item, responses: [], pending: [], threadSize }

    const entryFor = (item) => {
      const key = keyOf(item.platform, item.ref);
      if (!convo.has(key)) convo.set(key, { item, responses: [], pending: [], threadSize: 1 });
      return convo.get(key);
    };

    // X: tree
    const children = new Map();
    for (const r of all) {
      if (r.platform === 'linkedin' || !r.parentRef) continue;
      const k = keyOf(r.platform, r.parentRef);
      (children.get(k) || children.set(k, []).get(k)).push(r);
    }
    const subtreeSize = (key, depth) => {
      if (depth > 50) return 0;
      let n = 0;
      for (const c of children.get(key) || []) n += 1 + subtreeSize(keyOf(c.platform, c.ref), depth + 1);
      return n;
    };
    for (const [parentKey, kids] of children) {
      const responses = kids.filter((c) => c.direction !== 'mine');
      if (!responses.length) continue;
      let parent = byKey.get(parentKey);
      if (parent && parent.direction !== 'mine') continue;
      if (!parent) {
        // Someone answered an item of yours that hasn't been scanned yet.
        if (responses.every((c) => c.kind !== 'reply')) continue; // those are comments on your post
        const sample = responses[0];
        parent = {
          id: parentKey, platform: sample.platform, ref: sample.parentRef, kind: 'comment', direction: 'mine',
          placeholder: true, url: sample.platform === 'x' ? 'https://x.com/i/web/status/' + sample.parentRef : null,
          createdAt: SIT.xIdToMs ? SIT.xIdToMs(sample.parentRef) : null, impressions: null,
        };
      }
      const e = entryFor(parent);
      e.threadSize = 1 + subtreeSize(parentKey, 0);
      for (const o of responses) {
        e.responses.push(o);
        const answered = (children.get(keyOf(o.platform, o.ref)) || []).some((c) => c.direction === 'mine');
        if (!answered) e.pending.push(o);
      }
    }

    // LinkedIn: flat threads
    const threads = new Map();
    for (const r of all) {
      if (r.platform !== 'linkedin') continue;
      const t = keyOf(r.platform, r.kind === 'reply' ? r.threadRef || r.parentCommentRef : r.ref);
      if (r.kind === 'reply' && !(r.threadRef || r.parentCommentRef)) continue;
      (threads.get(t) || threads.set(t, []).get(t)).push(r);
    }
    for (const messages of threads.values()) {
      messages.sort((a, b) => (a.kind === 'comment' ? -1 : 0) - (b.kind === 'comment' ? -1 : 0) || (a.createdAt || 0) - (b.createdAt || 0));
      for (let i = 0; i < messages.length; i++) {
        const o = messages[i];
        if (o.direction === 'mine') continue;
        let owner = null;
        for (let j = i - 1; j >= 0; j--) if (messages[j].direction === 'mine') { owner = messages[j]; break; }
        if (!owner) continue;
        const e = entryFor(owner);
        e.threadSize = messages.length;
        e.responses.push(o);
        if (!messages.slice(i + 1).some((m) => m.direction === 'mine')) e.pending.push(o);
      }
    }

    for (const e of convo.values()) {
      e.responses.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      e.pending.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    }
    return convo;
  }

  // ---------- summary ----------

  function summarize(records, opts, now) {
    now = now || Date.now();
    const platform = (opts && opts.platform) || 'all';
    const bounds = rangeBounds(opts && opts.range, now);
    const { start, end } = bounds;
    const list = toList(records);
    const base = baselines(list);
    const convo = conversations(list);

    const blank = () => ({ count: 0, withData: 0, impressions: 0 });
    const mine = { post: blank(), comment: blank(), reply: blank() };
    const platforms = {
      linkedin: { post: 0, comment: 0, reply: 0 },
      x: { post: 0, comment: 0, reply: 0 },
    };

    const daily = [];
    const dayIndex = new Map();
    // startOfDay again after each step: where a day has no midnight (a DST change) the
    // bucket starts at 01:00, and the following days must go back to 00:00.
    for (let t = start; t < end; t = startOfDay(addDays(t, 1))) {
      dayIndex.set(t, daily.length);
      daily.push({ start: t, post: 0, comment: 0, reply: 0 });
    }

    const items = { post: [], comment: [], reply: [] };
    let receivedComments = 0;

    for (const r of list) {
      if (!r || !inRange(r.createdAt, bounds)) continue;
      if (platform !== 'all' && r.platform !== platform) continue;

      if (r.direction === 'received') {
        if (r.kind === 'comment' && r.onMyPost !== false) receivedComments++;
        continue;
      }
      if (r.direction !== 'mine' || !mine[r.kind]) continue;

      const bucket = mine[r.kind];
      bucket.count++;
      const value = typeof r.impressions === 'number' ? r.impressions : null;
      if (value != null) {
        bucket.withData++;
        bucket.impressions += value;
      }
      if (platforms[r.platform]) platforms[r.platform][r.kind] += value || 0;
      const idx = dayIndex.get(startOfDay(r.createdAt));
      if (idx != null) daily[idx][r.kind] += value || 0;
      items[r.kind].push(r);
    }

    for (const kind of KINDS) items[kind].sort(byImpressions);

    // Conversations: "all" lists use your items published in range; "needs reply" lists
    // use responses that arrived in range and are still unanswered.
    const matches = (r) => platform === 'all' || r.platform === platform;
    const needs = { comment: [], reply: [] };
    let responsesInRange = 0;
    const engaged = { comment: 0, reply: 0 };
    const threads = { comment: 0, reply: 0 };
    for (const e of convo.values()) {
      if (!matches(e.item) || !needs[e.item.kind]) continue;
      const kind = e.item.kind;
      responsesInRange += e.responses.filter((o) => inRange(o.createdAt, bounds)).length;
      if (inRange(e.item.createdAt, bounds)) {
        engaged[kind]++;
        if (e.threadSize >= 3) threads[kind]++;
      }
      const pending = e.pending.filter((o) => inRange(o.createdAt, bounds));
      if (pending.length) needs[kind].push(Object.assign({}, e, { pending, latest: pending[0].createdAt }));
    }
    needs.comment.sort((a, b) => b.latest - a.latest);
    needs.reply.sort((a, b) => b.latest - a.latest);

    return {
      start,
      end,
      mine,
      posts: mine.post.impressions,
      comments: mine.comment.impressions,
      replies: mine.reply.impressions,
      received: { comment: receivedComments, reply: responsesInRange },
      platforms,
      daily,
      items: { post: items.post.slice(0, 50), comment: items.comment.slice(0, 50), reply: items.reply.slice(0, 50) },
      needs,
      engaged,
      threads,
      convo,
      base,
    };
  }

  // The last 12 months plus any older month that has data, newest first.
  function monthOptions(records, now) {
    now = now || Date.now();
    const seen = new Map();
    const d = new Date(now);
    for (let i = 0; i < 12; i++) {
      const m = new Date(d.getFullYear(), d.getMonth() - i, 1);
      seen.set(m.getFullYear() * 12 + m.getMonth(), true);
    }
    for (const r of toList(records)) {
      if (!r || typeof r.createdAt !== 'number') continue;
      const c = new Date(r.createdAt);
      seen.set(c.getFullYear() * 12 + c.getMonth(), true);
    }
    return Array.from(seen.keys())
      .sort((a, b) => b - a)
      .map((key) => {
        const year = Math.floor(key / 12);
        const month = key % 12;
        return { year, month, value: year + '-' + month, label: MONTHS[month] + ' ' + year, short: MONTHS[month].slice(0, 3) + ' ' + year };
      });
  }

  // Text from other people must never run as a spreadsheet formula.
  function csvCell(v) {
    if (v == null) return '';
    let s = String(v);
    if (typeof v === 'string' && /^[=+\-@\t\r]/.test(s)) s = "'" + s;
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function toCSV(records) {
    const list = toList(records);
    const base = baselines(list);
    const cols = ['platform', 'kind', 'direction', 'created_at', 'impressions', 'impression_level', 'likes', 'replies',
      'author', 'parent_author', 'on_my_post', 'url', 'text'];
    const rows = list
      .slice()
      .sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0))
      .map((r) => {
        const lvl = r.direction === 'mine' ? levelOf(r, base) : null;
        return [
          r.platform, r.kind, r.direction,
          r.createdAt ? new Date(r.createdAt).toISOString() : '',
          r.impressions, lvl ? lvl.label : '', r.likes, r.replies, r.authorName || r.author,
          r.parentAuthor || r.postAuthor, r.onMyPost == null ? '' : r.onMyPost ? 'yes' : 'no', r.url, r.text,
        ].map(csvCell).join(',');
      });
    return cols.join(',') + '\n' + rows.join('\n');
  }

  SIT.stats = {
    rangeBounds, summarize, monthOptions, toCSV, csvCell, startOfDay, addDays, MONTHS,
    baselines, levelFor, levelOf, conversations, LEVELS,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SIT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
