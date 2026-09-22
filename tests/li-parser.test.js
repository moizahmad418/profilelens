// Pure LinkedIn helpers. DOM parsing is covered by tests/browser/linkedin-dom.html.
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSIT } = require('./helpers');

const SIT = loadSIT();

test('comment urns: top-level, ugcPost and nested forms', () => {
  assert.deepEqual(SIT.li.parseCommentUrn('urn:li:comment:(activity:7372000000000000000,7372100000000000000)'),
    { postType: 'activity', postId: '7372000000000000000', commentId: '7372100000000000000' });
  assert.deepEqual(SIT.li.parseCommentUrn('urn:li:comment:(urn:li:ugcPost:7371000000000000000,7371100000000000000)'),
    { postType: 'ugcPost', postId: '7371000000000000000', commentId: '7371100000000000000' });
  assert.equal(SIT.li.parseCommentUrn('urn:li:comment:(urn:li:comment:(activity:1,2),3)').commentId, '3');
  assert.equal(SIT.li.parseCommentUrn('urn:li:activity:7372000000000000000'), null);
});

test('post urns', () => {
  assert.deepEqual(SIT.li.parsePostUrn('urn:li:activity:7372000000000000000'), { type: 'activity', id: '7372000000000000000' });
  assert.deepEqual(SIT.li.parsePostUrn('urn:li:ugcPost:1234567890123456789'), { type: 'ugcPost', id: '1234567890123456789' });
  assert.equal(SIT.li.parsePostUrn('urn:li:fsd_profile:ACoAAB'), null);
});

test('matchesMe prefers profile links and falls back to names', () => {
  const me = { slug: 'alex-morgan', profileId: 'ACoAABx9', name: 'Alex Morgan' };
  assert.equal(SIT.li.matchesMe('https://www.linkedin.com/in/alex-morgan/', null, me), true);
  assert.equal(SIT.li.matchesMe('/in/Alex-Morgan?miniProfileUrn=x', null, me), true);
  assert.equal(SIT.li.matchesMe('/in/ACoAABx9', null, me), true);
  assert.equal(SIT.li.matchesMe('/in/someone-else/', 'Alex Morgan', me), false);
  assert.equal(SIT.li.matchesMe('/company/acme/', 'Alex Morgan', me), false);
  assert.equal(SIT.li.matchesMe(null, 'Alex  Morgan\nFounder', me), true);
  assert.equal(SIT.li.matchesMe('/in/anyone/', 'Alex Morgan', { name: 'Alex Morgan' }), true);
  assert.equal(SIT.li.matchesMe('/in/x', 'Someone', null), false);
});

test('extractMe reads plain and normalised /voyager/api/me responses', () => {
  assert.deepEqual(SIT.li.extractMe({
    plainId: 1,
    miniProfile: { firstName: 'Alex', lastName: 'Morgan', publicIdentifier: 'alex-morgan', entityUrn: 'urn:li:fs_miniProfile:ACoAABx9' },
  }), { slug: 'alex-morgan', profileId: 'ACoAABx9', name: 'Alex Morgan' });

  assert.deepEqual(SIT.li.extractMe({
    data: { plainId: 1, '*miniProfile': 'urn:li:fs_miniProfile:ACoAABx9' },
    included: [{ $type: 'com.linkedin.voyager.identity.shared.MiniProfile', firstName: 'Alex', lastName: 'Morgan', publicIdentifier: 'alex-morgan', entityUrn: 'urn:li:fs_miniProfile:ACoAABx9' }],
  }), { slug: 'alex-morgan', profileId: 'ACoAABx9', name: 'Alex Morgan' });
});

test('impression hints are matched to post and comment ids', () => {
  const hints = SIT.li.extractImpressionHints({
    included: [
      { entityUrn: 'urn:li:fsd_socialActivityCounts:urn:li:activity:7372000000000000000', numImpressions: 1500, numLikes: 3 },
      { commentUrn: 'urn:li:comment:(activity:7372000000000000000,7372100000000000000)', impressionCount: 44 },
      { entityUrn: 'urn:li:activity:1', numLikes: 3 },
    ],
  });
  assert.deepEqual(hints.sort((a, b) => a.id.localeCompare(b.id)), [
    { id: 'li:activity:7372000000000000000', impressions: 1500 },
    { id: 'li:comment:7372100000000000000', impressions: 44 },
  ]);
});

