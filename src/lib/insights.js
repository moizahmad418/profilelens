// Turns the stored records into advice: best times to post, which post types and lengths
// work, who keeps engaging, reply times, weekly goals, the weekly digest, why one post did
// well or badly, and a plain check of a comment before it is posted. Everything here is a
// pure function of the records, so it runs the same in the popup and in the tests.
(function (root) {
  'use strict';
  const SIT = root.SIT || (root.SIT = {});
  const DAY = 24 * 3600e3;
  const KINDS = ['post', 'comment', 'reply'];
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const TYPE_LABEL = { text: 'Text', image: 'Image', video: 'Video', document: 'Document', link: 'Link', poll: 'Poll', quote: 'Quote', carousel: 'Carousel' };

  const list = (records) => (Array.isArray(records) ? records : Object.values(records || {}));
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
  const avgOf = (items) => {
    const vals = items.map((r) => num(r.impressions)).filter((v) => v != null);
    return vals.length ? { avg: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length } : { avg: null, n: 0 };
  };
  const median = (values) => {
    const v = values.filter((x) => x != null).sort((a, b) => a - b);
    if (!v.length) return null;
    const mid = Math.floor(v.length / 2);
    return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
  };
  const fmt = (v) => (SIT.formatCompact ? SIT.formatCompact(v) : String(Math.round(v)));
  const pctText = (ratio) => Math.round(Math.abs(ratio - 1) * 100) + '%';

  // Your own items of one kind (or any) on one platform (or all), published in [start, end).
  function mine(records, opts) {
    const o = opts || {};
    return list(records).filter((r) => r && r.direction === 'mine' && typeof r.createdAt === 'number' &&
      (!o.kind || o.kind === 'all' || r.kind === o.kind) &&
      (!o.platform || o.platform === 'all' || r.platform === o.platform) &&
      (o.start == null || r.createdAt >= o.start) && (o.end == null || r.createdAt < o.end));
  }

  // ---------- previous period, for the deltas on the dashboard ----------

  function previousRange(range, now) {
    now = now || Date.now();
    if (range && range.type === 'month') {
      const d = new Date(range.year, range.month - 1, 1);
      return { range: { type: 'month', year: d.getFullYear(), month: d.getMonth() }, now };
    }
    const bounds = SIT.stats.rangeBounds(range, now);
    return { range, now: bounds.start - 1 };
  }

  // ratio of change (0.25 = up 25%), or null when there was nothing before.
  function change(cur, prev) {
    if (!prev) return cur ? null : 0;
    return (cur - prev) / prev;
  }

  function deltas(cur, prev) {
    const out = {};
    for (const k of KINDS) {
      out[k] = {
        impressions: change(cur.mine[k].impressions, prev.mine[k].impressions),
        count: change(cur.mine[k].count, prev.mine[k].count),
        prevImpressions: prev.mine[k].impressions,
        prevCount: prev.mine[k].count,
      };
    }
    out.received = { comment: change(cur.received.comment, prev.received.comment), reply: change(cur.received.reply, prev.received.reply) };
    return out;
  }

  // ---------- 1. best time to post ----------

  function bestTimes(records, opts) {
    const items = mine(records, Object.assign({ kind: 'post' }, opts)).filter((r) => num(r.impressions) != null);
    const cells = Array.from({ length: 7 * 24 }, () => ({ n: 0, sum: 0 }));
    const days = Array.from({ length: 7 }, () => ({ n: 0, sum: 0 }));
    const hours = Array.from({ length: 24 }, () => ({ n: 0, sum: 0 }));
    for (const r of items) {
      const d = new Date(r.createdAt);
      const c = cells[d.getDay() * 24 + d.getHours()];
      c.n++; c.sum += r.impressions;
      days[d.getDay()].n++; days[d.getDay()].sum += r.impressions;
      hours[d.getHours()].n++; hours[d.getHours()].sum += r.impressions;
    }
    const overall = items.length ? items.reduce((s, r) => s + r.impressions, 0) / items.length : null;
    const ranked = (arr, min) => arr.map((c, i) => ({ i, n: c.n, avg: c.n ? c.sum / c.n : null }))
      .filter((c) => c.n >= min && c.avg != null).sort((a, b) => b.avg - a.avg);
    // Two-hour blocks are steadier than single hours.
    const blocks = [];
    for (let h = 0; h < 24; h += 2) {
      const n = hours[h].n + hours[h + 1].n;
      const sum = hours[h].sum + hours[h + 1].sum;
      blocks.push({ hour: h, n, avg: n ? sum / n : null });
    }
    const bestBlock = blocks.filter((b) => b.n >= 2).sort((a, b) => b.avg - a.avg)[0] || null;
    const bestDays = ranked(days, 2).slice(0, 3).map((d) => ({ day: d.i, label: DAYS[d.i], n: d.n, avg: d.avg }));
    const best = ranked(cells, 2).slice(0, 3).map((c) => ({ day: Math.floor(c.i / 24), hour: c.i % 24, n: c.n, avg: c.avg }));
    let sentence = null;
    if (items.length >= 5 && bestBlock && bestDays.length) {
      sentence = 'Your best slot: ' + bestDays.slice(0, 2).map((d) => d.label).join(' and ') + ', ' + hourRange(bestBlock.hour) +
        ' (avg ' + fmt(bestBlock.avg) + ' over ' + bestBlock.n + ' posts' + (overall ? ', your usual is ' + fmt(overall) : '') + ').';
    } else if (items.length >= 5 && bestDays.length) {
      sentence = 'Your best day: ' + bestDays[0].label + ' (avg ' + fmt(bestDays[0].avg) + ' over ' + bestDays[0].n + ' posts).';
    }
    return { cells, days, hours, blocks, best, bestDays, bestBlock, overall, total: items.length, sentence, needed: Math.max(0, 5 - items.length) };
  }

  function hourLabel(h) {
    const x = h % 24;
    return (x % 12 || 12) + (x < 12 ? ' am' : ' pm');
  }
  function hourRange(h) { return hourLabel(h) + '–' + hourLabel(h + 2); }

  // ---------- 2. post types ----------

  function postTypes(records, opts) {
    const items = mine(records, Object.assign({ kind: 'post' }, opts));
    const groups = new Map();
    for (const r of items) {
      const t = r.postType || 'text';
      (groups.get(t) || groups.set(t, []).get(t)).push(r);
    }
    const rows = Array.from(groups, ([type, arr]) => Object.assign({ type, label: TYPE_LABEL[type] || type, count: arr.length }, avgOf(arr)))
      .sort((a, b) => (b.avg || 0) - (a.avg || 0));
    const rated = rows.filter((r) => r.n >= 2);
    let sentence = null;
    if (rated.length >= 2 && rated[0].avg && rated[rated.length - 1].avg) {
      const top = rated[0];
      const low = rated[rated.length - 1];
      const ratio = top.avg / low.avg;
      sentence = top.label + ' posts do best (avg ' + fmt(top.avg) + ')' +
        (ratio >= 1.15 ? ', ' + (ratio >= 2 ? Math.round(ratio * 10) / 10 + '× ' : pctText(ratio) + ' more than ') + low.label.toLowerCase() + ' posts' : '') + '.';
    } else if (rated.length === 1 && rows.length === 1) {
      sentence = 'All your posts so far are ' + rated[0].label.toLowerCase() + ' posts. Try another type to compare.';
    }
    return { rows, sentence, total: items.length };
  }

  // ---------- 3. length and hooks ----------

  const LENGTH_BUCKETS = [
    { key: 'short', label: 'Under 80 characters', min: 0, max: 80 },
    { key: 'medium', label: '80–160 characters', min: 80, max: 160 },
    { key: 'long', label: '160–280 characters', min: 160, max: 280 },
    { key: 'longer', label: '280 characters and more', min: 280, max: Infinity },
  ];
  const textLen = (r) => Array.from(String(r.text || '')).length;
  const firstLine = (text) => String(text || '').trim().split(/\n|(?<=[.!?])\s+/)[0] || '';
  const hasHashtag = (r) => /(^|\s)#[\p{L}\d_]+/u.test(String(r.text || ''));
  const asksQuestion = (r) => /\?/.test(firstLine(r.text));

  function lengthStats(records, opts) {
    const items = mine(records, Object.assign({ kind: 'post' }, opts)).filter((r) => r.text);
    const buckets = LENGTH_BUCKETS.map((b) => {
      const inside = items.filter((r) => textLen(r) >= b.min && textLen(r) < b.max);
      return Object.assign({ key: b.key, label: b.label, count: inside.length }, avgOf(inside));
    });
    const split = (test, yes, no) => ({
      yes: Object.assign({ label: yes }, avgOf(items.filter(test))),
      no: Object.assign({ label: no }, avgOf(items.filter((r) => !test(r)))),
    });
    const hashtags = split(hasHashtag, 'With hashtags', 'Without hashtags');
    const questions = split(asksQuestion, 'Opens with a question', 'Opens with a statement');
    const hookLen = split((r) => Array.from(firstLine(r.text)).length <= 60, 'Short first line (up to 60 characters)', 'Longer first line');
    const sentences = [];
    const rated = buckets.filter((b) => b.n >= 2).sort((a, b) => b.avg - a.avg);
    if (rated.length >= 2) sentences.push('Posts of ' + rated[0].label.toLowerCase() + ' do best (avg ' + fmt(rated[0].avg) + ').');
    for (const [s, what] of [[hashtags, 'hashtags'], [questions, 'a question first'], [hookLen, 'a short first line']]) {
      if (s.yes.n >= 2 && s.no.n >= 2 && s.yes.avg && s.no.avg) {
        const ratio = s.yes.avg / s.no.avg;
        if (ratio >= 1.2) sentences.push('Posts with ' + what + ' average ' + pctText(ratio) + ' more.');
        else if (ratio <= 1 / 1.2) sentences.push('Posts with ' + what + ' average ' + pctText(1 / ratio) + ' less.');
      }
    }
    return { buckets, hashtags, questions, hookLen, sentences, total: items.length };
  }

  // ---------- 9. top supporters ----------

  function supporters(records, opts) {
    const o = opts || {};
    const map = new Map();
    for (const r of list(records)) {
      if (!r || r.direction !== 'received' || typeof r.createdAt !== 'number') continue;
      if (o.platform && o.platform !== 'all' && r.platform !== o.platform) continue;
      if (o.start != null && r.createdAt < o.start) continue;
      if (o.end != null && r.createdAt >= o.end) continue;
      const who = r.authorName || r.author;
      if (!who) continue;
      const key = r.platform + ':' + String(r.author || r.authorName).toLowerCase();
      const e = map.get(key) || map.set(key, { platform: r.platform, name: who, handle: r.platform === 'x' ? r.author : null, count: 0, comments: 0, replies: 0, last: 0 }).get(key);
      e.count++;
      if (r.kind === 'comment') e.comments++; else e.replies++;
      e.last = Math.max(e.last, r.createdAt);
    }
    return Array.from(map.values()).sort((a, b) => b.count - a.count || b.last - a.last).slice(0, o.limit || 10);
  }

  // ---------- 6. engagement ROI: whose posts your comments earn reach on ----------

  function engagementRoi(records, opts) {
    const o = opts || {};
    const items = mine(records, Object.assign({}, o, { kind: 'all' })).filter((r) => r.kind !== 'post' && !r.onMyPost);
    const map = new Map();
    for (const r of items) {
      const who = r.platform === 'x' ? (r.parentAuthor || null) : (r.postAuthor || null);
      if (!who) continue;
      const key = r.platform + ':' + String(who).toLowerCase();
      const e = map.get(key) || map.set(key, { platform: r.platform, who, count: 0, sum: 0, n: 0 }).get(key);
      e.count++;
      if (num(r.impressions) != null) { e.sum += r.impressions; e.n++; }
    }
    const rows = Array.from(map.values()).map((e) => Object.assign(e, { avg: e.n ? e.sum / e.n : null }))
      .sort((a, b) => b.sum - a.sum).slice(0, o.limit || 10);
    const sentence = rows.length && rows[0].sum
      ? 'Commenting on ' + rows[0].who + '’s posts earned you ' + fmt(rows[0].sum) + ' impressions' + (rows.length > 1 ? ', the most of anyone' : '') + '.'
      : null;
    return { rows, sentence, total: items.length };
  }

  // ---------- 7. reply times ----------

  function replyTimes(records, opts) {
    const o = opts || {};
    const all = list(records).filter((r) => r && r.ref && (r.kind === 'comment' || r.kind === 'reply') && typeof r.createdAt === 'number' &&
      (!o.platform || o.platform === 'all' || r.platform === o.platform));
    const samples = [];
    const byKey = new Map(all.map((r) => [r.platform + ':' + r.ref, r]));
    // X: a reply of yours answers the exact message it points at.
    for (const r of all) {
      if (r.platform !== 'x' || r.direction !== 'mine' || !r.parentRef) continue;
      const parent = byKey.get('x:' + r.parentRef);
      if (parent && parent.direction === 'received' && r.createdAt > parent.createdAt) samples.push(r.createdAt - parent.createdAt);
    }
    // LinkedIn: in a thread, your next message answers what came before it.
    const threads = new Map();
    for (const r of all) {
      if (r.platform !== 'linkedin') continue;
      const t = r.kind === 'reply' ? (r.threadRef || r.parentCommentRef) : r.ref;
      if (!t) continue;
      (threads.get(t) || threads.set(t, []).get(t)).push(r);
    }
    for (const msgs of threads.values()) {
      msgs.sort((a, b) => a.createdAt - b.createdAt);
      for (let i = 0; i < msgs.length; i++) {
        if (msgs[i].direction !== 'received') continue;
        const next = msgs.slice(i + 1).find((m) => m.direction === 'mine');
        if (next) samples.push(next.createdAt - msgs[i].createdAt);
      }
    }
    return { median: median(samples), samples: samples.length };
  }

  // ---------- 5. weekly goals and streaks ----------

  function weekStart(ts) {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); // Monday
    return d.getTime();
  }
  const addDays = (ts, n) => { const d = new Date(ts); d.setDate(d.getDate() + n); return d.getTime(); };

  function weekCounts(records, start, end, platform) {
    const counts = { post: 0, comment: 0, reply: 0 };
    for (const r of mine(records, { kind: 'all', platform, start, end })) counts[r.kind]++;
    return counts;
  }

  // goals: { post, comment, reply } per week (0 = not set). The streak counts consecutive
  // weeks that met every goal set, ending with this week if it already has, else last week.
  function goalProgress(records, goals, now, platform) {
    now = now || Date.now();
    const g = { post: Number(goals && goals.post) || 0, comment: Number(goals && goals.comment) || 0, reply: Number(goals && goals.reply) || 0 };
    const set = KINDS.filter((k) => g[k] > 0);
    const start = weekStart(now);
    const week = weekCounts(records, start, addDays(start, 7), platform);
    const met = (c) => set.length > 0 && set.every((k) => c[k] >= g[k]);
    let streak = 0;
    let s = met(week) ? start : addDays(start, -7);
    for (let i = 0; i < 260; i++) {
      const c = s === start ? week : weekCounts(records, s, addDays(s, 7), platform);
      if (!met(c)) break;
      streak++;
      s = addDays(s, -7);
    }
    const remaining = {};
    for (const k of KINDS) remaining[k] = Math.max(0, g[k] - week[k]);
    return { goals: g, set, week, met: met(week), streak, remaining, weekStart: start, weekEnd: addDays(start, 7), daysLeft: Math.max(1, Math.ceil((addDays(start, 7) - now) / DAY)) };
  }

  // ---------- 8. followers ----------

  // history: [{ at, count }] for one platform. The sample at or before `ts`.
  function followersAt(history, ts) {
    let best = null;
    for (const h of history || []) if (h && typeof h.count === 'number' && h.at <= ts && (!best || h.at > best.at)) best = h;
    return best;
  }
  function followerDelta(history, start, end) {
    const from = followersAt(history, start) || (history || []).find((h) => h && h.at >= start && h.at < end) || null;
    const to = followersAt(history, end);
    if (!from || !to || to.at <= from.at) return { from: from ? from.count : null, to: to ? to.count : null, delta: null };
    return { from: from.count, to: to.count, delta: to.count - from.count };
  }

  // ---------- 11. weekly digest (the last complete week) ----------

  function digest(records, followers, now, platform) {
    now = now || Date.now();
    const end = weekStart(now);
    const start = addDays(end, -7);
    const prevStart = addDays(start, -7);
    const posts = mine(records, { kind: 'post', platform, start, end });
    const withData = posts.filter((r) => num(r.impressions) != null).sort((a, b) => b.impressions - a.impressions);
    const sum = (items) => items.reduce((s, r) => s + (num(r.impressions) || 0), 0);
    const totals = {};
    const prev = {};
    const change_ = {};
    for (const k of KINDS) {
      const cur = mine(records, { kind: k, platform, start, end });
      const before = mine(records, { kind: k, platform, start: prevStart, end: start });
      totals[k] = { count: cur.length, impressions: sum(cur) };
      prev[k] = { count: before.length, impressions: sum(before) };
      change_[k] = change(totals[k].impressions, prev[k].impressions);
    }
    const convo = SIT.stats.conversations(list(records));
    let waiting = 0;
    for (const e of convo.values()) if (!platform || platform === 'all' || e.item.platform === platform) waiting += e.pending.length;
    const fl = {};
    for (const p of ['linkedin', 'x']) {
      if (platform && platform !== 'all' && platform !== p) continue;
      fl[p] = followerDelta(followers && followers[p], start, end);
    }
    const received = list(records).filter((r) => r && r.direction === 'received' && r.createdAt >= start && r.createdAt < end &&
      (!platform || platform === 'all' || r.platform === platform)).length;
    const total = totals.post.impressions + totals.comment.impressions + totals.reply.impressions;
    const prevTotal = prev.post.impressions + prev.comment.impressions + prev.reply.impressions;
    return {
      start, end, key: 'w' + start,
      best: withData[0] || null, worst: withData.length > 1 ? withData[withData.length - 1] : null,
      totals, prev, change: change_, waiting, followers: fl, received, total, prevTotal, totalChange: change(total, prevTotal),
      empty: !posts.length && !totals.comment.count && !totals.reply.count,
    };
  }

  // ---------- 14. why did this post do well or badly (numbers only) ----------

  function explainPost(record, records) {
    if (!record || record.kind !== 'post') return null;
    const peers = mine(records, { kind: 'post', platform: record.platform }).filter((r) => r.id !== record.id && num(r.impressions) != null);
    const value = num(record.impressions);
    const usual = median(peers.map((r) => r.impressions));
    const out = { ratio: null, verdict: null, reasons: [], peers: peers.length };
    if (value == null || usual == null || peers.length < 3) {
      out.reasons.push(peers.length < 3 ? 'Not enough other posts to compare with yet (it needs 3).' : 'This post has no impression count yet.');
      return out;
    }
    out.ratio = usual ? value / usual : null;
    out.verdict = out.ratio >= 1.25 ? 'above' : out.ratio <= 0.75 ? 'below' : 'usual';
    out.reasons.push(out.verdict === 'usual'
      ? 'About your usual (' + fmt(usual) + ').'
      : (out.ratio >= 1 ? pctText(out.ratio) + ' above' : pctText(out.ratio) + ' below') + ' your usual of ' + fmt(usual) + '.');
    const factor = (label, test) => {
      const same = peers.filter(test);
      if (same.length < 3) return;
      const a = avgOf(same).avg;
      const rest = avgOf(peers.filter((r) => !test(r))).avg;
      if (a == null || rest == null || !rest) return;
      const ratio = a / rest;
      if (ratio >= 1.2 || ratio <= 1 / 1.2) {
        out.reasons.push(label + ': your posts like this average ' + (ratio >= 1 ? pctText(ratio) + ' more' : pctText(1 / ratio) + ' less') + ' than the others.');
      }
    };
    const d = new Date(record.createdAt);
    const block = Math.floor(d.getHours() / 2) * 2;
    factor('Posted ' + DAYS[d.getDay()] + ' ' + hourRange(block), (r) => Math.floor(new Date(r.createdAt).getHours() / 2) * 2 === block);
    factor('Posted on a ' + DAYS[d.getDay()], (r) => new Date(r.createdAt).getDay() === d.getDay());
    const type = record.postType || 'text';
    factor((TYPE_LABEL[type] || type) + ' post', (r) => (r.postType || 'text') === type);
    if (record.text) {
      const len = textLen(record);
      const b = LENGTH_BUCKETS.find((x) => len >= x.min && len < x.max);
      if (b) factor('Length ' + b.label.toLowerCase(), (r) => textLen(r) >= b.min && textLen(r) < b.max);
      factor(hasHashtag(record) ? 'Has hashtags' : 'No hashtags', (r) => hasHashtag(r) === hasHashtag(record));
      factor(asksQuestion(record) ? 'Opens with a question' : 'Opens with a statement', (r) => asksQuestion(r) === asksQuestion(record));
    }
    if (out.reasons.length === 1) out.reasons.push('Its time, type and length are all in line with your other posts, so the difference is most likely the topic itself.');
    return out;
  }

  // ---------- 15. a plain check of a comment before it is posted ----------

  const GENERIC = /^(great|nice|awesome|amazing|good|excellent|brilliant|fantastic|insightful|well said|so true|love (this|it)|thanks for sharing|agreed?|spot on|this!*|\+1|congrats|congratulations|interesting|helpful|very (true|nice|helpful|insightful))[\s!.]*(post|share|insight|read|point|one|article|thread)?[\s!.]*$/i;
  const words = (t) => new Set(String(t || '').toLowerCase().replace(/[^\p{L}\d\s]/gu, ' ').split(/\s+/).filter((w) => w.length > 2));
  function similarity(a, b) {
    const A = words(a);
    const B = words(b);
    if (!A.size || !B.size) return 0;
    let both = 0;
    for (const w of A) if (B.has(w)) both++;
    return both / (A.size + B.size - both);
  }

  // earlier: your previous comments (records or strings).
  function commentCheck(text, earlier) {
    const t = String(text || '').trim();
    const out = [];
    if (!t) return out;
    if (t.split(/\s+/).length < 4) out.push({ code: 'short', message: 'Very short. A few words on what you think reads as a real comment.' });
    if (GENERIC.test(t)) out.push({ code: 'generic', message: 'Reads like a stock reply. Say what specifically stood out to you.' });
    if (t.length > 20 && t === t.toUpperCase() && /[A-Z]/.test(t)) out.push({ code: 'caps', message: 'All capitals reads as shouting.' });
    let closest = null;
    for (const e of earlier || []) {
      const other = typeof e === 'string' ? e : e && e.text;
      const s = similarity(t, other);
      if (s >= 0.6 && (!closest || s > closest.score)) closest = { score: s, text: other };
    }
    if (closest) out.push({ code: 'repeat', message: 'Almost the same as a comment you posted before: “' + (SIT.truncate ? SIT.truncate(closest.text, 60) : closest.text) + '”.', score: closest.score });
    return out;
  }

  SIT.insights = {
    DAYS, TYPE_LABEL, LENGTH_BUCKETS,
    mine, previousRange, change, deltas, bestTimes, hourLabel, hourRange, postTypes, lengthStats, firstLine,
    supporters, engagementRoi, replyTimes, weekStart, weekCounts, goalProgress, followersAt, followerDelta, digest,
    explainPost, commentCheck, similarity, median,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = SIT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
