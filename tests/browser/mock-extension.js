// Minimal fake of the chrome.* APIs a content script uses. Every message the
// script sends to the background is recorded in window.__messages.
(function () {
  'use strict';
  window.__messages = [];
  // Records are only saved in a scan tab. A paused scan keeps the page in scan mode without
  // moving it to another URL. ?idle = no scan, ?track = no scan but own comments are reported.
  const mode = /[?&]idle\b/.test(location.search) ? 'idle' : /[?&]track\b/.test(location.search) ? 'track' : 'scan';
  window.__mode = mode;
  window.__hello = mode === 'scan'
    ? { task: { platform: 'test', status: 'paused', steps: ['test:hold'], index: 0, found: 0 }, track: false }
    : { task: null, track: mode === 'track' };
  window.__storage = { settings: {}, identity: {}, records: {} };
  window.chrome = {
    runtime: {
      sendMessage(msg) {
        window.__messages.push(JSON.parse(JSON.stringify(msg)));
        if (msg.type === 'scan:get') return Promise.resolve(null);
        if (msg.type === 'scan:hello') return Promise.resolve(window.__hello);
        return Promise.resolve({ ok: true });
      },
      // Like Chrome: every listener gets the message; true means "I'll answer later".
      onMessage: { addListener(fn) {
        window.__listeners = (window.__listeners || []).concat(fn);
        window.__onMessage = (msg, sender, reply) => window.__listeners.map((l) => l(msg, sender, reply)).some((r) => r === true);
      } },
    },
    storage: {
      local: {
        get(keys) {
          const out = {};
          for (const k of [].concat(keys)) if (k in window.__storage) out[k] = window.__storage[k];
          return Promise.resolve(out);
        },
      },
    },
  };

  window.__upserted = function (type) {
    const byId = {};
    for (const m of window.__messages) {
      if (m.type !== (type || 'records:upsert')) continue;
      for (const r of m.records) byId[r.id] = Object.assign(byId[r.id] || {}, r);
    }
    return byId;
  };

  window.__report = function (checks) {
    const failed = checks.filter((c) => JSON.stringify(c.actual) !== JSON.stringify(c.expected));
    const out = document.getElementById('out');
    for (const c of checks) {
      const ok = !failed.includes(c);
      const line = document.createElement('div');
      line.style.color = ok ? '#006300' : '#d03b3b';
      line.textContent = (ok ? '✔ ' : '✖ ') + c.name + (ok ? '' : ' — expected ' + JSON.stringify(c.expected) + ', got ' + JSON.stringify(c.actual));
      out.appendChild(line);
    }
    window.__results = { passed: checks.length - failed.length, total: checks.length, failed };
  };
})();
