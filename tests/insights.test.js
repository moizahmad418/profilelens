const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSIT } = require('./helpers');

const SIT = loadSIT();
const I = SIT.insights;
const DAY = 24 * 3600e3;

// A post at a local date/time with a given impression count.
const at = (y, m, d, h) => new Date(y, m, d, h, 15).getTime();
let seq = 0;
const post = (createdAt, impressions, extra) => Object.assign({
  id: 'x:' + (++seq), platform: 'x', ref: String(seq), kind: 'post', direction: 'mine', createdAt, impressions, text: 'post number ' + seq,
}, extra);

test('previousRange is the same length of time right before the current one', () => {
  const now = new Date(2026, 8, 26, 15).getTime();
  const prev = I.previousRange({ type: 'days', days: 7 }, now);
  const cur = SIT.stats.rangeBounds({ type: 'days', days: 7 }, now);
  const before = SIT.stats.rangeBounds(prev.range, prev.now);
  assert.equal(before.end, cur.start, 'the previous week ends where this one starts');
  assert.equal(Math.round((before.end - before.start) / DAY), 7);
  const month = I.previousRange({ type: 'month', year: 2026, month: 0 }, now);
  assert.deepEqual(month.range, { type: 'month', year: 2025, month: 11 });
});

test('deltas compare impressions and counts with the period before', () => {
  const now = new Date(2026, 8, 26, 15).getTime();
  const recs = [post(now - DAY, 300), post(now - 2 * DAY, 300), post(now - 9 * DAY, 200)];
  const cur = SIT.stats.summarize(recs, { platform: 'all', range: { type: 'days', days: 7 } }, now);
  const prev = I.previousRange({ type: 'days', days: 7 }, now);
  const before = SIT.stats.summarize(recs, { platform: 'all', range: prev.range }, prev.now);
  const d = I.deltas(cur, before);
  assert.equal(d.post.impressions, 2, '600 vs 200 is up 200%');
  assert.equal(d.post.count, 1);
  assert.equal(I.change(5, 0), null, 'nothing before: no ratio');
  assert.equal(I.change(0, 0), 0);
});

test('best time to post: two-hour blocks and weekdays, with a sentence once there are 5 posts', () => {
  // Tuesday 9am posts do best; Sunday evenings are weak.
  const recs = [];
  for (let w = 0; w < 4; w++) {
    recs.push(post(at(2026, 8, 1 + w * 7, 9), 1000 + w)); // Tuesdays 9am
    recs.push(post(at(2026, 8, 6 + w * 7, 21), 100 + w)); // Sundays 9pm
  }
  const t = I.bestTimes(recs, { platform: 'all' });
  assert.equal(t.total, 8);
  assert.equal(t.bestBlock.hour, 8);
  assert.equal(t.bestDays[0].label, 'Tue');
  assert.match(t.sentence, /Tue.*8 am–10 am/);
  assert.equal(t.cells[2 * 24 + 9].n, 4);
  const few = I.bestTimes(recs.slice(0, 3), {});
  assert.equal(few.sentence, null);
  assert.equal(few.needed, 2);
});

test('post types are compared once each has 2 posts', () => {
  const recs = [post(1, 100, { postType: 'text' }), post(2, 120, { postType: 'text' }), post(3, 400, { postType: 'image' }), post(4, 500, { postType: 'image' }), post(5, 900, { postType: 'video' })];
  const t = I.postTypes(recs, {});
  assert.deepEqual(t.rows.map((r) => [r.type, r.count]), [['video', 1], ['image', 2], ['text', 2]]);
  assert.match(t.sentence, /^Image posts do best \(avg 450\), 4\.1× text posts\./);
  assert.equal(I.postTypes([post(1, 5)], {}).rows[0].type, 'text', 'no type recorded means a text post');
});

