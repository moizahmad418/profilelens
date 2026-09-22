const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSIT } = require('./helpers');

const SIT = loadSIT();
const ME = { id: '100', handle: 'alex' };

const USERS = {
  '100': { handle: 'alex', name: 'Alex' },
  '200': { handle: 'alice', name: 'Alice' },
  '300': { handle: 'bob', name: 'Bob' },
  '400': { handle: 'carol', name: 'Carol' },
  '500': { handle: 'dave', name: 'Dave' },
};

// Builds a GraphQL tweet result the way X returns it.
function tweet(id, userId, text, opts = {}) {
  const u = USERS[userId];
  const result = {
    __typename: 'Tweet',
    rest_id: id,
    core: {
      user_results: {
        result: { __typename: 'User', rest_id: userId, core: { screen_name: u.handle, name: u.name }, legacy: {} },
      },
    },
    views: opts.views != null ? { count: String(opts.views), state: 'EnabledWithCount' } : { state: 'Enabled' },
    legacy: {
      id_str: id,
      user_id_str: userId,
      full_text: text,
      created_at: opts.createdAt || 'Mon Sep 14 10:00:00 +0000 2026',
      conversation_id_str: opts.conversation || id,
      favorite_count: 3,
      reply_count: 1,
      retweet_count: 0,
      in_reply_to_status_id_str: opts.replyTo,
      in_reply_to_user_id_str: opts.replyToUser,
      in_reply_to_screen_name: opts.replyToUser ? USERS[opts.replyToUser].handle : undefined,
    },
  };
  if (opts.retweetOf) result.legacy.retweeted_status_result = { result: opts.retweetOf };
  return opts.wrap ? { __typename: 'TweetWithVisibilityResults', tweet: result } : result;
}

function timeline(results) {
  return {
    data: {
      user: {
        result: {
          timeline_v2: {
            timeline: {
              instructions: [{
                type: 'TimelineAddEntries',
                entries: results.map((r, i) => ({
                  entryId: 'tweet-' + i,
                  content: { itemContent: { tweet_results: { result: r } } },
                })),
              }],
            },
          },
        },
      },
    },
  };
}

function byId(records) {
  return Object.fromEntries(records.map((r) => [r.id, r]));
}

test('classifies my posts, comments, replies and what others sent me', () => {
  const payload = timeline([
    tweet('1001', '100', 'My launch post', { views: 1234, createdAt: 'Mon Sep 14 09:00:00 +0000 2026' }),
    tweet('2001', '200', 'Alice post', { views: 9000, createdAt: 'Mon Sep 14 08:00:00 +0000 2026' }),
    tweet('1002', '100', '@alice nice one', { views: 56, replyTo: '2001', replyToUser: '200', conversation: '2001', createdAt: 'Mon Sep 14 09:10:00 +0000 2026' }),
    tweet('3001', '300', '@alice agree', { views: 40, replyTo: '2001', replyToUser: '200', conversation: '2001', createdAt: 'Mon Sep 14 09:05:00 +0000 2026' }),
    tweet('1003', '100', '@bob true!', { views: 7, replyTo: '3001', replyToUser: '300', conversation: '2001', createdAt: 'Mon Sep 14 09:20:00 +0000 2026' }),
    tweet('4001', '400', '@alex congrats', { views: 12, replyTo: '1001', replyToUser: '100', conversation: '1001', createdAt: 'Mon Sep 14 09:30:00 +0000 2026' }),
    tweet('5001', '500', '@alex good point', { views: 3, replyTo: '1002', replyToUser: '100', conversation: '2001', createdAt: 'Mon Sep 14 09:40:00 +0000 2026' }),
    tweet('1004', '100', '2/ and another thing', { views: 300, replyTo: '1001', replyToUser: '100', conversation: '1001', createdAt: 'Mon Sep 14 09:01:00 +0000 2026' }),
    tweet('1005', '100', 'RT @alice: Alice post', { views: 1, retweetOf: tweet('2002', '200', 'Alice other'), createdAt: 'Mon Sep 14 11:00:00 +0000 2026' }),
    tweet('1006', '100', 'Wrapped visibility post', { views: 800, wrap: true, createdAt: 'Mon Sep 14 12:00:00 +0000 2026' }),
  ]);

  const tweets = SIT.x.extractTweets(payload);
  assert.equal(tweets.length, 11, 'finds every tweet including the retweeted original');

  const records = byId(SIT.x.toRecords(tweets, ME, new Map()));

  assert.deepEqual(
    Object.keys(records).sort(),
    ['x:1001', 'x:1002', 'x:1003', 'x:1004', 'x:1006', 'x:4001', 'x:5001'],
  );

  assert.equal(records['x:1001'].kind, 'post');
  assert.equal(records['x:1001'].direction, 'mine');
  assert.equal(records['x:1001'].impressions, 1234);
  assert.equal(records['x:1001'].url, 'https://x.com/alex/status/1001');

  assert.equal(records['x:1002'].kind, 'comment');
  assert.equal(records['x:1002'].direction, 'mine');
  assert.equal(records['x:1002'].impressions, 56);
  assert.equal(records['x:1002'].parentAuthor, '@alice');
  assert.equal(records['x:1002'].onMyPost, false);
  assert.equal(records['x:1002'].threadRef, '2001');

  assert.equal(records['x:1003'].kind, 'reply');
  assert.equal(records['x:1003'].direction, 'mine');

  assert.equal(records['x:1004'].kind, 'comment', 'answering your own post is a comment on your post');
  assert.equal(records['x:1004'].onMyPost, true);

  assert.equal(records['x:1006'].kind, 'post');
  assert.equal(records['x:1006'].impressions, 800);

  assert.equal(records['x:4001'].kind, 'comment');
  assert.equal(records['x:4001'].direction, 'received');
  assert.equal(records['x:4001'].onMyPost, true);

  assert.equal(records['x:5001'].kind, 'reply');
  assert.equal(records['x:5001'].direction, 'received');

  assert.equal(records['x:1001'].createdAt, Date.UTC(2026, 8, 14, 9, 0, 0));
});

