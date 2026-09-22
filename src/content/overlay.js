// Small floating card shown on LinkedIn / X while a guided scan runs.
(function (root) {
  'use strict';
  const SIT = root.SIT || (root.SIT = {});

  const CSS = `
    :host { all: initial; }
    .card {
      --surface: #fcfcfb; --ink: #0b0b0b; --ink-2: #52514e; --muted: #898781;
      --line: #e1e0d9; --accent: #2a78d6; --ring: rgba(11,11,11,0.10);
      --warn-bg: #fff6df; --warn-line: #ecd08a;
      position: fixed; right: 20px; bottom: 20px; z-index: 2147483646;
      width: 300px; box-sizing: border-box; padding: 14px 16px;
      background: var(--surface); color: var(--ink);
      border-radius: 14px; box-shadow: 0 0 0 1px var(--ring), 0 12px 32px rgba(0,0,0,0.18);
      font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    @media (prefers-color-scheme: dark) {
      .card { --surface: #1a1a19; --ink: #ffffff; --ink-2: #c3c2b7; --line: #2c2c2a;
        --accent: #3987e5; --ring: rgba(255,255,255,0.10); --warn-bg: #33290f; --warn-line: #6b5518; }
    }
    .head { display: flex; align-items: center; gap: 8px; }
    .dot { width: 8px; height: 8px; border-radius: 50%; background: var(--accent); flex: none; }
    .card.running .dot { animation: pulse 1.2s ease-in-out infinite; }
    @keyframes pulse { 50% { opacity: .35; } }
    .title { font-weight: 600; flex: 1; }
    .close { all: unset; cursor: pointer; color: var(--muted); font-size: 18px; line-height: 1;
      width: 22px; height: 22px; text-align: center; border-radius: 6px; }
    .close:hover { background: var(--line); color: var(--ink); }
    .close:focus-visible, .stop:focus-visible, .pause:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
    p { margin: 6px 0 0; color: var(--ink-2); }
    .count { color: var(--ink); font-weight: 600; }
    .bar { height: 4px; margin-top: 10px; background: var(--line); border-radius: 4px; overflow: hidden; }
    .bar span { display: block; height: 100%; width: 0; background: var(--accent); border-radius: 4px;
      transition: width .4s ease; }
    .notice { margin-top: 10px; padding: 7px 9px; border-radius: 8px; font-size: 12px; line-height: 1.4;
      color: var(--ink); background: var(--warn-bg); box-shadow: inset 0 0 0 1px var(--warn-line); }
    .card.paused .dot { animation: none; background: var(--muted); }
    .card.paused .bar span { background: var(--muted); }
    .actions { margin-top: 10px; display: flex; justify-content: flex-end; gap: 8px; }
    .stop, .pause { all: unset; cursor: pointer; padding: 5px 12px; border-radius: 8px; font-weight: 500;
      color: var(--ink); box-shadow: inset 0 0 0 1px var(--line); }
    .stop:hover, .pause:hover { background: var(--line); }
    .pause { background: var(--ink); color: var(--surface); box-shadow: none; }
    .pause:hover { background: var(--ink-2); }
    [hidden] { display: none !important; }
  `;

  let host = null;
  let els = null;
  let stopHandler = null;
  let pauseHandler = null;
  let pausedText = '';
  let finished = false;
  let dismissed = false; // closed with ×: later updates don't bring the card back

  function ensure() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'sit-overlay';
    const shadow = host.attachShadow({ mode: 'closed' });
    const style = document.createElement('style');
    style.textContent = CSS;
    // Built with DOM calls (no innerHTML) so sites enforcing Trusted Types don't block it.
    const make = (tag, cls, text) => {
      const node = document.createElement(tag);
      if (cls) node.className = cls;
      if (text) node.textContent = text;
      return node;
    };
    const card = make('div', 'card');
    card.setAttribute('role', 'status');
    card.setAttribute('aria-live', 'polite');
    const head = make('div', 'head');
    const close = make('button', 'close', '×');
    close.setAttribute('aria-label', 'Close');
    els = {
      card,
      title: make('span', 'title'),
      line1: make('p', 'line1'),
      line2: make('p', 'line2'),
      notice: make('p', 'notice'),
      bar: make('div', 'bar'),
      fill: make('span'),
      actions: make('div', 'actions'),
      pause: make('button', 'pause', 'Pause'),
      stop: make('button', 'stop', 'Stop scan'),
      close,
    };
    head.append(make('span', 'dot'), els.title, close);
    els.bar.appendChild(els.fill);
    els.actions.append(els.pause, els.stop);
    els.notice.hidden = true;
    card.append(head, els.line1, els.line2, els.bar, els.notice, els.actions);
    shadow.append(style, card);
    els.stop.addEventListener('click', () => { if (stopHandler) stopHandler(); });
    els.pause.addEventListener('click', () => { if (pauseHandler) pauseHandler(); });
    els.close.addEventListener('click', () => {
      if (els.card.classList.contains('running') && stopHandler) stopHandler();
      dismissed = true;
      hide();
    });
    (document.body || document.documentElement).appendChild(host);
  }

  function update(opts) {
    if (dismissed) return;
    ensure();
    if (opts.title != null) els.title.textContent = opts.title;
    if (opts.line1 != null) els.line1.textContent = opts.line1;
    if (opts.line2 != null && !pausedText) els.line2.textContent = opts.line2;
    if (opts.progress != null) els.fill.style.width = Math.round(Math.min(1, Math.max(0, opts.progress)) * 100) + '%';
    if (opts.notice != null) {
      els.notice.textContent = opts.notice;
      els.notice.hidden = !opts.notice;
    }
    if (opts.onStop) stopHandler = opts.onStop;
    if (opts.onPause) pauseHandler = opts.onPause;
  }

  function show(opts) {
    if (dismissed) return;
    update(opts);
    finished = false;
    els.card.classList.add('running');
    els.actions.hidden = false;
    els.bar.hidden = false;
    if (pausedText) els.line2.textContent = pausedText;
  }

  // A paused scan keeps its card and progress; the Pause button becomes Resume.
  function setPaused(paused, text) {
    if (dismissed) return;
    ensure();
    pausedText = paused ? text || 'Paused.' : '';
    els.card.classList.toggle('paused', !!paused);
    els.pause.textContent = paused ? 'Resume' : 'Pause';
    if (paused) els.line2.textContent = pausedText;
    else els.line2.textContent = 'Continuing…';
  }

  function finish(opts) {
    finished = true;
    if (dismissed) return;
    pausedText = '';
    update(Object.assign({ notice: '' }, opts));
    finished = true;
    els.card.classList.remove('running', 'paused');
    els.actions.hidden = true;
    els.bar.hidden = true;
    stopHandler = null;
    pauseHandler = null;
  }

  function hide() {
    if (host) host.remove();
    host = null;
    els = null;
  }

  SIT.overlay = { show, update, finish, hide, setPaused, isFinished: () => finished };
})(typeof globalThis !== 'undefined' ? globalThis : this);
