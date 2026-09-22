// Reads LinkedIn posts, comments and replies from the rendered page.
// LinkedIn changes class names often, so every lookup has fallbacks and the
// impression count is found by its visible text ("1,234 impressions").
(function (root) {
  'use strict';
  const SIT = root.SIT || (root.SIT = {});

  const POST_SEL = [
    '[data-urn^="urn:li:activity:"]',
    '[data-urn^="urn:li:ugcPost:"]',
    '[data-urn^="urn:li:share:"]',
    '[data-id^="urn:li:activity:"]',
    '[data-id^="urn:li:ugcPost:"]',
  ].join(',');
  const COMMENT_ARTICLE_SEL = 'article.comments-comment-entity, article.comments-comment-item';
  const COMMENT_SEL = COMMENT_ARTICLE_SEL + ', [data-id^="urn:li:comment:"]';
  const COMMENT_LIST_SEL = '.comments-comments-list, .comments-comment-list, .feed-shared-update-v2__comments-container';
  const TEXT_BODY_SEL = [
    '.update-components-text',
    '.feed-shared-text',
    '.feed-shared-inline-show-more-text',
    '.feed-shared-update-v2__description',
    '.comments-comment-item__main-content',
    '.comments-comment-item-content-body',
    '.update-components-article',
  ].join(',');
  const ACTOR_LINK_SEL = [
    'a.update-components-actor__meta-link',
    'a.update-components-actor__image',
    'a.update-components-actor__container-link',
    '.update-components-actor a[href]',
    '.feed-shared-actor a[href]',
  ].join(',');
  const ACTOR_NAME_SEL = [
    '.update-components-actor__title span[aria-hidden="true"]',
    '.update-components-actor__name',
    '.update-components-actor__title',
    '.feed-shared-actor__name',
  ].join(',');
  const ACTOR_TIME_SEL = '.update-components-actor__sub-description, .feed-shared-actor__sub-description';
  const COMMENT_AUTHOR_LINK_SEL = [
    '.comments-comment-meta__description-container a[href]',
    'a.comments-comment-meta__image-link',
    '.comments-comment-meta__actor a[href]',
    'a.comments-post-meta__actor-link',
    '.comments-post-meta a[href]',
    '.comments-comment-item__post-meta a[href]',
  ].join(',');
  const COMMENT_AUTHOR_NAME_SEL = [
    '.comments-comment-meta__description-title',
    '.comments-post-meta__name-text',
    '.comments-comment-meta__actor span[aria-hidden="true"]',
  ].join(',');
  const COMMENT_TEXT_SEL = '.comments-comment-item__main-content, .comments-comment-item-content-body, .update-components-text';
  const COMMENT_TIME_SEL = 'time, .comments-comment-meta__data, .comments-comment-item__timestamp';

  const IMPR_BEFORE = /(\d[\d.,  ]*\s*[KkMm]?)\s*impressions?\b/i;
  const IMPR_AFTER = /impressions?\s*:?\s*(\d[\d.,]*\s*[KkMm]?)(?![\w])/i;

  // ---------- identity ----------

  function profileKey(href) {
    if (!href) return null;
    try {
      const u = new URL(href, 'https://www.linkedin.com');
      const m = u.pathname.match(/^\/in\/([^/]+)/);
      return m ? decodeURIComponent(m[1]).toLowerCase() : null;
    } catch (_) {
      return null;
    }
  }

  function normName(name) {
    return String(name || '').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function matchesMe(href, name, me) {
    if (!me) return false;
    if (href) {
      const key = profileKey(href);
      if (key && me.slug && key === String(me.slug).toLowerCase()) return true;
      if (key && me.profileId && key === String(me.profileId).toLowerCase()) return true;
      if (me.profileId && href.indexOf(me.profileId) !== -1) return true;
      // A profile/company link that is not ours is decisive when we know our own ids.
      if ((key || /\/company\//.test(href)) && (me.slug || me.profileId)) return false;
    }
    return !!(name && me.name && normName(firstLine(name)) === normName(me.name));
  }

  function firstLine(text) {
    return String(text || '').trim().split('\n')[0];
  }

  // Finds {slug, profileId, name} in a /voyager/api/me response (normalised or plain).
  function extractMe(json) {
    const stack = [json];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (typeof node.publicIdentifier === 'string') {
        const urn = String(node.entityUrn || node.dashEntityUrn || node.objectUrn || '');
        const id = urn.split(':').pop();
        return {
          slug: node.publicIdentifier,
          profileId: /^ACo/.test(id) ? id : null,
          name: [node.firstName, node.lastName].filter(Boolean).join(' ') || null,
        };
      }
      for (const k in node) if (node[k] && typeof node[k] === 'object') stack.push(node[k]);
    }
    return null;
  }

  // ---------- urns ----------

  function parsePostUrn(urn) {
    const m = String(urn || '').match(/urn:li:(activity|ugcPost|share):(\d+)/);
    return m ? { type: m[1], id: m[2] } : null;
  }

  function parseCommentUrn(urn) {
    const s = String(urn || '');
    if (s.indexOf('urn:li:comment:') === -1) return null;
    const post = s.match(/(activity|ugcPost|share):(\d+)/);
    const last = s.match(/(\d+)\)+\s*$/);
    if (!last) return null;
    return { postType: post ? post[1] : null, postId: post ? post[2] : null, commentId: last[1] };
  }

  // ---------- DOM helpers ----------

  function urnOf(el) {
    return el && (el.getAttribute('data-urn') || el.getAttribute('data-id'));
  }

  function postRootOf(el) {
    let p = el && el.closest(POST_SEL);
    while (p && p.parentElement) {
      const up = p.parentElement.closest(POST_SEL);
      if (!up || urnOf(up) !== urnOf(p)) break;
      p = up;
    }
    return p;
  }

  function commentRootOf(el) {
    const m = el && el.closest(COMMENT_SEL);
    if (!m) return null;
    if (m.matches(COMMENT_ARTICLE_SEL)) return m;
    const art = m.closest('article');
    return art && art.matches(COMMENT_ARTICLE_SEL) ? art : m;
  }

  function collectPosts(doc) {
    return Array.from(doc.querySelectorAll(POST_SEL)).filter((el) => {
      const parent = el.parentElement && el.parentElement.closest(POST_SEL);
      return !parent;
    });
  }

  function collectComments(scope) {
    const roots = new Set();
    for (const el of scope.querySelectorAll(COMMENT_SEL)) {
      const r = commentRootOf(el);
      if (r) roots.add(r);
    }
    return Array.from(roots);
  }

  function textOf(el) {
    return el ? (el.innerText || el.textContent || '').trim() : '';
  }

  function findImpressions(scope, owns) {
    for (const el of scope.querySelectorAll('[aria-label*="mpression"]')) {
      if (!owns(el)) continue;
      const label = el.getAttribute('aria-label');
      const m = label.match(IMPR_BEFORE) || label.match(IMPR_AFTER);
      if (m) return SIT.parseCount(m[1]);
    }
    const doc = scope.ownerDocument || scope;
    const walker = doc.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
    let node;
    while ((node = walker.nextNode())) {
      if (!/impression/i.test(node.nodeValue)) continue;
      const parent = node.parentElement;
      if (!parent || !owns(parent) || parent.closest(TEXT_BODY_SEL)) continue;
      let el = parent;
      for (let i = 0; i < 4 && el && el !== scope.parentElement; i++, el = el.parentElement) {
        const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
        if (text.length > 90) break;
        const m = text.match(IMPR_BEFORE) || text.match(IMPR_AFTER);
        if (m) return SIT.parseCount(m[1]);
      }
    }
    return null;
  }

  function findCommentCount(card, owns) {
    const candidates = card.querySelectorAll(
      '.social-details-social-counts__comments, button[aria-label*="comment" i], a[aria-label*="comment" i]'
    );
    for (const el of candidates) {
      if (!owns(el)) continue;
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
      const m = label.match(/(\d[\d.,]*\s*[KkMm]?)\s*comments?\b/i);
      if (m) return SIT.parseCount(m[1]);
    }
    return null;
  }

  function findCommentsButton(card) {
    const owns = (n) => postRootOf(n) === card && !commentRootOf(n);
    const candidates = card.querySelectorAll(
      '.social-details-social-counts__comments button, button[aria-label*="comment" i]'
    );
    for (const el of candidates) {
      if (!owns(el)) continue;
      const label = (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
      if (/\d[\d.,]*\s*[KkMm]?\s*comments?\b/i.test(label)) return el;
    }
    return null;
  }

  // ---------- parsing ----------

  function parsePostCard(card, me, now) {
    const urn = urnOf(card);
    const ids = parsePostUrn(urn);
    if (!ids) return null;

    const owns = (n) => postRootOf(n) === card && !commentRootOf(n) && !n.closest(COMMENT_LIST_SEL);
    const notHeader = (n) => !n.closest('.update-components-header, .feed-shared-header') && !n.closest(TEXT_BODY_SEL);

    let actorLink = Array.from(card.querySelectorAll(ACTOR_LINK_SEL)).find((a) => owns(a) && notHeader(a));
    if (!actorLink) {
      actorLink = Array.from(card.querySelectorAll('a[href*="/in/"], a[href*="/company/"]'))
        .find((a) => owns(a) && notHeader(a));
    }
    const nameEl = Array.from(card.querySelectorAll(ACTOR_NAME_SEL)).find(owns);
    const actorName = firstLine(textOf(nameEl));
    const actorHref = actorLink ? actorLink.getAttribute('href') : null;
    const mine = matchesMe(actorHref, actorName, me);

    const info = { card, urn, ids, mine, record: null };
    if (!mine) return info;

    const textEl = Array.from(card.querySelectorAll('.update-components-text, .feed-shared-update-v2__description, .feed-shared-text'))
      .find(owns);
    const timeEl = Array.from(card.querySelectorAll(ACTOR_TIME_SEL)).find(owns);
    const idTs = SIT.liIdToMs(ids.id);
    const createdAt = idTs || SIT.relativeToMs(textOf(timeEl).split('•')[0], now);

    info.record = {
      id: 'li:' + ids.type + ':' + ids.id,
      platform: 'linkedin',
      ref: ids.id,
      kind: 'post',
      direction: 'mine',
      author: profileKey(actorHref),
      authorName: actorName || null,
      text: SIT.truncate(textOf(textEl), 280),
      url: 'https://www.linkedin.com/feed/update/urn:li:' + ids.type + ':' + ids.id + '/',
      createdAt,
      tsPrecise: !!idTs,
      impressions: findImpressions(card, owns),
      replies: findCommentCount(card, owns),
      source: 'dom',
      confidence: 1,
    };
    return info;
  }

  function commentAuthor(root) {
    const owns = (n) => commentRootOf(n) === root;
    let link = Array.from(root.querySelectorAll(COMMENT_AUTHOR_LINK_SEL)).find(owns);
    if (!link) {
      link = Array.from(root.querySelectorAll('a[href*="/in/"], a[href*="/company/"]'))
        .find((a) => owns(a) && !a.closest(COMMENT_TEXT_SEL));
    }
    const nameEl = Array.from(root.querySelectorAll(COMMENT_AUTHOR_NAME_SEL)).find(owns);
    return {
      href: link ? link.getAttribute('href') : null,
      name: firstLine(textOf(nameEl)) || null,
    };
  }

  function commentUrnOf(root) {
    const own = root.getAttribute('data-id');
    if (own && own.indexOf('urn:li:comment:') === 0) return own;
    const inner = Array.from(root.querySelectorAll('[data-id^="urn:li:comment:"]'))
      .find((n) => commentRootOf(n) === root);
    return inner ? inner.getAttribute('data-id') : null;
  }

  // ctx: { postMine, postIds }
  function parseComment(root, me, now, ctx) {
    const owns = (n) => commentRootOf(n) === root;
    const author = commentAuthor(root);
    const mine = matchesMe(author.href, author.name, me);
    const parentRoot = root.parentElement ? commentRootOf(root.parentElement) : null;
    const isReply = !!parentRoot ||
      root.classList.contains('comments-comment-entity--reply') ||
      !!root.closest('.comments-replies-list, .comments-comment-item__nested-items');

    let direction = null;
    if (mine) direction = 'mine';
    else if (!isReply && ctx && ctx.postMine) direction = 'received';
    else if (isReply) {
      // LinkedIn threads are one level deep: a reply to my reply sits under the
      // same top-level comment and @mentions me, so check both.
      const pa = parentRoot ? commentAuthor(parentRoot) : null;
      const mentionsMe = Array.from(root.querySelectorAll('a[href*="/in/"]'))
        .some((a) => owns(a) && a.closest(COMMENT_TEXT_SEL) && matchesMe(a.getAttribute('href'), null, me));
      if ((pa && matchesMe(pa.href, pa.name, me)) || mentionsMe) direction = 'received';
    }
    if (!direction) return null;

    const urn = commentUrnOf(root);
    const ids = parseCommentUrn(urn);
    const textEl = Array.from(root.querySelectorAll(COMMENT_TEXT_SEL)).find(owns);
    const text = textOf(textEl);
    const timeEl = Array.from(root.querySelectorAll(COMMENT_TIME_SEL)).find(owns);
    const idTs = ids ? SIT.liIdToMs(ids.commentId) : null;
    const createdAt = idTs || SIT.relativeToMs(textOf(timeEl), now);

    const postType = (ids && ids.postType) || (ctx && ctx.postIds && ctx.postIds.type) || 'activity';
    const postId = (ids && ids.postId) || (ctx && ctx.postIds && ctx.postIds.id) || null;
    const id = ids
      ? 'li:comment:' + ids.commentId
      : 'li:h:' + SIT.hash((author.href || author.name || '') + '|' + text.slice(0, 200));
    let url = null;
    if (postId) {
      url = 'https://www.linkedin.com/feed/update/urn:li:' + postType + ':' + postId + '/';
      if (urn) url += '?commentUrn=' + encodeURIComponent(urn);
    }

    let parentAuthor = null;
    if (parentRoot) parentAuthor = commentAuthor(parentRoot).name;

    return {
      id,
      platform: 'linkedin',
      ref: ids ? ids.commentId : null,
      kind: isReply ? 'reply' : 'comment',
      direction,
      author: profileKey(author.href),
      authorName: author.name,
      text: SIT.truncate(text, 280),
      url,
      createdAt,
      tsPrecise: !!idTs,
      impressions: direction === 'mine' ? findImpressions(root, owns) : null,
      parentRef: postId,
      parentAuthor,
      source: 'dom',
      confidence: 1,
    };
  }

  // ---------- LinkedIn's 2026 layout ----------
  // Class names are hashed, so this relies on `componentkey` attributes and visible text:
  //   post card  div[componentkey^="update-card-"]
  //   own posts  a[href*="/analytics/post-summary/urn:li:activity:ID/"] and an "N impressions" line
  //   comments   [componentkey="CommentComponentReference_urn:li:comment:(activity:POST,COMMENT)"]

  const CARD2_SEL = '[componentkey^="update-card-"]';
  const COMMENT2_SEL = '[componentkey^="CommentComponentReference_"]';
  const IMPR_ONLY = /^(\d[\d.,]*\s*[KkMm]?)\s+impressions?$/i;
  const COMMENTS_ONLY = /^(\d[\d.,]*\s*[KkMm]?)\s+comments?$/i;
  const TIME_ONLY = /^(\d+\s*(mo|yr|s|m|h|d|w|y)|now)(\s*•)?(\s*Edited)?(\s*•)?$/i;
  const BODY_STOP = /^(…\s*more|\.\.\.\s*more|Like|Comment|Repost|Send|Reply|Reaction button state.*|Open reactions menu|View analytics)$/i;

  // The comment-tools componentkey starts with a base64 protobuf whose first
  // field holds the post id, zigzag-encoded (stored value = id × 2).
  function decodePostKey(key) {
    try {
      const b64 = String(key).replace(/-/g, '+').replace(/_/g, '/');
      const bin = atob(b64 + '==='.slice((b64.length + 3) % 4));
      if (bin.charCodeAt(0) !== 0x0a || bin.charCodeAt(2) !== 0x08) return null;
      let value = 0n;
      let shift = 0n;
      for (let i = 3; i < bin.length; i++) {
        const byte = bin.charCodeAt(i);
        value |= BigInt(byte & 0x7f) << shift;
        shift += 7n;
        if (!(byte & 0x80)) break;
      }
      const id = (value >> 1n).toString();
      return /^\d{15,20}$/.test(id) ? id : null;
    } catch (_) {
      return null;
    }
  }

  function textNodes(scope, owns) {
    const out = [];
    const doc = scope.ownerDocument || scope;
    const walker = doc.createTreeWalker(scope, 4 /* NodeFilter.SHOW_TEXT */);
    let node;
    while ((node = walker.nextNode())) {
      const value = node.nodeValue.replace(/\s+/g, ' ').trim();
      const parent = node.parentElement;
      if (value && parent && owns(parent)) out.push(value);
    }
    return out;
  }

  function bodyAfterTime(values, timeIdx) {
    const parts = [];
    for (let i = timeIdx + 1; i < values.length; i++) {
      const v = values[i];
      if (BODY_STOP.test(v) || IMPR_ONLY.test(v)) break;
      if (v === '•') continue;
      parts.push(v);
    }
    return parts.join(' ');
  }

  function countFrom(values, pattern) {
    for (const v of values) {
      const m = v.match(pattern);
      if (m) return SIT.parseCount(m[1]);
    }
    return null;
  }

  function parseCardV2(card, me, now) {
    const owns = (el) => el.closest(CARD2_SEL) === card && !el.closest(COMMENT2_SEL);
    const analytics = Array.from(card.querySelectorAll('a[href*="/analytics/post-summary/"]')).find(owns);
    let ids = analytics ? parsePostUrn(analytics.getAttribute('href')) : null;
    if (!ids) {
      const tools = Array.from(card.querySelectorAll('[componentkey*="-replaceableCommentTools"]')).find(owns);
      const id = tools && decodePostKey(tools.getAttribute('componentkey').split('-replaceableCommentTools')[0]);
      if (id) ids = { type: 'activity', id };
    }
    if (!ids) return null;

    const values = textNodes(card, owns);
    const timeIdx = values.findIndex((v) => TIME_ONLY.test(v));
    const header = timeIdx >= 0 ? values.slice(0, timeIdx) : values.slice(0, 6);
    // Analytics links only exist on your own posts; the "• You" badge covers cards
    // whose analytics row hasn't rendered yet.
    const mine = !!analytics || header.some((v) => /^•?\s*You$/i.test(v));
    const info = { card, ids, mine, record: null };
    if (!mine) return info;

    const idTs = SIT.liIdToMs(ids.id);
    info.record = {
      id: 'li:' + ids.type + ':' + ids.id,
      platform: 'linkedin',
      ref: ids.id,
      kind: 'post',
      direction: 'mine',
      author: (me && me.slug) || null,
      authorName: (me && me.name) || null,
      text: SIT.truncate(timeIdx >= 0 ? bodyAfterTime(values, timeIdx) : '', 280),
      url: 'https://www.linkedin.com/feed/update/urn:li:' + ids.type + ':' + ids.id + '/',
      createdAt: idTs || (timeIdx >= 0 ? SIT.relativeToMs(values[timeIdx], now) : null),
      tsPrecise: !!idTs,
      impressions: countFrom(values, IMPR_ONLY),
      replies: countFrom(values, COMMENTS_ONLY),
      source: 'dom',
      confidence: 1,
    };
    return info;
  }

  // ctx: { minePostIds: Set, cardMine: Map(card -> bool), pagePostMine: bool,
  //        pageAuthor: string|null, keepOthers: bool }
  // Returns direction 'other' for someone else's comment on someone else's post when
  // keepOthers is set: the content script checks those with the API in case they are
  // replies in one of your threads.
  function parseCommentV2(el, me, now, ctx) {
    const urn = el.getAttribute('componentkey').replace(/^CommentComponentReference_/, '');
    const ids = parseCommentUrn(urn);
    if (!ids) return null;
    const owns = (n) => n.closest(COMMENT2_SEL) === el;
    const link = Array.from(el.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')).find(owns);
    const href = link ? link.getAttribute('href') : null;
    const mine = matchesMe(href, null, me);

    const card = el.closest(CARD2_SEL);
    const postMine = (ids.postId && ctx.minePostIds.has(ids.postId)) ||
      (card ? ctx.cardMine.get(card) === true : ctx.pagePostMine === true);
    const direction = mine ? 'mine' : postMine ? 'received' : ctx.keepOthers ? 'other' : null;
    if (!direction) return null;

    const values = textNodes(el, owns);
    const timeIdx = values.findIndex((v) => TIME_ONLY.test(v));
    const idTs = SIT.liIdToMs(ids.commentId);
    return {
      id: 'li:comment:' + ids.commentId,
      platform: 'linkedin',
      ref: ids.commentId,
      urn,
      kind: 'comment', // refined to 'reply' by the comment API lookup
      direction,
      onMyPost: !!postMine,
      postAuthor: postMine ? null : (card ? cardAuthor(card, me) : ctx.pageAuthor) || null,
      author: profileKey(href),
      authorName: values.length ? values[0].split(',')[0].replace(/\s+•.*$/, '').trim() : null,
      text: SIT.truncate(timeIdx >= 0 ? bodyAfterTime(values, timeIdx) : '', 280),
      url: ids.postId
        ? 'https://www.linkedin.com/feed/update/urn:li:' + ids.postType + ':' + ids.postId + '/?commentUrn=' + encodeURIComponent(urn)
        : null,
      createdAt: idTs || (timeIdx >= 0 ? SIT.relativeToMs(values[timeIdx], now) : null),
      tsPrecise: !!idTs,
      impressions: mine ? countFrom(values, IMPR_ONLY) : null,
      parentRef: ids.postId,
      source: 'dom',
      confidence: 1,
    };
  }

  // "urn:li:comment:(activity:POST,ID)" or "urn:li:fsd_comment:(ID,urn:li:activity:POST)" -> ID
  function commentIdOf(urn) {
    const s = String(urn || '');
    const dash = s.match(/fsd_comment:\((\d+),/);
    if (dash) return dash[1];
    const c = parseCommentUrn(s);
    return c ? c.commentId : null;
  }

  // Reads a /voyager/api/voyagerSocialDashComments/{fsd_comment urn} response.
  // Verified on a live account (Sept 2026): the comment itself is `data`; a reply carries
  // parentCommentBackendUrn / parentCommentUrn pointing at its top-level comment (LinkedIn
  // threads are one level deep). SocialDetail.threadUrn points at the comment itself, so
  // it can't be used to spot replies. SocialActivityCounts.numComments is the reply count.
  function readCommentInfo(json, commentId) {
    const data = (json && json.data) || {};
    let parentId = null;
    for (const v of [data.parentCommentBackendUrn, data.parentCommentUrn]) {
      if (!parentId && typeof v === 'string') parentId = commentIdOf(v);
    }
    if (parentId === commentId) parentId = null;

    let impressions = null;
    let replyCount = null;
    for (const item of [data].concat((json && json.included) || [])) {
      if (!item || String(item.entityUrn || '').indexOf(commentId) === -1) continue;
      if (impressions == null && typeof item.numImpressions === 'number') impressions = item.numImpressions;
      if (replyCount == null && typeof item.numComments === 'number') replyCount = item.numComments;
    }
    if (!data.entityUrn && impressions == null && replyCount == null) return null;
    return { isReply: !!parentId, parentId, impressions, replyCount };
  }

  // The post author shown on a card (first profile link that isn't you, outside comments).
  function cardAuthor(card, me) {
    const owns = (el) => el.closest(CARD2_SEL) === card && !el.closest(COMMENT2_SEL);
    for (const a of card.querySelectorAll('a[href*="/in/"], a[href*="/company/"]')) {
      if (!owns(a) || matchesMe(a.getAttribute('href'), null, me)) continue;
      const name = (a.textContent || '').replace(/\s+/g, ' ').replace(/\s*•.*$/, '').trim();
      if (name) return name;
    }
    return null;
  }

  function parseDocument(doc, me, now, ctx) {
    now = now || Date.now();
    const records = [];
    const handled = new Set();
    for (const card of collectPosts(doc)) {
      const info = parsePostCard(card, me, now);
      if (!info) continue;
      if (info.record) records.push(info.record);
      for (const c of collectComments(card)) {
        handled.add(c);
        const r = parseComment(c, me, now, { postMine: info.mine, postIds: info.ids });
        if (r) records.push(r);
      }
    }
    for (const c of collectComments(doc)) {
      if (handled.has(c)) continue;
      const r = parseComment(c, me, now, null);
      if (r) records.push(r);
    }

    // 2026 layout
    const minePostIds = new Set((ctx && ctx.minePostIds) || []);
    const cardMine = new Map();
    const cards = Array.from(doc.querySelectorAll(CARD2_SEL))
      .filter((c) => !(c.parentElement && c.parentElement.closest(CARD2_SEL)));
    // ctx.cache (a WeakMap) lets repeated passes skip cards and comments whose text hasn't changed.
    const cache = ctx && ctx.cache;
    const cached = (el, key, compute) => {
      if (!cache) return compute();
      const hit = cache.get(el);
      if (hit && hit.key === key) return hit.value;
      const value = compute();
      cache.set(el, { key, value });
      return value;
    };
    for (const card of cards) {
      const info = cached(card, 'card:' + card.textContent.length, () => parseCardV2(card, me, now));
      if (!info) continue;
      cardMine.set(card, info.mine);
      if (info.mine) minePostIds.add(info.ids.id);
      if (info.record) records.push(info.record);
    }
    // On a single post page the comments render outside the card.
    const path = (ctx && ctx.path) || (doc.location && doc.location.pathname) || '';
    const postPage = /\/feed\/update\//.test(path) && cards.length === 1;
    const pagePostMine = postPage && cardMine.get(cards[0]) === true;
    const pageAuthor = postPage && !pagePostMine ? cardAuthor(cards[0], me) : null;
    const keepOthers = !!(ctx && ctx.keepOthers) && postPage;
    const commentCtx = { minePostIds, cardMine, pagePostMine, pageAuthor, keepOthers };
    for (const el of doc.querySelectorAll(COMMENT2_SEL)) {
      const card = el.closest(CARD2_SEL);
      const postId = (el.getAttribute('componentkey').match(/(?:activity|ugcPost|share):(\d+)/) || [])[1];
      const key = [el.textContent.length, minePostIds.has(postId), card ? cardMine.get(card) : pagePostMine, keepOthers].join('|');
      const r = cached(el, key, () => parseCommentV2(el, me, now, commentCtx));
      if (r) records.push(r);
    }
    return records;
  }

  // Looks for impression numbers inside Voyager JSON (network responses or the
  // <code> data blobs LinkedIn embeds in the page) keyed by the post/comment urn.
  function extractImpressionHints(json) {
    const hints = [];
    const stack = [json];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (!Array.isArray(node)) {
        let impressions = null;
        let urn = null;
        for (const k in node) {
          const v = node[k];
          if (impressions == null && /impression/i.test(k) && typeof v === 'number') impressions = v;
          if (!urn && typeof v === 'string' && /urn:li:(activity|ugcPost|share|comment):/.test(v) && /urn$/i.test(k)) urn = v;
        }
        if (impressions != null && urn) {
          const c = parseCommentUrn(urn);
          if (c) hints.push({ id: 'li:comment:' + c.commentId, impressions });
          else {
            const p = parsePostUrn(urn);
            if (p) hints.push({ id: 'li:' + p.type + ':' + p.id, impressions });
          }
        }
      }
      for (const k in node) if (node[k] && typeof node[k] === 'object') stack.push(node[k]);
    }
    return hints;
  }

  SIT.li = {
    POST_SEL,
    COMMENT_SEL,
    profileKey,
    matchesMe,
    extractMe,
    parsePostUrn,
    parseCommentUrn,
    collectPosts,
    collectComments,
    parsePostCard,
    parseComment,
    parseDocument,
    findCommentsButton,
    extractImpressionHints,
    CARD2_SEL,
    COMMENT2_SEL,
    decodePostKey,
    parseCardV2,
    readCommentInfo,
    commentIdOf,
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SIT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
