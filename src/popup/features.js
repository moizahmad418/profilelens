// The Insights tab, the weekly digest, goals and streaks, period deltas, follower change,
// "Why?" on a post, the comment check, the first-run tour, the Features page, backup and
// restore, accounts, automatic scans and reminders. popup.js draws the dashboard and hands
// this file its state and helpers through SIT.popup.
(function () {
  'use strict';
  const SIT = globalThis.SIT;
  const F = (SIT.features = {});
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';
  let B = null; // the bridge from popup.js: { state, el, plural, meter, openUrl, render, showView, renderFooter, download, loadData, nowTs, dataRecords }
  const VERSION = chrome.runtime.getManifest().version;
  const KINDS = ['post', 'comment', 'reply'];
  const KIND_WORD = { post: 'posts', comment: 'comments', reply: 'replies' };
  const PLATFORM_NAME = { linkedin: 'LinkedIn', x: 'X' };
  const DAY = 24 * 3600e3;

  // Everything the extension does, in one list: the Features page and the last tour screen.
  const FEATURES = [
    { where: 'Dashboard', name: 'Impressions by range', text: 'Posts, comments and replies totalled for 1D, 3D, 7D, 10D, 30D or a month, with a change against the period before.' },
    { where: 'Dashboard', name: 'This week', text: 'Your weekly goals for posts, comments and replies, how far you are, and your streak of weeks that met them.' },
    { where: 'Dashboard', name: 'Weekly digest', text: 'Every week, a card with last week’s total, best and worst post, follower change and replies waiting. Share it as an image.' },
    { where: 'Dashboard', name: 'Why?', text: 'On any post: how it compares with your usual, and whether its time, type or length explains it.' },
    { where: 'Dashboard', name: 'Needs reply', text: 'Who answered you and how long they have been waiting, plus how fast you usually reply.' },
    { where: 'Dashboard', name: 'Follower change', text: 'How many followers you gained or lost in the period shown.' },
    { where: 'Insights', name: 'Best time to post', text: 'A weekday-by-hour grid of your average impressions, with your best slot in one sentence.' },
    { where: 'Insights', name: 'Post types', text: 'Text, image, video, document, link, poll, quote and carousel posts compared.' },
    { where: 'Insights', name: 'Length and hooks', text: 'Post length, first-line length, hashtags and questions against your impressions.' },
    { where: 'Insights', name: 'Engagement return', text: 'Whose posts your comments earn the most impressions on.' },
    { where: 'Insights', name: 'Top supporters', text: 'The people who comment and reply on your content most often.' },
    { where: 'Insights', name: 'Follower trend', text: 'Your follower count over time, from each scan.' },
    { where: 'Insights', name: 'Comment check', text: 'Paste a comment before posting it: it flags stock phrases, very short comments and near-repeats of your earlier ones.' },
    { where: 'Scans', name: 'Scan, pause, resume', text: 'Scan the range picked on the Dashboard, pause and resume, and open any past scan exactly as it was.' },
    { where: 'Scans', name: 'Automatic scans', text: 'A daily scan at a time you pick, in a small window that closes by itself.' },
    { where: 'Settings', name: 'Reminders', text: 'A notification when someone has waited for your reply longer than a set number of hours.' },
    { where: 'Settings', name: 'Backup and restore', text: 'Save everything to a file and load it into another browser or a newer version.' },
    { where: 'Settings', name: 'Accounts', text: 'Stats of different LinkedIn or X accounts stay apart; remove any account’s data.' },
    { where: 'Settings', name: 'Export', text: 'CSV and JSON of your items, with their impression level.' },
  ];

  const WHATS_NEW = [
    'Insights tab: best time to post, post types, length and hooks, engagement return, top supporters, follower trend.',
    'Dashboard: change against the previous period, weekly goals and streaks, the weekly digest, “Why?” on every post, waiting times on Needs reply, follower change.',
    'Scans: automatic daily scans. Settings: reminders, backup and restore, accounts.',
    'LinkedIn scans now also work in Spanish, French, German, Portuguese, Italian, Dutch and Turkish.',
  ];

  // ---------- small helpers ----------

  const el = (tag, cls, text) => B.el(tag, cls, text);
  const svg = (tag, attrs) => { const n = document.createElementNS(NS, tag); for (const k in attrs) n.setAttribute(k, attrs[k]); return n; };
  const fmt = (v) => SIT.formatCompact(v);
  const full = (v) => SIT.formatFull(v);
  const state = () => B.state;
  const ui = () => state().ui || (state().ui = {});
  function saveUi(patch) {
    Object.assign(ui(), patch);
    chrome.storage.local.set({ ui: ui() });
  }
  function saveSettings(patch) {
    state().settings = Object.assign({}, state().settings, patch);
    chrome.storage.local.set({ settings: state().settings });
    chrome.runtime.sendMessage({ type: 'settings:changed' }).catch(() => {});
  }
  const durationText = (ms) => {
    if (ms == null) return '';
    const h = ms / 3600e3;
    if (h < 1) return Math.max(1, Math.round(ms / 60e3)) + ' min';
    if (h < 48) return Math.round(h) + 'h';
    return Math.round(h / 24) + 'd';
  };
  function deltaChip(ratio, title) {
    const chip = el('span', 'delta ' + (ratio == null ? 'new' : ratio > 0.005 ? 'up' : ratio < -0.005 ? 'down' : 'flat'));
    chip.textContent = ratio == null ? 'new' : ratio > 0.005 ? '↑ ' + Math.round(ratio * 100) + '%' : ratio < -0.005 ? '↓ ' + Math.round(-ratio * 100) + '%' : '→ same';
    if (title) chip.title = title;
    return chip;
  }
  function periodWord() {
    const r = state().range;
    if (r.type === 'month') return 'the month before';
    return r.days === 1 ? 'yesterday' : 'the ' + r.days + ' days before';
  }

  // ---------- dashboard: deltas, week strip, digest, followers, what's new ----------

  F.onRender = function onRender(summary) {
    if (!B) return;
    const st = state();
    const records = B.dataRecords();
    const now = B.nowTs();
    // 4. change against the previous period
    const prev = SIT.insights.previousRange(st.range, now);
    const before = SIT.stats.summarize(records, { platform: st.platform, range: prev.range }, prev.now);
    const d = SIT.insights.deltas(summary, before);
    for (const k of KINDS) {
      const box = $('kpi-' + k + '-delta');
      box.textContent = '';
      if (!summary.mine[k].count && !before.mine[k].count) continue;
      box.appendChild(deltaChip(d[k].impressions, full(before.mine[k].impressions) + ' impressions ' + periodWord()));
    }
    renderWeekStrip();
    renderDigest();
    renderFollowersLine(summary);
    renderWhatsNew();
  };

  function renderWeekStrip() {
    const st = state();
    const strip = $('week-strip');
    const goals = st.settings.goals || {};
    const set = KINDS.filter((k) => Number(goals[k]) > 0);
    strip.hidden = !!st.snapshot || !set.length;
    if (strip.hidden) return;
    const p = SIT.insights.goalProgress(B.dataRecords(), goals, B.nowTs(), st.platform);
    strip.textContent = '';
    const head = el('div', 'week-head');
    head.appendChild(el('b', null, 'This week'));
    head.appendChild(el('span', 'week-days', p.daysLeft === 1 ? 'last day' : p.daysLeft + ' days left'));
    if (p.streak) {
      const s = el('span', 'streak', '🔥 ' + p.streak + '-week streak');
      s.title = p.met ? 'This week counts already.' : 'Meet this week’s goals to keep it going.';
      head.appendChild(s);
    } else if (p.met) head.appendChild(el('span', 'streak', 'Goal met ✓'));
    strip.appendChild(head);
    const row = el('div', 'week-goals');
    for (const k of set) {
      const g = el('div', 'week-goal');
      const done = p.week[k] >= p.goals[k];
      g.appendChild(el('span', 'week-goal-text', p.week[k] + ' / ' + p.goals[k] + ' ' + KIND_WORD[k] + (done ? ' ✓' : '')));
      const bar = el('div', 'mini-bar');
      const fill = el('span');
      fill.style.width = Math.min(100, Math.round((p.week[k] / p.goals[k]) * 100)) + '%';
      if (done) fill.classList.add('done');
      bar.appendChild(fill);
      g.appendChild(bar);
      row.appendChild(g);
    }
    strip.appendChild(row);
  }

  function renderDigest() {
    const st = state();
    const card = $('digest-card');
    card.hidden = true;
    if (st.snapshot || !Object.keys(st.records).length) return;
    const dg = SIT.insights.digest(st.records, st.followers, Date.now(), 'all');
    if (dg.empty || ui().digestSeen === dg.key) return;
    card.hidden = false;
    card.textContent = '';
    const head = el('div', 'digest-head');
    head.appendChild(el('b', null, 'Your week: ' + SIT.formatDate(dg.start) + ' – ' + SIT.formatDate(dg.end - 1)));
    const close = el('button', 'icon-btn digest-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => { saveUi({ digestSeen: dg.key }); card.hidden = true; });
    head.appendChild(close);
    card.appendChild(head);
    const line = el('p', 'digest-line');
    line.appendChild(el('b', null, fmt(dg.total) + ' impressions'));
    line.appendChild(document.createTextNode(' '));
    line.appendChild(deltaChip(dg.totalChange, full(dg.prevTotal) + ' the week before'));
    line.appendChild(document.createTextNode(' · ' + dg.totals.post.count + ' posts, ' + dg.totals.comment.count + ' comments, ' + dg.totals.reply.count + ' replies · ' + dg.received + ' responses received'));
    card.appendChild(line);
    const ul = el('ul', 'digest-list');
    const item = (label, r) => {
      if (!r) return;
      const li = el('li');
      li.appendChild(el('span', 'digest-label', label));
      const a = el('a', null, '“' + SIT.truncate(r.text || '(no text)', 60) + '”');
      a.href = r.url || '#';
      a.addEventListener('click', (e) => { e.preventDefault(); B.openUrl(r.url); });
      li.appendChild(a);
      li.appendChild(el('span', 'digest-num', fmt(r.impressions)));
      ul.appendChild(li);
    };
    item('Best post', dg.best);
    item('Weakest post', dg.worst);
    const fl = [];
    for (const p of ['linkedin', 'x']) {
      const f = dg.followers[p];
      if (f && f.delta != null) fl.push(PLATFORM_NAME[p] + ' ' + (f.delta >= 0 ? '+' : '') + full(f.delta));
    }
    if (fl.length) { const li = el('li'); li.appendChild(el('span', 'digest-label', 'Followers')); li.appendChild(document.createTextNode(fl.join(' · '))); ul.appendChild(li); }
    if (dg.waiting) { const li = el('li'); li.appendChild(el('span', 'digest-label', 'Waiting')); li.appendChild(document.createTextNode(dg.waiting + ' waiting for your reply right now')); ul.appendChild(li); }
    card.appendChild(ul);
    const foot = el('div', 'btn-row');
    const share = el('button', 'btn btn-small', 'Share as image');
    share.type = 'button';
    share.addEventListener('click', () => shareDigest(dg));
    const ok = el('button', 'btn btn-small', 'Got it');
    ok.type = 'button';
    ok.addEventListener('click', () => { saveUi({ digestSeen: dg.key }); card.hidden = true; });
    foot.append(share, ok);
    card.appendChild(foot);
  }

  // A 1200×630 picture of the digest, drawn on a canvas and saved as PNG.
  function shareDigest(dg) {
    const W = 1200, H = 630;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, W, H);
    g.addColorStop(0, '#0b1a3a'); g.addColorStop(1, '#0a3d7a');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    ctx.fillStyle = '#ffffff';
    ctx.font = '600 30px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('My week on LinkedIn and X', 70, 90);
    ctx.font = '400 24px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#a9c6ea';
    ctx.fillText(SIT.formatDate(dg.start, true) + ' – ' + SIT.formatDate(dg.end - 1, true), 70, 130);
    ctx.fillStyle = '#ffffff';
    ctx.font = '700 96px "Segoe UI", system-ui, sans-serif';
    ctx.fillText(fmt(dg.total), 70, 250);
    ctx.font = '400 30px "Segoe UI", system-ui, sans-serif';
    ctx.fillStyle = '#a9c6ea';
    ctx.fillText('impressions' + (dg.totalChange != null ? ' · ' + (dg.totalChange >= 0 ? '↑ ' : '↓ ') + Math.round(Math.abs(dg.totalChange) * 100) + '% vs the week before' : ''), 70, 300);
    const rows = [
      [String(dg.totals.post.count), 'posts', fmt(dg.totals.post.impressions)],
      [String(dg.totals.comment.count), 'comments', fmt(dg.totals.comment.impressions)],
      [String(dg.totals.reply.count), 'replies', fmt(dg.totals.reply.impressions)],
    ];
    let y = 390;
    for (const [n, word, imp] of rows) {
      ctx.fillStyle = '#ffffff'; ctx.font = '600 34px "Segoe UI", system-ui, sans-serif'; ctx.fillText(n, 70, y);
      ctx.fillStyle = '#a9c6ea'; ctx.font = '400 26px "Segoe UI", system-ui, sans-serif'; ctx.fillText(word + ' · ' + imp + ' impressions', 140, y);
      y += 52;
    }
    if (dg.best) {
      ctx.fillStyle = '#ffffff'; ctx.font = '600 24px "Segoe UI", system-ui, sans-serif'; ctx.fillText('Best post · ' + fmt(dg.best.impressions), 640, 390);
      ctx.fillStyle = '#e6efff'; ctx.font = '400 22px "Segoe UI", system-ui, sans-serif';
      wrap(ctx, '“' + SIT.truncate(dg.best.text || '(no text)', 120) + '”', 640, 425, 480, 30);
    }
    ctx.fillStyle = '#7fb4ff'; ctx.font = '500 22px "Segoe UI", system-ui, sans-serif';
    ctx.fillText('Profile Lens · counted in my browser', 70, 585);
    c.toBlob((blob) => {
      const url = URL.createObjectURL(blob);
      const a = el('a'); a.href = url; a.download = 'profile-lens-week-' + new Date(dg.start).toISOString().slice(0, 10) + '.png';
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    }, 'image/png');
  }
  function wrap(ctx, text, x, y, maxWidth, lineHeight) {
    let line = '';
    for (const word of text.split(' ')) {
      const t = line ? line + ' ' + word : word;
      if (ctx.measureText(t).width > maxWidth && line) { ctx.fillText(line, x, y); line = word; y += lineHeight; }
      else line = t;
    }
    ctx.fillText(line, x, y);
  }

  function renderFollowersLine(summary) {
    const st = state();
    const box = $('followers-line');
    box.hidden = true;
    if (st.snapshot) return;
    const parts = [];
    for (const p of ['linkedin', 'x']) {
      if (st.platform !== 'all' && st.platform !== p) continue;
      const hist = (st.followers || {})[p] || [];
      if (!hist.length) continue;
      const latest = hist[hist.length - 1];
      const d = SIT.insights.followerDelta(hist, summary.start, summary.end);
      parts.push(PLATFORM_NAME[p] + ' ' + full(latest.count) + (d.delta != null ? ' (' + (d.delta >= 0 ? '+' : '') + full(d.delta) + ' this period)' : ''));
    }
    if (!parts.length) return;
    box.hidden = false;
    box.textContent = 'Followers: ' + parts.join(' · ');
  }

  function renderWhatsNew() {
    const card = $('whats-new');
    const seen = ui().seenVersion;
    card.hidden = true;
    if (!seen) { saveUi({ seenVersion: VERSION }); return; } // first run: the tour covers it
    if (seen === VERSION) return;
    card.hidden = false;
    card.textContent = '';
    const head = el('div', 'digest-head');
    head.appendChild(el('b', null, 'New in ' + VERSION));
    const close = el('button', 'icon-btn digest-close', '×');
    close.type = 'button';
    close.setAttribute('aria-label', 'Dismiss');
    close.addEventListener('click', () => { saveUi({ seenVersion: VERSION }); card.hidden = true; });
    head.appendChild(close);
    card.appendChild(head);
    const ul = el('ul', 'plain-list');
    for (const t of WHATS_NEW) ul.appendChild(el('li', null, t));
    card.appendChild(ul);
    const link = el('button', 'link-btn', 'See every feature and where it lives');
    link.type = 'button';
    link.addEventListener('click', () => { saveUi({ seenVersion: VERSION }); card.hidden = true; B.showView('features'); });
    card.appendChild(link);
  }

  // 14. why did this post do well or badly
  F.whyRow = function whyRow(record) {
    const li = el('li', 'why-row');
    if (!B) return li;
    const x = SIT.insights.explainPost(record, B.dataRecords());
    if (!x) return li;
    const ul = el('ul', 'why-list');
    x.reasons.forEach((r, i) => ul.appendChild(el('li', i === 0 ? 'why-head ' + (x.verdict || '') : null, r)));
    li.appendChild(ul);
    return li;
  };

  // 7. how fast you usually reply
  F.replyTimeText = function replyTimeText() {
    if (!B) return '';
    const r = SIT.insights.replyTimes(B.dataRecords(), { platform: state().platform });
    return r.median != null && r.samples >= 3 ? 'You usually reply within ' + durationText(r.median) + ' (from ' + r.samples + ' replies).' : '';
  };

  // ---------- Insights tab ----------

  const ins = { platform: 'all', days: 90 };

  function insOpts() {
    const now = Date.now();
    return { platform: ins.platform, start: ins.days ? SIT.stats.rangeBounds({ type: 'days', days: ins.days }, now).start : null, end: null };
  }

  function bindInsights() {
    $('ins-platform').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-platform]');
      if (!b) return;
      ins.platform = b.dataset.platform;
      renderInsights();
    });
    $('ins-range').addEventListener('change', (e) => { ins.days = Number(e.target.value) || 0; renderInsights(); });
    $('check-run').addEventListener('click', runCommentCheck);
    $('check-text').addEventListener('input', () => { $('check-out').hidden = true; });
  }

  function section(title, sentence, empty) {
    const sec = el('section', 'block ins-block');
    const head = el('div', 'block-head');
    head.appendChild(el('h3', null, title));
    sec.appendChild(head);
    if (sentence) sec.appendChild(el('p', 'ins-sentence', sentence));
    else if (empty) sec.appendChild(el('p', 'ins-empty', empty));
    return sec;
  }

  function renderInsights() {
    const st = state();
    for (const b of $('ins-platform').querySelectorAll('button')) b.setAttribute('aria-checked', String(b.dataset.platform === ins.platform));
    $('ins-range').value = String(ins.days);
    const body = $('ins-body');
    body.textContent = '';
    const records = st.records;
    const opts = insOpts();
    if (!Object.keys(records).length) {
      body.appendChild(el('p', 'ins-empty', 'Insights appear after your first scan.'));
      return;
    }
    body.appendChild(bestTimeBlock(records, opts));
    body.appendChild(postTypeBlock(records, opts));
    body.appendChild(lengthBlock(records, opts));
    body.appendChild(roiBlock(records, opts));
    body.appendChild(supportersBlock(records, opts));
    body.appendChild(followersBlock(opts));
    body.appendChild(replyTimeBlock(records, opts));
  }

  function bestTimeBlock(records, opts) {
    const t = SIT.insights.bestTimes(records, opts);
    const sec = section('Best time to post', t.sentence, t.total < 5
      ? 'Appears after 5 posts with impression counts in this range (you have ' + t.total + ').'
      : 'Not enough posts share a day and time yet. It gets sharper with every scan.');
    if (t.total < 2) return sec;
    const max = Math.max(1, ...t.cells.map((c) => (c.n ? c.sum / c.n : 0)));
    const grid = el('div', 'heat');
    grid.appendChild(el('span', 'heat-corner'));
    for (let h = 0; h < 24; h += 3) {
      const lab = el('span', 'heat-hour', SIT.insights.hourLabel(h).replace(' ', ''));
      lab.style.gridColumn = String(h + 2) + ' / span 3';
      grid.appendChild(lab);
    }
    for (let d = 0; d < 7; d++) {
      const day = (d + 1) % 7; // Monday first
      grid.appendChild(el('span', 'heat-day', SIT.insights.DAYS[day]));
      for (let h = 0; h < 24; h++) {
        const c = t.cells[day * 24 + h];
        const cell = el('span', 'heat-cell');
        if (c.n) {
          const avg = c.sum / c.n;
          cell.style.opacity = String(0.25 + 0.75 * (avg / max));
          cell.classList.add('on');
          cell.title = SIT.insights.DAYS[day] + ' ' + SIT.insights.hourLabel(h) + ': avg ' + fmt(avg) + ' over ' + c.n + ' post' + (c.n === 1 ? '' : 's');
        }
        grid.appendChild(cell);
      }
    }
    sec.appendChild(grid);
    if (t.bestDays.length) sec.appendChild(el('p', 'ins-note', 'Best days: ' + t.bestDays.map((d) => d.label + ' (avg ' + fmt(d.avg) + ')').join(', ') + '.'));
    return sec;
  }

  function barRows(rows, labelOf, valueOf, subOf) {
    const max = Math.max(1, ...rows.map((r) => valueOf(r) || 0));
    const box = el('div', 'bars');
    for (const r of rows) {
      const row = el('div', 'bar-row');
      row.appendChild(el('span', 'bar-label', labelOf(r)));
      const track = el('div', 'bar-track');
      const fill = el('span');
      fill.style.width = Math.round(((valueOf(r) || 0) / max) * 100) + '%';
      track.appendChild(fill);
      row.appendChild(track);
      row.appendChild(el('span', 'bar-value', subOf(r)));
      box.appendChild(row);
    }
    return box;
  }

  function postTypeBlock(records, opts) {
    const t = SIT.insights.postTypes(records, opts);
    const sec = section('Post types', t.sentence, t.total ? 'Each type needs 2 posts before it is compared.' : 'No posts in this range yet.');
    if (t.rows.length) sec.appendChild(barRows(t.rows, (r) => r.label, (r) => r.avg, (r) => (r.avg != null ? 'avg ' + fmt(r.avg) : '—') + ' · ' + r.count));
    return sec;
  }

  function lengthBlock(records, opts) {
    const t = SIT.insights.lengthStats(records, opts);
    const sec = section('Length and hooks', t.sentences.join(' '), t.total ? 'Each group needs 2 posts before it is compared.' : 'No posts with text in this range yet.');
    const rows = t.buckets.filter((b) => b.count);
    if (rows.length) sec.appendChild(barRows(rows, (r) => r.label, (r) => r.avg, (r) => (r.avg != null ? 'avg ' + fmt(r.avg) : '—') + ' · ' + r.count));
    const pairs = [t.hashtags, t.questions, t.hookLen].filter((s) => s.yes.n && s.no.n);
    if (pairs.length) {
      sec.appendChild(barRows(pairs.flatMap((s) => [s.yes, s.no]), (r) => r.label, (r) => r.avg, (r) => (r.avg != null ? 'avg ' + fmt(r.avg) : '—') + ' · ' + r.n));
    }
    sec.appendChild(el('p', 'ins-note', 'Lengths count what the scan reads of each post (up to 280 characters).'));
    return sec;
  }

  function roiBlock(records, opts) {
    const t = SIT.insights.engagementRoi(records, opts);
    const sec = section('Engagement return', t.sentence, 'Comments and replies on other people’s posts appear here with the impressions they earned you.');
    if (t.rows.length) sec.appendChild(barRows(t.rows, (r) => r.who, (r) => r.sum, (r) => fmt(r.sum) + ' · ' + r.count));
    return sec;
  }

  function supportersBlock(records, opts) {
    const rows = SIT.insights.supporters(records, opts);
    const sec = section('Top supporters', rows.length ? 'People who comment and reply on your content most often.' : null, 'Nobody has commented or replied in this range yet.');
    if (!rows.length) return sec;
    const ol = el('ol', 'supporters');
    for (const r of rows) {
      const li = el('li');
      li.appendChild(el('b', null, r.name + (r.handle && r.handle !== r.name ? ' ' + r.handle : '')));
      li.appendChild(el('span', 'item-meta', r.count + ' (' + r.comments + ' comments, ' + r.replies + ' replies) · last ' + SIT.timeAgo(r.last)));
      ol.appendChild(li);
    }
    sec.appendChild(ol);
    return sec;
  }

  function followersBlock(opts) {
    const st = state();
    const sec = section('Follower trend', null, null);
    let any = false;
    for (const p of ['linkedin', 'x']) {
      if (opts.platform !== 'all' && opts.platform !== p) continue;
      const hist = ((st.followers || {})[p] || []).filter((h) => opts.start == null || h.at >= opts.start);
      if (hist.length < 1) continue;
      any = true;
      const latest = hist[hist.length - 1];
      const first = hist[0];
      const line = el('p', 'ins-sentence');
      line.textContent = PLATFORM_NAME[p] + ': ' + full(latest.count) + ' followers' + (hist.length > 1 ? ' (' + (latest.count - first.count >= 0 ? '+' : '') + full(latest.count - first.count) + ' since ' + SIT.formatDate(first.at) + ')' : '');
      sec.appendChild(line);
      if (hist.length >= 2) sec.appendChild(sparkline(hist));
    }
    if (!any) sec.appendChild(el('p', 'ins-empty', 'Your follower count is recorded by each scan. Run a scan and it appears here.'));
    return sec;
  }

  function sparkline(hist) {
    const W = 328, H = 60, pad = 4;
    const min = Math.min(...hist.map((h) => h.count));
    const max = Math.max(...hist.map((h) => h.count));
    const x = (i) => pad + (i / (hist.length - 1)) * (W - 2 * pad);
    const y = (v) => (max === min ? H / 2 : pad + (1 - (v - min) / (max - min)) * (H - 2 * pad));
    const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, class: 'spark', role: 'img' });
    root.setAttribute('aria-label', 'Followers from ' + full(hist[0].count) + ' to ' + full(hist[hist.length - 1].count));
    root.appendChild(svg('polyline', { points: hist.map((h, i) => x(i) + ',' + y(h.count)).join(' '), fill: 'none', stroke: 'var(--accent)', 'stroke-width': '2', 'stroke-linejoin': 'round' }));
    hist.forEach((h, i) => root.appendChild(svg('circle', { cx: x(i), cy: y(h.count), r: 2.5, fill: 'var(--accent)' })));
    return root;
  }

  function replyTimeBlock(records, opts) {
    const r = SIT.insights.replyTimes(records, { platform: opts.platform });
    return section('Reply time', r.median != null && r.samples >= 3 ? 'You usually reply within ' + durationText(r.median) + ' (median of ' + r.samples + ' replies). Fast replies keep conversations going.' : null,
      'Appears once 3 of your replies to responses have been scanned.');
  }

  function runCommentCheck() {
    const text = $('check-text').value;
    const out = $('check-out');
    out.textContent = '';
    out.hidden = false;
    const earlier = Object.values(state().records).filter((r) => r.direction === 'mine' && r.kind !== 'post' && r.text);
    const warnings = SIT.insights.commentCheck(text, earlier);
    if (!text.trim()) { out.appendChild(el('p', 'ins-empty', 'Paste a comment first.')); return; }
    if (!warnings.length) { out.appendChild(el('p', 'check-ok', '✓ Reads fine: specific, not a repeat of an earlier comment.')); return; }
    const ul = el('ul', 'check-list');
    for (const w of warnings) ul.appendChild(el('li', 'check-' + w.code, w.message));
    out.appendChild(ul);
  }

  // ---------- Scans: automatic scans ----------

  function bindScans() {
    const save = () => {
      const auto = {
        enabled: $('auto-on').checked, hour: Number($('auto-hour').value), days: Number($('auto-days').value) || 7,
        linkedin: $('auto-li').checked, x: $('auto-x').checked,
      };
      saveSettings({ autoScan: auto });
      renderAutoScan();
    };
    for (const id of ['auto-on', 'auto-hour', 'auto-days', 'auto-li', 'auto-x']) $(id).addEventListener('change', save);
    const hour = $('auto-hour');
    for (let h = 0; h < 24; h++) { const o = el('option', null, SIT.insights.hourLabel(h)); o.value = String(h); hour.appendChild(o); }
  }

  function renderAutoScan() {
    const a = Object.assign({ enabled: false, hour: 8, days: 7, linkedin: true, x: true }, state().settings.autoScan || {});
    $('auto-on').checked = !!a.enabled;
    $('auto-hour').value = String(a.hour);
    $('auto-days').value = String(a.days);
    $('auto-li').checked = a.linkedin !== false;
    $('auto-x').checked = a.x !== false;
    $('auto-detail').hidden = !a.enabled;
    const sites = ['linkedin', 'x'].filter((p) => a[p] !== false).map((p) => PLATFORM_NAME[p]);
    let text = '';
    if (a.enabled && sites.length) {
      const d = new Date(); d.setHours(a.hour, 0, 0, 0);
      if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
      text = 'Next: ' + (d.toDateString() === new Date().toDateString() ? 'today' : 'tomorrow') + ' at ' + SIT.insights.hourLabel(a.hour) + ' · ' + sites.join(' then ') + ' · last ' + a.days + ' day' + (a.days === 1 ? '' : 's') + '. A small window opens, scans and closes itself; Chrome has to be running.';
    } else if (a.enabled) text = 'Pick at least one site.';
    $('auto-next').textContent = text;
  }

  // ---------- Settings: goals, reminders, backup, accounts, features, tour ----------

  function bindSettings() {
    for (const k of KINDS) $('goal-' + k).addEventListener('change', () => {
      const goals = {};
      for (const j of KINDS) goals[j] = Math.max(0, Math.min(999, Math.round(Number($('goal-' + j).value) || 0)));
      saveSettings({ goals });
      renderWeekStrip();
    });
    const remSave = () => saveSettings({ reminders: { enabled: $('rem-on').checked, hours: Number($('rem-hours').value) || 24 } });
    $('rem-on').addEventListener('change', remSave);
    $('rem-hours').addEventListener('change', remSave);
    $('backup-make').addEventListener('click', makeBackup);
    $('backup-file').addEventListener('change', restoreBackup);
    $('open-features').addEventListener('click', () => B.showView('features'));
    $('replay-tour').addEventListener('click', () => { B.showView('stats'); B.render(); startTour(); });
  }

  F.renderSettings = function renderSettings() {
    if (!B) return;
    const s = state().settings;
    const goals = s.goals || {};
    for (const k of KINDS) if (document.activeElement !== $('goal-' + k)) $('goal-' + k).value = Number(goals[k]) > 0 ? String(goals[k]) : '';
    const rem = Object.assign({ enabled: false, hours: 24 }, s.reminders || {});
    $('rem-on').checked = !!rem.enabled;
    $('rem-hours').value = String(rem.hours);
    renderAccounts();
  };

  async function renderAccounts() {
    const box = $('accounts-list');
    box.textContent = '';
    const list = await chrome.runtime.sendMessage({ type: 'accounts:list' }).catch(() => null);
    if (!Array.isArray(list) || !list.length) { box.appendChild(el('p', 'hint', 'No account data yet.')); return; }
    for (const a of list) {
      const row = el('div', 'account-row');
      const who = a.label || (a.owner ? (a.platform === 'x' && !a.owner.startsWith('@') ? 'id ' + a.owner : a.owner) : 'unknown account');
      row.appendChild(el('span', 'account-name', PLATFORM_NAME[a.platform] + ' · ' + who + (a.current ? ' (signed in now)' : '')));
      row.appendChild(el('span', 'item-meta', B.plural(a.items, 'item') + ' · ' + B.plural(a.scans, 'scan')));
      const del = el('button', 'btn btn-small btn-danger', 'Remove');
      del.type = 'button';
      del.addEventListener('click', () => {
        if (del.dataset.armed) {
          chrome.runtime.sendMessage({ type: 'accounts:remove', platform: a.platform, owner: a.owner }).then(async () => { await B.loadData(); renderAccounts(); });
          return;
        }
        del.dataset.armed = '1';
        del.textContent = 'Click again to remove';
        setTimeout(() => { delete del.dataset.armed; del.textContent = 'Remove'; }, 4000);
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  }

  async function makeBackup() {
    const backup = await chrome.runtime.sendMessage({ type: 'backup:make' }).catch(() => null);
    if (!backup || !backup.data) { $('backup-status').textContent = 'Couldn’t read the data. Try again.'; return; }
    const stamp = new Date().toISOString().slice(0, 10);
    B.download('profile-lens-backup-' + stamp + '.json', 'application/json', JSON.stringify(backup));
    $('backup-status').textContent = 'Backup saved: ' + B.plural(Object.keys(backup.data.records || {}).length, 'item') + ', ' + B.plural((backup.data.scanHistory || []).length, 'scan') + '. Keep the file somewhere safe.';
  }

  function restoreBackup(e) {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    const mode = $('backup-mode').value;
    const reader = new FileReader();
    reader.onload = async () => {
      let backup = null;
      try { backup = JSON.parse(String(reader.result)); } catch (_) { backup = null; }
      if (!backup || !backup.data) { $('backup-status').textContent = 'That file is not a Profile Lens backup.'; e.target.value = ''; return; }
      $('backup-status').textContent = 'Restoring…';
      const res = await chrome.runtime.sendMessage({ type: 'backup:restore', backup, mode }).catch(() => null);
      e.target.value = '';
      if (!res || !res.ok) { $('backup-status').textContent = (res && res.error) || 'Couldn’t restore the backup.'; return; }
      $('backup-status').textContent = (mode === 'merge' ? 'Merged. ' : 'Restored. ') + B.plural(res.items, 'item') + ' stored now.';
      await B.loadData();
      F.renderSettings();
      B.renderFooter();
    };
    reader.readAsText(file);
  }

  function renderFeatures() {
    const box = $('features-list');
    box.textContent = '';
    let where = null;
    for (const f of FEATURES) {
      if (f.where !== where) { where = f.where; box.appendChild(el('h3', 'features-where', where)); }
      const row = el('div', 'feature');
      row.appendChild(el('b', null, f.name));
      row.appendChild(el('span', null, f.text));
      box.appendChild(row);
    }
  }

  // ---------- first-run tour ----------

  const TOUR = [
    { title: 'Welcome to Profile Lens', text: 'It counts the impressions on your own LinkedIn and X posts, comments and replies, and shows who is waiting for your reply. Nothing leaves your browser.' },
    { title: '1. Pick a range, press Scan', text: 'Choose 1D, 3D, 7D, 10D, 30D or a month at the top, then click Scan LinkedIn or Scan X at the bottom. A tab opens on your own activity pages, reads them and finishes by itself. Stay on that tab while it runs; you can pause and resume.' },
    { title: '2. Read the tiles', text: 'Posts, comments and replies are counted separately, with a change against the period before. The bars rate each item against your usual. Needs reply lists who is waiting for you.' },
    { title: '3. Then look at Insights', text: 'Best time to post, post types, length and hooks, who your comments earn the most reach from, your top supporters and your follower trend. Set weekly goals in Settings and the Dashboard tracks them.' },
  ];

  function maybeTour() {
    if (!ui().tourDone) startTour();
  }

  function startTour() {
    const box = $('tour');
    box.hidden = false;
    let i = 0;
    const draw = () => {
      box.textContent = '';
      const card = el('div', 'tour-card');
      card.setAttribute('role', 'dialog');
      card.setAttribute('aria-label', 'Getting started');
      const step = TOUR[i];
      card.appendChild(el('span', 'tour-step', (i + 1) + ' of ' + (TOUR.length + 1)));
      card.appendChild(el('h2', null, step ? step.title : 'What Profile Lens can do'));
      if (step) card.appendChild(el('p', null, step.text));
      else {
        const ul = el('ul', 'plain-list tour-list');
        for (const f of FEATURES) { const li = el('li'); li.appendChild(el('b', null, f.name)); li.appendChild(document.createTextNode(' · ' + f.where)); ul.appendChild(li); }
        card.appendChild(ul);
        card.appendChild(el('p', 'hint', 'This list is always in Settings → Features.'));
      }
      const row = el('div', 'btn-row tour-row');
      const skip = el('button', 'link-btn', 'Skip');
      skip.type = 'button';
      skip.addEventListener('click', finish);
      row.appendChild(skip);
      if (i > 0) { const back = el('button', 'btn btn-small', 'Back'); back.type = 'button'; back.addEventListener('click', () => { i--; draw(); }); row.appendChild(back); }
      const next = el('button', 'btn btn-small btn-primary', i < TOUR.length ? 'Next' : 'Start');
      next.type = 'button';
      next.addEventListener('click', () => { if (i < TOUR.length) { i++; draw(); } else finish(); });
      row.appendChild(next);
      card.appendChild(row);
      box.appendChild(card);
      next.focus();
    };
    const finish = () => { saveUi({ tourDone: true, seenVersion: VERSION }); box.hidden = true; box.textContent = ''; };
    draw();
  }

  // ---------- wiring ----------

  F.init = function init(bridge) {
    B = bridge;
    bindInsights();
    bindScans();
    bindSettings();
  };

  // Called once the data is loaded.
  F.ready = function ready() {
    maybeTour();
  };

  F.onView = function onView(view) {
    if (!B) return;
    if (view === 'insights') renderInsights();
    else if (view === 'features') renderFeatures();
    else if (view === 'scans') renderAutoScan();
  };

  // popup.js ran first: pick up its bridge now.
  if (SIT.popupBridge) {
    F.init(SIT.popupBridge);
    if (SIT.popupBridge.loaded) {
      F.ready();
      B.render();
      F.onView(B.state.view);
    }
  }
})();
