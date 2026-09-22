const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSIT } = require('./helpers');

const SIT = loadSIT();
const NOW = new Date(2026, 8, 17, 12, 0).getTime(); // Sep 17 2026, local noon
const daysAgo = (n, hour = 10) => new Date(2026, 8, 17 - n, hour).getTime();

const records = {
  a: { id: 'a', platform: 'linkedin', kind: 'post', direction: 'mine', createdAt: daysAgo(0), impressions: 1000 },
  b: { id: 'b', platform: 'x', kind: 'post', direction: 'mine', createdAt: daysAgo(5), impressions: 500 },
  c: { id: 'c', platform: 'x', kind: 'comment', direction: 'mine', createdAt: daysAgo(2), impressions: 50 },
  d: { id: 'd', platform: 'linkedin', kind: 'reply', direction: 'mine', createdAt: daysAgo(9), impressions: 20 },
  e: { id: 'e', platform: 'linkedin', kind: 'post', direction: 'mine', createdAt: daysAgo(20), impressions: 300 },
  f: { id: 'f', platform: 'x', kind: 'comment', direction: 'received', onMyPost: true, createdAt: daysAgo(1), impressions: 9 },
  g: { id: 'g', platform: 'linkedin', kind: 'comment', direction: 'mine', createdAt: daysAgo(1), impressions: null },
  h: { id: 'h', platform: 'x', kind: 'reply', direction: 'received', createdAt: daysAgo(40) },
};

const days = (n, platform = 'all', recs = records) => SIT.stats.summarize(recs, { platform, range: { type: 'days', days: n } }, NOW);

test('day windows include today and the previous N-1 calendar days', () => {
  const d3 = days(3);
  assert.equal(d3.posts, 1000);
  assert.equal(d3.comments, 50);
  assert.equal(d3.replies, 0);
  assert.equal(d3.daily.length, 3);

  const d10 = days(10);
  assert.equal(d10.posts, 1500);
  assert.equal(d10.comments, 50);
  assert.equal(d10.replies, 20, 'replies are totalled separately from comments');
  assert.equal(d10.mine.reply.count, 1);

  const d30 = days(30);
  assert.equal(d30.posts, 1800);
  assert.equal(d30.daily.length, 30);
});

test('received items are counted but never added to impressions', () => {
  const d7 = days(7);
  assert.equal(d7.received.comment, 1);
  assert.equal(days(30).comments, 50);
});

test('items without an impression count are tracked separately', () => {
  const d3 = days(3);
  assert.equal(d3.mine.comment.count, 2);
  assert.equal(d3.mine.comment.withData, 1);
});

test('platform filter and per-platform totals', () => {
  assert.equal(days(30, 'x').posts, 500);
  assert.equal(days(30, 'linkedin').posts, 1300);
  assert.deepEqual(days(30).platforms, {
    linkedin: { post: 1300, comment: 0, reply: 20 },
    x: { post: 500, comment: 50, reply: 0 },
  });
});

test('month ranges use calendar months', () => {
  const sep = SIT.stats.summarize(records, { platform: 'all', range: { type: 'month', year: 2026, month: 8 } }, NOW);
  assert.equal(sep.posts, 1500);
  assert.equal(sep.daily.length, 30);
  const aug = SIT.stats.summarize(records, { platform: 'all', range: { type: 'month', year: 2026, month: 7 } }, NOW);
  assert.equal(aug.posts, 300);
});

test('daily buckets and item lists line up with the totals', () => {
  const d10 = days(10);
  assert.equal(d10.daily[9].post, 1000);
  assert.equal(d10.daily[4].post, 500);
  assert.equal(d10.daily[7].comment, 50);
  assert.equal(d10.daily[0].reply, 20);
  assert.deepEqual(d10.items.post.map((r) => r.id), ['a', 'b']);
  assert.deepEqual(d10.items.comment.map((r) => r.id), ['c', 'g']);
  assert.deepEqual(d10.items.reply.map((r) => r.id), ['d']);
});

test('month options list the last 12 months plus older months with data', () => {
  const old = Object.assign({}, records, {
    z: { id: 'z', platform: 'x', kind: 'post', direction: 'mine', createdAt: new Date(2024, 0, 5).getTime(), impressions: 1 },
  });
  const opts = SIT.stats.monthOptions(old, NOW);
  assert.equal(opts[0].label, 'September 2026');
  assert.equal(opts[0].short, 'Sep 2026');
  assert.equal(opts[11].label, 'October 2025');
  assert.equal(opts[opts.length - 1].label, 'January 2024');
});

test('CSV export escapes text safely', () => {
  const csv = SIT.stats.toCSV({ q: { platform: 'x', kind: 'post', direction: 'mine', createdAt: NOW, impressions: 5, text: 'Hello, "world"\nnew line' } });
  assert.match(csv, /"Hello, ""world""\nnew line"/);
});