test('length and hooks: buckets, hashtags and questions', () => {
  const long = 'x'.repeat(200);
  const recs = [
    post(1, 100, { text: 'short one' }), post(2, 120, { text: 'short two' }),
    post(3, 400, { text: long }), post(4, 500, { text: long + '!' }),
    post(5, 900, { text: 'Why does this work? #growth' }), post(6, 800, { text: 'Is it me? #tips' }),
  ];
  const t = I.lengthStats(recs, {});
  assert.equal(t.buckets.find((b) => b.key === 'long').count, 2);
  assert.equal(t.hashtags.yes.n, 2);
  assert.equal(t.questions.yes.n, 2);
  assert.ok(t.sentences.some((s) => /hashtags/.test(s)));
  assert.equal(I.firstLine('First line.\nSecond'), 'First line.');
});

test('supporters and engagement return group by person', () => {
  const now = Date.now();
  const recs = [
    { id: 'x:a', platform: 'x', ref: 'a', kind: 'comment', direction: 'received', author: '@sam', authorName: 'Sam', createdAt: now - DAY },
    { id: 'x:b', platform: 'x', ref: 'b', kind: 'reply', direction: 'received', author: '@sam', authorName: 'Sam', createdAt: now - 2 * DAY },
    { id: 'li:c', platform: 'linkedin', ref: 'c', kind: 'comment', direction: 'received', authorName: 'Dana', createdAt: now - 3 * DAY },
    { id: 'x:m1', platform: 'x', ref: 'm1', kind: 'comment', direction: 'mine', parentAuthor: '@vercel', impressions: 500, createdAt: now - DAY },
    { id: 'x:m2', platform: 'x', ref: 'm2', kind: 'reply', direction: 'mine', parentAuthor: '@vercel', impressions: 200, createdAt: now - DAY },
    { id: 'li:m3', platform: 'linkedin', ref: 'm3', kind: 'comment', direction: 'mine', postAuthor: 'Lee', impressions: 300, createdAt: now - DAY },
    { id: 'li:m4', platform: 'linkedin', ref: 'm4', kind: 'comment', direction: 'mine', onMyPost: true, impressions: 9000, createdAt: now - DAY },
  ];
  const s = I.supporters(recs, {});
  assert.deepEqual(s.map((r) => [r.name, r.count]), [['Sam', 2], ['Dana', 1]]);
  const roi = I.engagementRoi(recs, {});
  assert.deepEqual(roi.rows.map((r) => [r.who, r.sum, r.count]), [['@vercel', 700, 2], ['Lee', 300, 1]], 'comments on your own posts are left out');
  assert.match(roi.sentence, /@vercel’s posts earned you 700/);
});

test('reply times: X by parent, LinkedIn by thread order', () => {
  const t0 = Date.now() - 5 * DAY;
  const h = 3600e3;
  const recs = [
    { id: 'x:1', platform: 'x', ref: '1', kind: 'reply', direction: 'received', createdAt: t0 },
    { id: 'x:2', platform: 'x', ref: '2', kind: 'reply', direction: 'mine', parentRef: '1', createdAt: t0 + 2 * h },
    { id: 'li:c', platform: 'linkedin', ref: 'c', kind: 'comment', direction: 'mine', createdAt: t0 },
    { id: 'li:r1', platform: 'linkedin', ref: 'r1', kind: 'reply', direction: 'received', threadRef: 'c', createdAt: t0 + h },
    { id: 'li:r2', platform: 'linkedin', ref: 'r2', kind: 'reply', direction: 'mine', threadRef: 'c', createdAt: t0 + 5 * h },
    { id: 'li:r3', platform: 'linkedin', ref: 'r3', kind: 'reply', direction: 'received', threadRef: 'c', createdAt: t0 + 6 * h },
  ];
  const r = I.replyTimes(recs, {});
  assert.equal(r.samples, 2);
  assert.equal(r.median, 3 * h, 'median of 2h and 4h');
  assert.equal(I.replyTimes(recs, { platform: 'x' }).median, 2 * h);
});