// Builds a componentkey prefix the way LinkedIn does: protobuf { 1: { 1: zigzag(id) } } in base64.
function postKey(id) {
  let v = BigInt(id) * 2n;
  const varint = [];
  do { let b = Number(v & 0x7fn); v >>= 7n; if (v) b |= 0x80; varint.push(b); } while (v);
  const bytes = [0x0a, varint.length + 1, 0x08, ...varint];
  return Buffer.from(bytes).toString('base64').replace(/=+$/, '');
}

test('decodePostKey reads the post id from a comment-tools componentkey', () => {
  const id = '7400000000000000001';
  assert.equal(SIT.li.decodePostKey(postKey(id)), id);
  assert.equal(SIT.li.decodePostKey(postKey(id).replace(/\+/g, '-').replace(/\//g, '_')), id, 'url-safe base64 too');
  assert.equal(SIT.li.decodePostKey('IEi-CSFdBoOUH4cKMbGBo'), null);
  assert.equal(SIT.li.decodePostKey('not base64!'), null);
});

test('readCommentInfo reads the parent comment, reply count and impressions', () => {
  // Shapes match a live voyagerSocialDashComments response (Sept 2026), with made-up ids.
  const top = {
    data: {
      entityUrn: 'urn:li:fsd_comment:(7400000000000000102,urn:li:activity:7400000000000000100)',
      parentCommentUrn: null,
      parentCommentBackendUrn: null,
      threadUrn: null,
    },
    included: [
      { entityUrn: 'urn:li:fsd_socialDetail:(urn:li:comment:(activity:7400000000000000100,7400000000000000102),x)', threadUrn: 'urn:li:comment:(activity:7400000000000000100,7400000000000000102)' },
      { entityUrn: 'urn:li:fsd_socialActivityCounts:urn:li:comment:(activity:7400000000000000100,7400000000000000102)', numImpressions: 692, numComments: 2, numLikes: 1 },
      { entityUrn: 'urn:li:fsd_socialActivityCounts:urn:li:activity:7400000000000000100', numImpressions: 99999, numComments: 16 },
    ],
  };
  assert.deepEqual(SIT.li.readCommentInfo(top, '7400000000000000102'), { isReply: false, parentId: null, impressions: 692, replyCount: 2 });

  // A reply: SocialDetail.threadUrn still points at the reply itself, so only the parent fields tell.
  const reply = {
    data: {
      entityUrn: 'urn:li:fsd_comment:(7400000000000000200,urn:li:activity:7400000000000000100)',
      parentCommentUrn: 'urn:li:fsd_comment:(7400000000000000102,urn:li:activity:7400000000000000100)',
      parentCommentBackendUrn: 'urn:li:comment:(activity:7400000000000000100,7400000000000000102)',
      threadUrn: null,
    },
    included: [
      { entityUrn: 'urn:li:fsd_socialDetail:(urn:li:comment:(activity:7400000000000000100,7400000000000000200),x)', threadUrn: 'urn:li:comment:(activity:7400000000000000100,7400000000000000200)' },
      { entityUrn: 'urn:li:fsd_socialActivityCounts:urn:li:comment:(activity:7400000000000000100,7400000000000000200)', numImpressions: 25, numComments: 0 },
    ],
  };
  assert.deepEqual(SIT.li.readCommentInfo(reply, '7400000000000000200'), { isReply: true, parentId: '7400000000000000102', impressions: 25, replyCount: 0 });

  const dashOnly = { data: { entityUrn: 'urn:li:fsd_comment:(7400000000000000201,urn:li:activity:1)', parentCommentUrn: 'urn:li:fsd_comment:(7400000000000000102,urn:li:activity:1)' } };
  assert.equal(SIT.li.readCommentInfo(dashOnly, '7400000000000000201').parentId, '7400000000000000102');
  assert.equal(SIT.li.readCommentInfo({ included: [] }, '1'), null);
});

test('commentIdOf handles both comment urn shapes', () => {
  assert.equal(SIT.li.commentIdOf('urn:li:comment:(activity:1,22)'), '22');
  assert.equal(SIT.li.commentIdOf('urn:li:fsd_comment:(33,urn:li:ugcPost:1)'), '33');
  assert.equal(SIT.li.commentIdOf('urn:li:activity:1'), null);
});