// ---------- impression levels ----------

const sample = (platform, kind, values) => Object.fromEntries(values.map((v, i) => [
  platform + kind + i,
  { id: platform + kind + i, platform, kind, direction: 'mine', createdAt: daysAgo(i), impressions: v },
]));

test('levels compare an item with your usual for that platform and type', () => {
  const base = SIT.stats.baselines(sample('x', 'comment', [100, 100, 100, 100, 100]));
  const at = (v, platform = 'x') => (SIT.stats.levelFor(v, platform, 'comment', base) || {}).key;
  assert.equal(at(250), 'very-high');
  assert.equal(at(200), 'very-high');
  assert.equal(at(150), 'high');
  assert.equal(at(100), 'medium');
  assert.equal(at(76), 'medium');
  assert.equal(at(50), 'low');
  assert.equal(at(30), 'very-low');
  assert.equal(at(250, 'linkedin'), 'very-high', 'falls back to the cross-platform usual');
  assert.equal(SIT.stats.levelFor(100, 'x', 'post', base), null, 'no level without history');
  assert.equal(SIT.stats.levelFor(100, 'x', 'comment', base).usual, 100);
});

test('levels need 5 items and handle a usual of zero', () => {
  assert.equal(SIT.stats.baselines(sample('x', 'reply', [1, 2, 3, 4])).size, 0);
  const zero = SIT.stats.baselines(sample('x', 'reply', [0, 0, 0, 0, 0]));
  assert.equal(SIT.stats.levelFor(3, 'x', 'reply', zero).key, 'very-high');
  assert.equal(SIT.stats.levelFor(0, 'x', 'reply', zero).key, 'medium');
});

test('platform-specific usual wins over the cross-platform one', () => {
  const recs = Object.assign(sample('x', 'post', [1000, 1000, 1000, 1000, 1000]), sample('linkedin', 'post', [100, 100, 100, 100, 100]));
  const base = SIT.stats.baselines(recs);
  assert.equal(SIT.stats.levelFor(200, 'linkedin', 'post', base).key, 'very-high');
  assert.equal(SIT.stats.levelFor(200, 'x', 'post', base).key, 'very-low');
});

// ---------- conversations ----------

const at = (h) => daysAgo(1, h);
const rec = (o) => Object.assign({ id: o.platform + ':' + o.ref }, o);

test('X: replies to your comment and to your reply are tracked separately', () => {
  const list = [
    rec({ platform: 'x', ref: 'c1', kind: 'comment', direction: 'mine', parentRef: 'p0', createdAt: at(1), impressions: 80 }),
    rec({ platform: 'x', ref: 'r1', kind: 'reply', direction: 'received', parentRef: 'c1', author: '@bob', createdAt: at(2) }),
    rec({ platform: 'x', ref: 'r2', kind: 'reply', direction: 'mine', parentRef: 'r1', createdAt: at(3), impressions: 12 }),
    rec({ platform: 'x', ref: 'r3', kind: 'reply', direction: 'received', parentRef: 'r2', author: '@bob', createdAt: at(4) }),
    rec({ platform: 'x', ref: 'c2', kind: 'comment', direction: 'mine', parentRef: 'p9', createdAt: at(5), impressions: 5 }),
    rec({ platform: 'x', ref: 'r4', kind: 'reply', direction: 'received', parentRef: 'c2', author: '@amy', createdAt: at(6) }),
    rec({ platform: 'x', ref: 'k1', kind: 'comment', direction: 'received', parentRef: 'mypost', onMyPost: true, createdAt: at(7) }),
    rec({ platform: 'x', ref: 'r9', kind: 'reply', direction: 'received', parentRef: '1570361570108649529', author: '@sam', createdAt: at(8) }),
  ];
  const s = days(7, 'all', list);

  assert.deepEqual(s.needs.comment.map((e) => e.item.ref), ['1570361570108649529', 'c2'],
    'comments whose responder is waiting (newest first), including one not scanned yet');
  assert.equal(s.needs.comment[0].item.placeholder, true);
  assert.deepEqual(s.needs.comment[1].pending.map((o) => o.ref), ['r4']);

  assert.deepEqual(s.needs.reply.map((e) => e.item.ref), ['r2']);
  assert.deepEqual(s.needs.reply[0].pending.map((o) => o.ref), ['r3']);

  const c1 = s.convo.get('x:c1');
  assert.deepEqual(c1.responses.map((o) => o.ref), ['r1']);
  assert.equal(c1.pending.length, 0, 'answered by your reply r2');
  assert.equal(c1.threadSize, 4);

  assert.equal(s.engaged.comment, 2);
  assert.equal(s.threads.comment, 1);
  assert.equal(s.received.reply, 4);
  assert.equal(s.received.comment, 1);
  assert.equal(days(7, 'linkedin', list).needs.reply.length, 0, 'platform filter applies');
});

