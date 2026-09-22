// Shared content-script plumbing: messaging, batched saving, and the guided scan loop.
(function (root) {
  'use strict';
  const SIT = root.SIT || (root.SIT = {});

  SIT.send = function send(msg) {
    try {
      return chrome.runtime.sendMessage(msg).catch(() => null);
    } catch (_) {
      // Extension was reloaded; this old content script is orphaned.
      return Promise.resolve(null);
    }
  };

  // Asked once per page load: is a scan running in this tab, and does the extension want
  // to know which posts you comment on while you browse ("track")? Nothing is added to
  // your stats outside a scan.
  let hello = null;
  SIT.hello = function () {
    if (!hello) hello = SIT.send({ type: 'scan:hello' }).then((r) => r || { task: null, track: false });
    return hello;
  };

  SIT.onReady = function onReady(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn, { once: true });
    else fn();
  };

  // Tracks what this page session has collected, for scan progress + stop rules.
  SIT.createSession = function createSession() {
    const ids = new Set();
    let times = [];
    return {
      add(records) {
        for (const r of records) {
          if (ids.has(r.id)) continue;
          ids.add(r.id);
          if (typeof r.createdAt === 'number') times.push(r.createdAt);
        }
      },
      count() { return ids.size; },
      drainTimes() { const t = times; times = []; return t; },
    };
  };

  // Batches records and only re-sends items whose data changed. Records are only saved
  // while a scan runs in this tab (mode "scan"). In "track" mode only your own comments and
  // replies are passed along (so posts you already commented on can be recognised); in
  // "off" mode everything is dropped. Until the mode is known, records wait in the queue.
  SIT.createSaver = function createSaver(session) {
    let queue = new Map();
    const sent = new Map();
    let timer = null;
    let mode = 'unknown';

    const signature = (r) => [r.kind, r.direction, r.impressions, r.replies, r.likes, (r.text || '').length, r.createdAt,
      r.threadRef, r.onMyPost, r.confidence].join('|');
    const isActivity = (r) => r.direction === 'mine' && (r.kind === 'comment' || r.kind === 'reply');

    function setMode(next) {
      mode = next;
      if (mode === 'off') queue = new Map();
      else if (queue.size && !timer) timer = setTimeout(flush, 1200);
    }

    function push(records) {
      if (!records || !records.length || mode === 'off') return;
      if (mode === 'track') records = records.filter(isActivity);
      else if (session) session.add(records.filter((r) => r.kind));
      for (const r of records) {
        if (sent.get(r.id) === signature(r)) continue;
        // Merge with anything already queued so a partial update never drops fields.
        const merged = Object.assign({}, queue.get(r.id));
        for (const k of Object.keys(r)) if (r[k] != null) merged[k] = r[k];
        queue.set(r.id, merged);
      }
      if (queue.size && !timer && mode !== 'unknown') timer = setTimeout(flush, 1200);
    }

    async function flush() {
      clearTimeout(timer);
      timer = null;
      if (!queue.size || mode === 'unknown') return;
      let batch = Array.from(queue.values());
      queue = new Map();
      if (mode === 'track') batch = batch.filter(isActivity);
      if (mode === 'off' || !batch.length) return;
      for (const r of batch) sent.set(r.id, signature(r));
      await SIT.send({ type: mode === 'scan' ? 'records:upsert' : 'activity:seen', records: batch });
    }

    return { push, flush, setMode, mode: () => mode };
  };

  SIT.waitFor = async function waitFor(fn, timeoutMs, intervalMs) {
    const until = Date.now() + (timeoutMs || 10000);
    for (;;) {
      let value = null;
      try { value = await fn(); } catch (_) { value = null; }
      if (value) return value;
      if (Date.now() > until) return null;
      await SIT.sleep(intervalMs || 400);
    }
  };

  function samePath(url) {
    const norm = (p) => {
      try { p = decodeURIComponent(p); } catch (_) { /* keep raw */ }
      return p.replace(/\/+$/, '').toLowerCase();
    };
    try {
      const target = new URL(url);
      // Two comment threads of one post share the path and differ only in ?commentUrn=…
      const thread = target.searchParams.get('commentUrn');
      if (thread && thread !== new URL(location.href).searchParams.get('commentUrn')) return false;
      return norm(target.pathname) === norm(location.pathname);
    } catch (_) {
      return false;
    }
  }

  // LinkedIn's 2026 layout scrolls an inner <main id="workspace"> instead of the window.
  let scroller = null;
  function findScroller() {
    const scrollable = (el) => el && el.isConnected && el.scrollHeight > el.clientHeight + 50;
    if (scroller && scrollable(scroller)) return scroller;
    const root = document.scrollingElement || document.documentElement;
    if (scrollable(root)) return (scroller = root);
    const overflows = (el) => scrollable(el) && /(auto|scroll)/.test(getComputedStyle(el).overflowY);
    let best = null;
    for (const el of document.querySelectorAll('main#workspace, main')) {
      if (overflows(el) && (!best || el.scrollHeight > best.scrollHeight)) best = el;
    }
    return (scroller = best || root);
  }

  // Scrolls until the feed ends, only items older than the cutoff keep arriving,
  // or the user stops the scan. Instead of sleeping a fixed time after each scroll,
  // it moves on as soon as new content shows up. A paused scan waits between rounds.
  async function autoScroll({ session, cutoffTs, shouldStop, whilePaused, onTick, beforeScroll, maxRounds }) {
    const MAX_ROUNDS = maxRounds || 250;
    let idle = 0;
    let oldRounds = 0;
    for (let round = 0; round < MAX_ROUNDS; round++) {
      if (whilePaused) await whilePaused();
      if (shouldStop()) return 'stopped';
      if (beforeScroll) await beforeScroll();
      const beforeCount = session.count();
      const beforeHeight = findScroller().scrollHeight;
      const el = findScroller();
      el.scrollTop = el.scrollHeight;

      const grew = await SIT.waitFor(
        () => session.count() > beforeCount || findScroller().scrollHeight > beforeHeight + 20,
        2500, 150);
      if (grew) await SIT.sleep(250);

      const times = session.drainTimes();
      if (onTick) onTick({ round, count: session.count() });

      if (times.length >= 2 && times.every((t) => t < cutoffTs)) {
        if (++oldRounds >= 2) return 'cutoff';
      } else if (times.length) {
        oldRounds = 0;
      }
      if (!grew && session.count() === beforeCount) {
        if (++idle >= 3) return 'end';
      } else {
        idle = 0;
      }
    }
    return 'max';
  }

  const TAB_NOTICE = 'Please stay on this tab until the scan finishes. Switching tabs can lead to incomplete or misleading stats, so the scan pauses while this tab isn’t in front.';
  const PAUSED_TEXT = 'Paused. Resume continues from where the scan left off.';
  const AUTO_PAUSED_TEXT = 'Paused because this tab isn’t in front. Come back to this tab and the scan continues.';

  // Decides what this tab does and returns it: 'scan' (a scan runs here), 'track' or 'off'.
  SIT.startTab = async function startTab(adapter) {
    const info = await SIT.hello();
    const idle = info.track ? 'track' : 'off';
    if (!info.task) {
      adapter.saver.setMode(idle);
      return idle;
    }
    adapter.saver.setMode('scan');
    runScan(adapter, info.task)
      .catch((err) => {
        SIT.send({ type: 'scan:fail', message: 'The scan hit an unexpected problem (' + String((err && err.message) || err) + '). Run it again.' });
        SIT.overlay.finish({ title: 'Scan stopped', line1: 'The scan hit an unexpected problem. Run it again.', line2: '' });
      })
      .then(() => adapter.saver.setMode(idle));
    return 'scan';
  };

  // adapter: { platform, label, steps: { [id]: { label, url(me, arg), rounds?, run?(ctx), after?(ctx) } },
  //            waitForMe(ms), session, saver, parseNow?(), settle?(), ready?(step), softNavigate?(url),
  //            onStop?(), onPause?(), onResume?() }
  // A step id may carry an argument after a pipe, e.g. "li:post|activity:123".
  // step.run can replace scrolling (return true when it handled the step).
  async function runScan(adapter, task) {
    let stopped = false;
    let paused = false;
    let pausedSince = 0;
    let pausedMs = task.pausedMs || 0;
    let leaving = false;

    const setPaused = (value, auto) => {
      if (stopped || paused === value) return;
      paused = value;
      if (value) {
        pausedSince = Date.now();
        if (adapter.onPause) adapter.onPause();
        adapter.saver.flush();
      } else {
        pausedMs += Date.now() - pausedSince;
        if (adapter.onResume) adapter.onResume();
      }
      SIT.overlay.setPaused(value, auto ? AUTO_PAUSED_TEXT : PAUSED_TEXT);
    };
    const whilePaused = async () => { while (paused && !stopped) await SIT.sleep(300); };

    // Save what's on the page before the scan is closed, so the scan's stats include it.
    const saveNow = async () => {
      try { if (adapter.parseNow) adapter.parseNow(); } catch (_) { /* keep going */ }
      await adapter.saver.flush();
    };
    const stop = () => {
      if (stopped) return;
      stopped = true;
      if (adapter.onStop) adapter.onStop();
      saveNow().then(() => SIT.send({ type: 'scan:stop' }));
    };
    const togglePause = () => SIT.send({ type: paused ? 'scan:resume' : 'scan:pause' });

    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg || typeof msg.type !== 'string') return false;
      if (msg.type === 'scan:stopped') {
        const first = !stopped;
        stopped = true;
        if (first && adapter.onStop) adapter.onStop();
        if (msg.moved) SIT.overlay.finish({ title: 'Scan moved', line1: 'This scan continues in another tab.', line2: '' });
        saveNow().then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg.type === 'scan:paused') {
        setPaused(true, !!msg.auto);
        if (msg.auto && document.visibilityState === 'visible') SIT.send({ type: 'scan:resume', auto: true });
        adapter.saver.flush().then(() => sendResponse({ ok: true }));
        return true;
      }
      if (msg.type === 'scan:resumed' && !stopped) {
        setPaused(false);
        sendResponse({ ok: true });
      }
      return false;
    });

    // Leaving the tab pauses the scan; coming back resumes it. The short wait ignores the
    // page's own unload when the scan moves to its next page.
    document.addEventListener('visibilitychange', () => {
      if (stopped || leaving) return;
      if (document.visibilityState === 'hidden') {
        setTimeout(() => {
          if (!stopped && !leaving && !paused && document.visibilityState === 'hidden') SIT.send({ type: 'scan:pause', auto: true });
        }, 700);
      } else if (paused) {
        SIT.send({ type: 'scan:resume', auto: true });
      }
    });

    // A scan page that loads in the background (you switched away while it opened) waits too.
    setTimeout(() => {
      if (!stopped && !leaving && !paused && document.visibilityState === 'hidden') SIT.send({ type: 'scan:pause', auto: true });
    }, 700);

    // The background answers a step change with the scan (more steps), null (finished) or
    // something else when it couldn't be reached or the scan is no longer this tab's.
    const advance = async (count) => {
      const next = await SIT.send({ type: 'scan:advance', found: count });
      if (next && Array.isArray(next.steps)) return next;
      const state = next === null ? await SIT.send({ type: 'scan:status' }) : null;
      return state && state.status === 'done' ? null : 'lost';
    };
    const lost = () => {
      stopped = true;
      SIT.overlay.finish({ title: 'Scan stopped', line1: 'This tab lost touch with the scan. What was collected is saved.', line2: 'Click the Profile Lens icon to check.' });
    };

    const shouldStop = () => stopped;
    let found = task.found || 0;
    const startedAt = task.startedAt || Date.now();
    let lastReport = 0;
    const report = (progress, items, force) => {
      const now = Date.now();
      if (!force && now - lastReport < 1000) return;
      lastReport = now;
      SIT.send({ type: 'scan:progress', progress, found: items });
    };

    if (task.status === 'paused') setPaused(true, !!task.autoPaused);

    while (task) {
      const stepId = task.steps[task.index];
      const [stepName, stepArg] = String(stepId).split('|');
      const step = adapter.steps[stepName];
      const stepText = 'Step ' + (task.index + 1) + ' of ' + task.steps.length + ': ' + (step ? step.label : stepId);
      SIT.overlay.show({
        title: 'Profile Lens · Scanning ' + adapter.label + (task.rangeLabel ? ' (' + task.rangeLabel + ')' : ''),
        line1: stepText,
        line2: 'Finding your account…',
        notice: TAB_NOTICE,
        progress: task.index / task.steps.length,
        onStop: stop,
        onPause: togglePause,
      });
      await whilePaused();
      if (stopped) break;
      if (!step) {
        task = await advance(0);
        if (task === 'lost') return lost();
        continue;
      }

      const me = await adapter.waitForMe(20000);
      if (!me) {
        const message = "Couldn't detect your " + adapter.label + ' account. Make sure you are signed in, or enter it in the extension settings.';
        await SIT.send({ type: 'scan:fail', message });
        SIT.overlay.finish({ title: 'Scan stopped', line1: message, line2: '' });
        return;
      }

      const url = step.url(me, stepArg);
      if (!samePath(url)) {
        const res = await SIT.send({ type: 'scan:navigate', index: task.index });
        if (!res || !res.ok) {
          task = await advance(0);
          if (task === 'lost') return lost();
          if (!task) SIT.overlay.finish({ title: 'Scan finished', line1: 'The page kept redirecting, so this step was skipped.', line2: '' });
          continue;
        }
        await adapter.saver.flush();
        if (!(adapter.softNavigate && await adapter.softNavigate(url))) {
          leaving = true;
          location.assign(url);
          return;
        }
      }

      const startCount = adapter.session.count();
      const stepTask = task;
      const update = (line2) => SIT.overlay.update({ line2 });
      const tick = ({ count }) => {
        const progress = (stepTask.index + Math.min(0.9, (count - startCount) / 400)) / stepTask.steps.length;
        SIT.overlay.update({
          line1: stepText,
          line2: 'Found ' + (found + count - startCount) + ' items so far',
          progress,
        });
        report(progress, found + count - startCount);
      };
      tick({ count: startCount });
      report(task.index / task.steps.length, found, true);
      if (adapter.ready) await adapter.ready(step, stepArg);
      else await SIT.sleep(1200);

      const ctx = { task, arg: stepArg, shouldStop, whilePaused, update, tick, cutoffTs: task.cutoffTs };
      adapter.control = { shouldStop, whilePaused, isPaused: () => paused };
      const handled = step.run ? await step.run(ctx) : false;
      if (!handled && step.rounds !== 0) {
        await autoScroll({
          session: adapter.session,
          cutoffTs: task.cutoffTs,
          shouldStop,
          whilePaused,
          onTick: tick,
          beforeScroll: adapter.beforeScroll,
          maxRounds: step.rounds,
        });
      }
      await whilePaused();
      if (!stopped && step.after) await step.after(ctx);
      if (!stopped && adapter.parseNow) adapter.parseNow();
      if (!stopped && adapter.settle) {
        update('Checking impression counts…');
        await adapter.settle();
      }
      if (!stopped) await adapter.saver.flush();
      await whilePaused();

      const stepFound = adapter.session.count() - startCount;
      found += stepFound;
      if (stopped) break;
      task = await advance(stepFound);
      if (task === 'lost') return lost();
      if (!task) {
        stopped = true; // nothing left to pause or stop
        SIT.overlay.finish({
          title: adapter.label + ' scan complete',
          line1: 'Collected ' + found + ' items in ' + SIT.formatDuration(Date.now() - startedAt - pausedMs) + '.',
          line2: 'Click the Profile Lens icon to see your impressions.',
        });
        return;
      }
    }
    if (!SIT.overlay.isFinished()) {
      SIT.overlay.finish({
        title: 'Scan stopped',
        line1: 'Saved ' + found + ' items. Your stats so far are in the Scans tab.',
        line2: 'Click the Profile Lens icon to see them.',
      });
    }
  }
})(typeof globalThis !== 'undefined' ? globalThis : this);
