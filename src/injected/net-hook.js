// Runs inside the page's own JavaScript world at document_start.
// It copies API responses the site already receives and hands them to this
// extension's content script via window.postMessage. No data is sent anywhere else.
//
// On X it can also page through a timeline for a scan: it repeats the timeline
// request the page itself just made, with the next-page cursor from the response,
// so a scan doesn't have to scroll and render every post.
(() => {
  'use strict';
  if (window.__sitNetHook) return;
  Object.defineProperty(window, '__sitNetHook', { value: true });

  // __sitTestHost lets the local browser tests exercise the X code path on localhost.
  const isX = /(^|\.)(x|twitter)\.com$/.test(location.hostname) || window.__sitTestHost === 'x';
  const MAX_BODY = 12 * 1024 * 1024;

  function wanted(url) {
    if (!url) return false;
    return isX
      ? /\/i\/api\/(graphql|2|1\.1)\//.test(url)
      : /\/voyager\/api\//.test(url);
  }

  function relevant(text) {
    if (typeof text !== 'string' || !text || text.length > MAX_BODY) return false;
    return isX ? text.includes('"created_at"') : /impression|impresion|impressõ|Impressionen|vertoning|gösterim|followerCount|followersCount/i.test(text);
  }

  function emit(url, text) {
    if (!relevant(text)) return;
    try {
      window.postMessage({ __sit: 'net', url: String(url), body: text }, location.origin);
    } catch (_) { /* ignore */ }
  }

  function urlOf(input) {
    try {
      if (typeof input === 'string') return new URL(input, location.href).href;
      if (input instanceof URL) return input.href;
      if (input && typeof input.url === 'string') return input.url;
    } catch (_) { /* ignore */ }
    return '';
  }

  // "…/graphql/<id>/UserRepliesTimeline?…" -> "UserRepliesTimeline"; "…/2/notifications/mentions.json" -> "notifications/mentions"
  function opName(url) {
    try {
      const path = new URL(url).pathname;
      const gql = path.match(/\/graphql\/[^/]+\/([^/]+)$/);
      if (gql) return gql[1];
      const rest = path.match(/\/i\/api\/(?:2|1\.1)\/(.+?)(?:\.json)?$/);
      return rest ? rest[1] : null;
    } catch (_) {
      return null;
    }
  }

  // ---------- X timeline paging ----------

  const templates = new Map(); // op name -> { url, headers }
  const cursors = new Map(); // op name -> bottom cursor of the latest page

  function plainHeaders(h) {
    const out = {};
    if (!h) return out;
    try {
      if (typeof h.forEach === 'function' && !Array.isArray(h)) h.forEach((v, k) => { out[k] = v; });
      else if (Array.isArray(h)) for (const [k, v] of h) out[k] = v;
      else Object.assign(out, h);
    } catch (_) { /* ignore */ }
    return out;
  }

  function bottomCursor(json) {
    const stack = [json];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (node.cursorType === 'Bottom' && typeof node.value === 'string') return node.value;
      for (const k in node) if (node[k] && typeof node[k] === 'object') stack.push(node[k]);
    }
    return null;
  }

  // Newest post time on a page (tweets carry full_text or conversation_id_str; users don't).
  function newestTweetTime(json) {
    let newest = 0;
    let count = 0;
    const stack = [json];
    while (stack.length) {
      const node = stack.pop();
      if (!node || typeof node !== 'object') continue;
      if (typeof node.created_at === 'string' && ('full_text' in node || 'conversation_id_str' in node)) {
        const t = Date.parse(node.created_at);
        if (t) { newest = Math.max(newest, t); count++; }
      }
      for (const k in node) if (node[k] && typeof node[k] === 'object') stack.push(node[k]);
    }
    return { newest, count };
  }

  function remember(url, method, headers, text) {
    if (!isX || (method || 'GET').toUpperCase() !== 'GET') return;
    const name = opName(url);
    if (!name || typeof text !== 'string' || text.indexOf('"cursorType"') === -1) return;
    templates.set(name, { url, headers: plainHeaders(headers) });
    try {
      const cursor = bottomCursor(JSON.parse(text));
      if (cursor) cursors.set(name, cursor);
    } catch (_) { /* ignore */ }
  }

  function withCursor(url, cursor) {
    const u = new URL(url);
    const vars = u.searchParams.get('variables');
    if (vars) {
      const v = JSON.parse(vars);
      v.cursor = cursor;
      u.searchParams.set('variables', JSON.stringify(v));
    } else {
      u.searchParams.set('cursor', cursor);
    }
    return u.href;
  }

  let pagingStopped = false;
  let pagingPaused = false;
  let pagingRun = 0; // a newer paginate command ends the loop of an older one

  function reply(msg) {
    window.postMessage(Object.assign({ __sit: 'pager' }, msg), location.origin);
  }

  async function paginate(cmd) {
    const run = ++pagingRun;
    pagingStopped = false;
    pagingPaused = false;
    const name = (cmd.names || []).find((n) => templates.has(n) && cursors.has(n));
    if (!name) return reply({ id: cmd.id, done: true, ok: false, pages: 0, reason: 'no-template' });
    const tpl = templates.get(name);
    let cursor = cursors.get(name);
    const maxPages = Math.min(Number(cmd.maxPages) || 40, 200);
    let pages = 0;
    let reason = 'max';
    for (; pages < maxPages; pages++) {
      // A paused scan keeps its place (the cursor) and carries on from the same page.
      while (pagingPaused && !pagingStopped && run === pagingRun) await new Promise((r) => setTimeout(r, 300));
      if (pagingStopped || run !== pagingRun) { reason = 'stopped'; break; }
      let text;
      try {
        const res = await origFetch.call(window, withCursor(tpl.url, cursor), { method: 'GET', headers: tpl.headers, credentials: 'include' });
        if (!res.ok) { reason = 'http-' + res.status; break; }
        text = await res.text();
      } catch (e) {
        reason = 'error';
        break;
      }
      emit(tpl.url, text);
      let json;
      try { json = JSON.parse(text); } catch (_) { reason = 'bad-json'; break; }
      const next = bottomCursor(json);
      const { newest, count } = newestTweetTime(json);
      reply({ id: cmd.id, done: false, page: pages + 1, newest });
      if (!next || next === cursor || count === 0) { pages++; reason = 'end'; break; }
      if (newest && newest < cmd.cutoff) { pages++; reason = 'cutoff'; break; }
      cursor = next;
      cursors.set(name, next);
      await new Promise((r) => setTimeout(r, Math.max(150, Number(cmd.delayMs) || 350)));
    }
    reply({ id: cmd.id, done: true, ok: pages > 0, pages, reason, op: name });
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window || !event.data || event.data.__sit !== 'cmd') return;
    if (event.data.op === 'paginate') paginate(event.data);
    else if (event.data.op === 'stop') pagingStopped = true;
    else if (event.data.op === 'pause') pagingPaused = true;
    else if (event.data.op === 'resume') pagingPaused = false;
  });

  // ---------- hooks ----------

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (...args) {
      const promise = origFetch.apply(this, args);
      try {
        const url = urlOf(args[0]);
        if (wanted(url)) {
          const init = args[1] || {};
          const method = init.method || (args[0] && args[0].method) || 'GET';
          const headers = init.headers || (args[0] && args[0].headers);
          promise.then((res) => {
            if (res && res.ok) {
              res.clone().text().then((t) => {
                remember(url, method, headers, t);
                emit(url, t);
              }, () => {});
            }
          }, () => {});
        }
      } catch (_) { /* never break the site */ }
      return promise;
    };
  }

  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    const origSetHeader = XHR.setRequestHeader;
    XHR.open = function (method, url) {
      try {
        this.__sitUrl = urlOf(String(url));
        this.__sitMethod = method;
        this.__sitHeaders = {};
      } catch (_) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XHR.setRequestHeader = function (name, value) {
      try { if (this.__sitHeaders) this.__sitHeaders[name] = value; } catch (_) { /* ignore */ }
      return origSetHeader.apply(this, arguments);
    };
    XHR.send = function () {
      try {
        if (wanted(this.__sitUrl)) {
          this.addEventListener('load', function () {
            try {
              if (this.status < 200 || this.status >= 300) return;
              let text = null;
              if (this.responseType === '' || this.responseType === 'text') text = this.responseText;
              else if (this.responseType === 'json' && this.response) text = JSON.stringify(this.response);
              if (text == null) return;
              remember(this.__sitUrl, this.__sitMethod, this.__sitHeaders, text);
              emit(this.__sitUrl, text);
            } catch (_) { /* ignore */ }
          });
        }
      } catch (_) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }
})();