test('LinkedIn: flat threads assign each response to your latest message before it', () => {
  const list = [
    rec({ platform: 'linkedin', ref: 'T', kind: 'comment', direction: 'mine', threadRef: 'T', createdAt: at(1), impressions: 600 }),
    rec({ platform: 'linkedin', ref: 'a1', kind: 'reply', direction: 'received', threadRef: 'T', authorName: 'Jamie', createdAt: at(2) }),
    rec({ platform: 'linkedin', ref: 'm1', kind: 'reply', direction: 'mine', threadRef: 'T', createdAt: at(3), impressions: 25 }),
    rec({ platform: 'linkedin', ref: 'a2', kind: 'reply', direction: 'received', threadRef: 'T', authorName: 'Jamie', createdAt: at(4) }),
    rec({ platform: 'linkedin', ref: 'a3', kind: 'reply', direction: 'received', threadRef: 'T', authorName: 'Sara', createdAt: at(6) }),
    rec({ platform: 'linkedin', ref: 'm2', kind: 'reply', direction: 'mine', threadRef: 'S', createdAt: at(2), impressions: 9 }),
    rec({ platform: 'linkedin', ref: 'b1', kind: 'reply', direction: 'received', threadRef: 'S', createdAt: at(3) }),
    rec({ platform: 'linkedin', ref: 'u1', kind: 'reply', direction: 'received', threadRef: 'U', createdAt: at(3) }),
  ];
  const s = days(7, 'all', list);

  const t = s.convo.get('linkedin:T');
  assert.deepEqual(t.responses.map((o) => o.ref), ['a1']);
  assert.equal(t.pending.length, 0);
  assert.equal(s.needs.comment.length, 0);

  assert.deepEqual(s.needs.reply.map((e) => e.item.ref), ['m1', 'm2']);
  assert.deepEqual(s.needs.reply[0].pending.map((o) => o.ref), ['a3', 'a2']);
  assert.equal(s.needs.reply[0].threadSize, 5);
  assert.equal(t.threadSize, 5);
  assert.equal(s.threads.comment, 1, 'your comment T grew into a 5-message thread');
  assert.equal(s.threads.reply, 1, 'm1 is in that thread; m2 only has one response');
  assert.equal(s.convo.has('linkedin:u1'), false, 'threads you are not part of are ignored');
});

test('needs-reply lists only include responses that arrived in the selected range', () => {
  const list = [
    rec({ platform: 'x', ref: 'c1', kind: 'comment', direction: 'mine', parentRef: 'p0', createdAt: daysAgo(20), impressions: 80 }),
    rec({ platform: 'x', ref: 'r1', kind: 'reply', direction: 'received', parentRef: 'c1', createdAt: daysAgo(15) }),
  ];
  assert.equal(days(7, 'all', list).needs.comment.length, 0);
  assert.equal(days(30, 'all', list).needs.comment.length, 1);
});

test('exports never start a cell with a formula', () => {
  assert.equal(SIT.stats.csvCell('=HYPERLINK("http://x","y")'), '"\'=HYPERLINK(""http://x"",""y"")"');
  assert.equal(SIT.stats.csvCell('+cmd'), "'+cmd");
  assert.equal(SIT.stats.csvCell('@someone hi'), "'@someone hi");
  assert.equal(SIT.stats.csvCell(-5), '-5', 'numbers stay numbers');
  assert.equal(SIT.stats.csvCell('line one\rline two'), '"line one\rline two"');
  const csv = SIT.stats.toCSV([{ id: 'x:1', platform: 'x', ref: '1', kind: 'reply', direction: 'received', createdAt: 1757000000000, text: '=1+1', author: '+evil' }]);
  assert.ok(csv.includes("'=1+1") && csv.includes("'+evil"));
});

test('the daily chart has one bucket per calendar day and every item lands in one', () => {
  const now = new Date(2026, 3, 28, 15).getTime();
  const recs = [];
  for (let d = 0; d < 7; d++) recs.push({ id: 'x:' + d, platform: 'x', ref: String(d), kind: 'post', direction: 'mine', createdAt: new Date(2026, 3, 28 - d, 9).getTime(), impressions: 10 });
  const s = SIT.stats.summarize(recs, { platform: 'all', range: { type: 'days', days: 7 } }, now);
  assert.equal(s.daily.length, 7);
  assert.equal(s.daily.reduce((n, d) => n + d.post, 0), 70);
  for (const d of s.daily) assert.equal(d.start, SIT.stats.startOfDay(d.start), 'each bucket starts where its day starts');
});
