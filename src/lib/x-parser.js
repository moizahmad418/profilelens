// Turns X (Twitter) API payloads into impression records.
// Works on GraphQL responses (UserTweetsAndReplies, TweetDetail, HomeTimeline, ...)
// and the older flat REST shape (globalObjects.tweets), by walking the whole JSON tree
// instead of depending on one exact response layout.
(function (root) {
  'use strict';
  const SIT = root.SIT || (root.SIT = {});

  function userHandle(user) {
    if (!user) return null;
    return (user.core && user.core.screen_name) || (user.legacy && user.legacy.screen_name) || null;
  }

  function userName(user) {
    if (!user) return null;
    return (user.core && user.core.name) || (user.legacy && user.legacy.name) || null;
  }

  function decodeEntities(text) {
    return String(text || '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&amp;/g, '&');
  }

  function visibleText(legacy, note) {
    if (note && note.text) return note.text;
    const full = legacy.full_text || legacy.text || '';
    const range = legacy.display_text_range;
    if (Array.isArray(range) && range.length === 2) {
      return Array.from(full).slice(range[0], range[1]).join('');
    }
    return full;
  }

  function num(v) {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
  }

  function parseDate(str, id) {
    const ms = Date.parse(str);
    return SIT.plausibleTs(ms) ? ms : SIT.xIdToMs(id);
  }

  function isGraphqlTweet(node) {
    const l = node.legacy;
    return typeof node.rest_id === 'string' && l && typeof l === 'object' &&
      typeof l.created_at === 'string' &&
      (typeof l.full_text === 'string' || typeof l.conversation_id_str === 'string');
  }

  function isGraphqlUser(node) {
    return node.__typename === 'User' && typeof node.rest_id === 'string';
  }

  function isFlatTweet(node) {
    return typeof node.id_str === 'string' && typeof node.created_at === 'string' &&
      (typeof node.full_text === 'string' || typeof node.text === 'string') &&
      (typeof node.user_id_str === 'string' || (node.user && typeof node.user.id_str === 'string'));
  }

  function fromGraphql(node) {
    const legacy = node.legacy;
    const user = node.core && node.core.user_results && node.core.user_results.result;
    const note = node.note_tweet && node.note_tweet.note_tweet_results && node.note_tweet.note_tweet_results.result;
    const views = node.views && node.views.count != null ? SIT.parseCount(node.views.count) : null;
    return {
      id: node.rest_id,
      authorId: legacy.user_id_str || (user && user.rest_id) || null,
      handle: userHandle(user),
      name: userName(user),
      text: decodeEntities(visibleText(legacy, note)),
      createdAt: parseDate(legacy.created_at, node.rest_id),
      views,
      likes: num(legacy.favorite_count),
      replies: num(legacy.reply_count),
      reposts: num(legacy.retweet_count),
      inReplyToId: legacy.in_reply_to_status_id_str || null,
      inReplyToUserId: legacy.in_reply_to_user_id_str || null,
      inReplyToHandle: legacy.in_reply_to_screen_name || null,
      conversationId: legacy.conversation_id_str || null,
      isRetweet: !!legacy.retweeted_status_result || /^RT @/.test(legacy.full_text || ''),
    };
  }

  function fromFlat(node, users) {
    const authorId = node.user_id_str || (node.user && node.user.id_str);
    const u = users.get(authorId) || (node.user ? { handle: node.user.screen_name, name: node.user.name } : null);
    const views = node.ext_views && node.ext_views.count != null ? SIT.parseCount(node.ext_views.count) : null;
    return {
      id: node.id_str,
      authorId,
      handle: (u && u.handle) || null,
      name: (u && u.name) || null,
      text: decodeEntities(visibleText(node, null)),
      createdAt: parseDate(node.created_at, node.id_str),
      views,
      likes: num(node.favorite_count),
      replies: num(node.reply_count),
      reposts: num(node.retweet_count),
      inReplyToId: node.in_reply_to_status_id_str || null,
      inReplyToUserId: node.in_reply_to_user_id_str || null,
      inReplyToHandle: node.in_reply_to_screen_name || null,
      conversationId: node.conversation_id_str || null,
      isRetweet: !!node.retweeted_status_id_str || !!node.retweeted_status || /^RT @/.test(node.full_text || node.text || ''),
    };
  }

  function mergeTweet(map, t) {
    const prev = map.get(t.id);
    if (!prev) { map.set(t.id, t); return; }
    for (const k of Object.keys(t)) {
      if (prev[k] == null && t[k] != null) prev[k] = t[k];
    }
    if (t.views != null && (prev.views == null || t.views > prev.views)) prev.views = t.views;
  }

  // Returns every tweet found anywhere in the payload, normalised.
  function extractTweets(json) {
    const tweets = new Map();
    const users = new Map();
    const flat = [];
    const notFlat = new WeakSet();
    const stack = [json];

    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (Array.isArray(node)) {
        for (const v of node) if (v && typeof v === 'object') stack.push(v);
        continue;
      }
      if (isGraphqlTweet(node)) {
        mergeTweet(tweets, fromGraphql(node));
        notFlat.add(node.legacy);
      } else if (isGraphqlUser(node)) {
        users.set(node.rest_id, { handle: userHandle(node), name: userName(node) });
      } else if (!notFlat.has(node)) {
        if (isFlatTweet(node)) flat.push(node);
        else if (typeof node.id_str === 'string' && typeof node.screen_name === 'string') {
          users.set(node.id_str, { handle: node.screen_name, name: node.name || null });
        }
      }
      for (const key in node) {
        const v = node[key];
        if (v && typeof v === 'object') stack.push(v);
      }
    }

    for (const f of flat) {
      if (!tweets.has(f.id_str)) tweets.set(f.id_str, fromFlat(f, users));
    }
    for (const t of tweets.values()) {
      if (!t.handle && t.authorId && users.has(t.authorId)) {
        t.handle = users.get(t.authorId).handle;
        t.name = t.name || users.get(t.authorId).name;
      }
    }
    return Array.from(tweets.values());
  }

  // Finds the signed-in account in a payload (the "Viewer" query), if present.
  function extractViewer(json) {
    const v = json && json.data && json.data.viewer;
    const user = v && v.user_results && v.user_results.result;
    if (user && user.rest_id) return { id: user.rest_id, handle: userHandle(user), name: userName(user) };
    return null;
  }

  function isMine(t, me) {
    if (!me) return false;
    if (me.id && t.authorId) return t.authorId === me.id;
    return SIT.eqi(t.handle, me.handle);
  }

  function repliesToMe(t, me) {
    if (me.id && t.inReplyToUserId) return t.inReplyToUserId === me.id;
    return SIT.eqi(t.inReplyToHandle, me.handle);
  }

  // Decides whether a tweet is my post / comment / reply, or someone else's
  // comment / reply on my content. `lookup(id)` returns {mine, kind} for known tweets.
  // A comment answers a post; a reply answers a comment or another reply. That holds
  // for my own posts too, so answering myself under my post is a comment, not a post.
  function classify(t, me, lookup) {
    if (!me || (!me.id && !me.handle) || t.isRetweet) return null;
    const parent = t.inReplyToId ? lookup(t.inReplyToId) : null;
    const root = t.conversationId ? lookup(t.conversationId) : null;
    const toRoot = t.inReplyToId === t.conversationId;
    const kindUnder = () => (parent && parent.kind ? (parent.kind === 'post' ? 'comment' : 'reply') : toRoot ? 'comment' : 'reply');

    if (isMine(t, me)) {
      if (!t.inReplyToId) return { kind: 'post', direction: 'mine' };
      const onMyPost = toRoot ? repliesToMe(t, me) : !!(root && root.mine);
      return { kind: kindUnder(), direction: 'mine', onMyPost };
    }

    if (!t.inReplyToId || !repliesToMe(t, me)) return null;
    const onMyPost = toRoot || !!(root && root.mine);
    return { kind: kindUnder(), direction: 'received', onMyPost };
  }

  // `memory` is a Map(id -> {mine, kind}) that persists between payloads so replies
  // can be matched with parents seen earlier.
  function toRecords(tweets, me, memory) {
    memory = memory || new Map();
    const lookup = (id) => memory.get(id) || null;
    const sorted = tweets.slice().sort((a, b) => (a.createdAt || 0) - (b.createdAt || 0));
    const records = [];
    for (const t of sorted) {
      const c = classify(t, me, lookup);
      memory.set(t.id, c ? { mine: c.direction === 'mine', kind: c.kind } : { mine: isMine(t, me), kind: null });
      if (!c) continue;
      records.push({
        id: 'x:' + t.id,
        platform: 'x',
        ref: t.id,
        kind: c.kind,
        direction: c.direction,
        onMyPost: c.kind === 'post' ? undefined : c.onMyPost,
        threadRef: t.conversationId,
        author: t.handle ? '@' + t.handle : null,
        authorName: t.name || null,
        text: SIT.truncate(t.text, 280),
        url: 'https://x.com/' + (t.handle || 'i/web') + '/status/' + t.id,
        createdAt: t.createdAt,
        tsPrecise: true,
        impressions: t.views,
        likes: t.likes,
        replies: t.replies,
        reposts: t.reposts,
        parentRef: t.inReplyToId,
        parentAuthor: t.inReplyToHandle ? '@' + t.inReplyToHandle : null,
        source: 'api',
        confidence: 2,
      });
    }
    return records;
  }

  // DOM fallback for a rendered <article data-testid="tweet">.
  function parseArticle(article) {
    const time = article.querySelector('a[href*="/status/"] time');
    const link = time && time.closest('a');
    const m = link && (link.getAttribute('href') || '').match(/^\/([^/]+)\/status\/(\d+)/);
    if (!m) return null;
    const analytics = article.querySelector('a[href$="/analytics"]');
    const views = analytics
      ? SIT.parseCount(analytics.getAttribute('aria-label') || analytics.textContent)
      : null;
    const createdAt = Date.parse(time.getAttribute('datetime'));
    return {
      id: m[2],
      handle: m[1],
      createdAt: SIT.plausibleTs(createdAt) ? createdAt : SIT.xIdToMs(m[2]),
      views,
      replyContext: /Replying to/i.test(article.textContent || ''),
    };
  }

  SIT.x = { extractTweets, extractViewer, classify, toRecords, parseArticle, isMine };

  if (typeof module !== 'undefined' && module.exports) module.exports = SIT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