test('weekly goals: progress this week and the streak of weeks that met every goal', () => {
  const now = new Date(2026, 8, 24, 12).getTime(); // a Thursday
  const monday = I.weekStart(now);
  assert.equal(new Date(monday).getDay(), 1);
  const recs = [];
  // this week: 2 posts (goal 2 met)
  recs.push(post(monday + DAY, 10), post(monday + 2 * DAY, 10));
  // last 3 weeks: 2 posts each; 4 weeks ago only 1
  for (let w = 1; w <= 3; w++) recs.push(post(monday - w * 7 * DAY + DAY, 10), post(monday - w * 7 * DAY + 2 * DAY, 10));
  recs.push(post(monday - 4 * 7 * DAY + DAY, 10));
  const p = I.goalProgress(recs, { post: 2 }, now);
  assert.equal(p.met, true);
  assert.equal(p.streak, 4);
  assert.equal(p.daysLeft, 4);
  const harder = I.goalProgress(recs, { post: 2, comment: 1 }, now);
  assert.equal(harder.met, false);
  assert.equal(harder.streak, 0);
  assert.deepEqual(harder.remaining, { post: 0, comment: 1, reply: 0 });
  assert.equal(I.goalProgress(recs, {}, now).set.length, 0, 'no goals set');
});

test('follower change uses the samples around the period', () => {
  const now = Date.now();
  const hist = [{ at: now - 20 * DAY, count: 100 }, { at: now - 8 * DAY, count: 110 }, { at: now - DAY, count: 125 }];
  assert.deepEqual(I.followerDelta(hist, now - 7 * DAY, now), { from: 110, to: 125, delta: 15 });
  assert.equal(I.followerDelta(hist, now - 30 * DAY, now - 25 * DAY).delta, null);
  assert.equal(I.followerDelta([], now - 7 * DAY, now).delta, null);
});

test('the weekly digest covers the last complete week', () => {
  const now = new Date(2026, 8, 24, 12).getTime(); // Thursday Sep 24
  const monday = I.weekStart(now); // Sep 21
  const recs = [post(monday - 6 * DAY, 500, { text: 'best' }), post(monday - 5 * DAY, 50, { text: 'worst' }), post(monday - 10 * DAY, 100), post(monday + DAY, 999)];
  const d = I.digest(recs, { x: [{ at: monday - 8 * DAY, count: 100 }, { at: monday - DAY, count: 130 }] }, now);
  assert.equal(new Date(d.start).getDate(), 14);
  assert.equal(d.end, monday);
  assert.equal(d.best.text, 'best');
  assert.equal(d.worst.text, 'worst');
  assert.equal(d.total, 550);
  assert.equal(d.prevTotal, 100);
  assert.equal(d.followers.x.delta, 30);
  assert.equal(d.empty, false);
  assert.equal(I.digest([], {}, now).empty, true);
});

test('explainPost compares a post with the others and names what stands out', () => {
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push(post(at(2026, 8, 1 + i, 9), 100, { postType: 'text' }));
  for (let i = 0; i < 3; i++) recs.push(post(at(2026, 8, 10 + i, 9), 400, { postType: 'image' }));
  const star = post(at(2026, 8, 20, 9), 500, { postType: 'image' });
  const x = I.explainPost(star, recs.concat(star));
  assert.equal(x.verdict, 'above');
  assert.match(x.reasons[0], /above your usual/);
  assert.ok(x.reasons.some((r) => /^Image post:/.test(r)), 'image posts stand out: ' + x.reasons.join(' | '));
  const few = I.explainPost(post(1, 5), [post(2, 5)]);
  assert.match(few.reasons[0], /Not enough/);
  assert.equal(I.explainPost({ kind: 'comment' }, recs), null);
});

test('commentCheck flags short, stock and repeated comments', () => {
  const earlier = ['We saw the same thing when we switched to usage pricing', 'Congrats on the launch!'];
  assert.deepEqual(I.commentCheck('Great post!', earlier).map((w) => w.code), ['short', 'generic']);
  assert.deepEqual(I.commentCheck('We saw exactly the same thing when we switched to usage pricing', earlier).map((w) => w.code), ['repeat']);
  assert.deepEqual(I.commentCheck('THIS IS THE BEST THING I HAVE READ ALL WEEK', earlier).map((w) => w.code), ['caps']);
  assert.deepEqual(I.commentCheck('I tried this with a team of six and the cadence broke after a month.', earlier), []);
  assert.deepEqual(I.commentCheck('', earlier), []);
});