test('memory links replies to parents seen in an earlier payload', () => {
  const memory = new Map();
  SIT.x.toRecords(SIT.x.extractTweets(timeline([
    tweet('7001', '100', 'Thread start', { views: 10 }),
    tweet('7002', '100', 'Thread part 2', { views: 10, replyTo: '7001', replyToUser: '100', conversation: '7001' }),
  ])), ME, memory);

  // 7002 answers my own post, so it is my comment; someone answering it is replying to my comment.
  const later = SIT.x.toRecords(SIT.x.extractTweets(timeline([
    tweet('8001', '400', '@alex yes', { replyTo: '7002', replyToUser: '100', conversation: '7001' }),
  ])), ME, memory);
  assert.equal(later.length, 1);
  assert.equal(later[0].kind, 'reply');
  assert.equal(later[0].direction, 'received');
  assert.equal(later[0].parentRef, '7002');
  assert.equal(later[0].onMyPost, true, 'the conversation root 7001 is my post');
});

test('works with only a handle (no numeric id) and ignores other people', () => {
  const records = SIT.x.toRecords(SIT.x.extractTweets(timeline([
    tweet('9001', '100', 'Handle-only match', { views: 5 }),
    tweet('9002', '200', 'Not mine', { views: 5 }),
    tweet('9003', '300', '@alice reply between others', { replyTo: '9002', replyToUser: '200', conversation: '9002' }),
  ])), { handle: 'ALEX' }, new Map());
  assert.deepEqual(records.map((r) => r.id), ['x:9001']);
});

test('parses the flat REST shape used by notification timelines', () => {
  const payload = {
    globalObjects: {
      tweets: {
        '6001': {
          id_str: '6001', user_id_str: '400', created_at: 'Tue Sep 15 10:00:00 +0000 2026',
          full_text: '@alex loved this', in_reply_to_status_id_str: '1001', in_reply_to_user_id_str: '100',
          in_reply_to_screen_name: 'alex', conversation_id_str: '1001', ext_views: { count: '42' },
        },
      },
      users: { '400': { id_str: '400', screen_name: 'carol', name: 'Carol' } },
    },
  };
  const tweets = SIT.x.extractTweets(payload);
  assert.equal(tweets.length, 1);
  assert.equal(tweets[0].handle, 'carol');
  const records = SIT.x.toRecords(tweets, ME, new Map());
  assert.equal(records[0].kind, 'comment');
  assert.equal(records[0].direction, 'received');
  assert.equal(records[0].impressions, 42);
});

test('reads the signed-in account from the Viewer query', () => {
  const viewer = SIT.x.extractViewer({
    data: { viewer: { user_results: { result: { __typename: 'User', rest_id: '100', legacy: { screen_name: 'alex', name: 'Alex' } } } } },
  });
  assert.deepEqual(viewer, { id: '100', handle: 'alex', name: 'Alex' });
});

test('long posts use the note_tweet text and decode entities', () => {
  const t = tweet('9101', '100', 'short &amp; truncated…', { views: 1 });
  t.note_tweet = { note_tweet_results: { result: { text: 'The full long-form text & more' } } };
  const [parsed] = SIT.x.extractTweets(timeline([t]));
  assert.equal(parsed.text, 'The full long-form text & more');
  const [plain] = SIT.x.extractTweets(timeline([tweet('9102', '100', 'Q&amp;A &lt;3', { views: 1 })]));
  assert.equal(plain.text, 'Q&A <3');
});
