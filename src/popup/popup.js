(function () {
  'use strict';
  const SIT = globalThis.SIT;
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';

  const KINDS = ['post', 'comment', 'reply'];
  const KIND_LABEL = { post: 'Posts', comment: 'Comments', reply: 'Replies' };
  const TAB_KIND = { posts: 'post', comments: 'comment', replies: 'reply' };

  const state = {
    records: {},
    identity: {},
    settings: {},
    meta: {},
    scan: null,
    platform: 'all',
    range: { type: 'days', days: 7 },
    tab: 'posts',
    sub: { comments: 'all', replies: 'all' },
    view: 'stats',
    summary: null,
    hot: -1,
    history: [],
    snapshot: null, // { entry, records } while viewing a past scan
    followers: {}, // platform -> [{ at, count }]
    ui: {}, // tour done, version seen, digest dismissed
    why: new Set(), // post ids with the "Why?" panel open
  };

  // The dashboard reads either the latest scanned data or a frozen scan snapshot.
  const dataRecords = () => (state.snapshot ? state.snapshot.records : state.records);
  const nowTs = () => (state.snapshot ? state.snapshot.entry.finishedAt : Date.now());

  // ---------- per-viewer preferences ----------

  function loadPrefs() {
    try {
      const prefs = JSON.parse(localStorage.getItem('pl-prefs') || '{}');
      if (['all', 'linkedin', 'x'].includes(prefs.platform)) state.platform = prefs.platform;
      if (prefs.range && (prefs.range.type === 'days' || prefs.range.type === 'month')) state.range = prefs.range;
      if (TAB_KIND[prefs.tab]) state.tab = prefs.tab;
      if (prefs.sub) {
        for (const t of ['comments', 'replies']) if (prefs.sub[t] === 'all' || prefs.sub[t] === 'needs') state.sub[t] = prefs.sub[t];
      }
    } catch (_) { /* storage unavailable */ }
  }

  function savePrefs() {
    try {
      localStorage.setItem('pl-prefs', JSON.stringify({ platform: state.platform, range: state.range, tab: state.tab, sub: state.sub }));
    } catch (_) { /* storage unavailable */ }
  }

  // ---------- data ----------

  async function loadData() {
    const data = await chrome.storage.local.get(['records', 'identity', 'settings', 'meta', 'scanHistory', 'followers', 'ui']);
    state.identity = data.identity || {};
    state.records = ownRecords(data.records || {}, state.identity);
    state.followers = data.followers || {};
    state.ui = data.ui || {};
    state.settings = Object.assign({ xHandle: '', linkedinProfile: '', expandComments: true }, data.settings || {});
    state.meta = data.meta || {};
    state.history = (data.scanHistory || []).filter((h) => h && (!h.owner || h.owner === ownerOf(state.identity, h.platform)));
  }

  // The account a record belongs to; stats of another account on the same site stay out.
  function ownerOf(identity, platform) {
    const id = identity && identity[platform];
    if (!id) return null;
    return platform === 'x' ? (id.id || (id.handle ? '@' + String(id.handle).toLowerCase() : null)) : (id.profileId || id.slug || null);
  }
  function ownRecords(records, identity) {
    const owners = { x: ownerOf(identity, 'x'), linkedin: ownerOf(identity, 'linkedin') };
    const out = {};
    for (const id in records) {
      const r = records[id];
      if (!r || !r.owner || !owners[r.platform] || r.owner === owners[r.platform]) out[id] = r;
    }
    return out;
  }

  async function loadScan() {
    try {
      state.scan = await chrome.runtime.sendMessage({ type: 'scan:status' });
    } catch (_) {
      state.scan = null;
    }
  }

  // ---------- helpers ----------

  function el(tag, cls, text) {
    const node = document.createElement(tag);
    if (cls) node.className = cls;
    if (text != null) node.textContent = text;
    return node;
  }

  function svg(tag, attrs) {
    const node = document.createElementNS(NS, tag);
    for (const k in attrs) node.setAttribute(k, attrs[k]);
    return node;
  }

  function plural(n, word, many) {
    return SIT.formatFull(n) + ' ' + (n === 1 ? word : many || word + 's');
  }

  function niceCeil(v) {
    if (v <= 0) return 0;
    const exp = Math.pow(10, Math.floor(Math.log10(v)));
    const f = v / exp;
    // Steps whose half is also a clean number, so the mid gridline reads well.
    const nf = [1, 2, 3, 4, 5, 6, 8, 10].find((step) => f <= step);
    return nf * exp;
  }

  const axisFmt = new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 });

  const TYPE_WORD = { post: 'posts', comment: 'comments', reply: 'replies' };

  // Five rising bars: how many are filled carries the level, the colour repeats it.
  function meter(level, kind) {
    const node = svg('svg', { class: 'meter', viewBox: '0 0 22 14', role: 'img' });
    const n = level ? level.level : 0;
    node.setAttribute('data-level', String(n));
    const label = level
      ? level.label + ' impressions (' + (level.usual ? 'your usual for ' + TYPE_WORD[kind] + ' is ' + SIT.formatCompact(level.usual) : 'vs your usual') + ')'
      : 'Not enough history to rate impressions yet';
    node.setAttribute('aria-label', label);
    const title = svg('title', {});
    title.textContent = label;
    node.appendChild(title);
    for (let i = 0; i < 5; i++) {
      const h = 4 + i * 2.5;
      node.appendChild(svg('rect', { x: i * 4.6, y: 14 - h, width: 3.4, height: h, rx: 0.8, class: i < n ? 'on' : '' }));
    }
    return node;
  }

  function levelOf(record) {
    return state.summary ? SIT.stats.levelOf(record, state.summary.base) : null;
  }

  function avgLevel(kind, avg) {
    const platform = state.platform === 'all' ? '*' : state.platform;
    return SIT.stats.levelFor(avg, platform, kind, state.summary.base);
  }

  function valueCell(record) {
    const hasValue = typeof record.impressions === 'number';
    const cell = el('span', 'item-value' + (hasValue ? '' : ' none'));
    cell.appendChild(el('span', null, hasValue ? SIT.formatCompact(record.impressions) : '—'));
    if (hasValue) cell.appendChild(meter(levelOf(record), record.kind));
    cell.title = hasValue ? SIT.formatFull(record.impressions) + ' impressions' : 'No impression count';
    return cell;
  }

  function convoOf(record) {
    return state.summary.convo.get(record.platform + ':' + record.ref) || null;
  }

  function openUrl(url) {
    if (url) chrome.tabs.create({ url });
  }

  // ---------- filters ----------

  function renderFilters() {
    for (const b of $('platform-seg').querySelectorAll('button')) {
      b.setAttribute('aria-checked', String(b.dataset.platform === state.platform));
    }
    const isMonth = state.range.type === 'month';
    for (const b of $('range-seg').querySelectorAll('button[data-days]')) {
      b.setAttribute('aria-checked', String(!isMonth && Number(b.dataset.days) === state.range.days));
    }

    const select = $('month-select');
    const options = SIT.stats.monthOptions(dataRecords(), nowTs());
    select.textContent = '';
    const placeholder = el('option', null, 'Month');
    placeholder.value = '';
    placeholder.disabled = true;
    select.appendChild(placeholder);
    for (const o of options) {
      const opt = el('option', null, o.short);
      opt.value = o.value;
      select.appendChild(opt);
    }
    select.value = isMonth ? state.range.year + '-' + state.range.month : '';
    $('month-chip').classList.toggle('is-active', isMonth);
  }

  function rangeCaption(summary) {
    if (state.range.type === 'month') {
      return SIT.stats.MONTHS[state.range.month] + ' ' + state.range.year + ' · by publish date';
    }
    const last = SIT.stats.addDays(summary.end, -1);
    const sameYear = new Date(summary.start).getFullYear() === new Date(nowTs()).getFullYear();
    return SIT.formatDate(summary.start, !sameYear) + ' – ' + SIT.formatDate(last, !sameYear) + ' · by publish date';
  }

  // ---------- stats view ----------

  function render() {
    renderFilters();
    renderSnapshotBanner();
    const summary = SIT.stats.summarize(dataRecords(), { platform: state.platform, range: state.range }, nowTs());
    state.summary = summary;
    $('range-caption').textContent = rangeCaption(summary);
    renderCoverage(summary);

    const hasAny = Object.keys(dataRecords()).length > 0;
    $('empty').hidden = hasAny;
    $('stats-body').hidden = !hasAny;
    renderFooter();
    if (!hasAny) return;

    renderTiles(summary);
    renderChart(summary);
    renderBreakdown(summary);
    renderReceived(summary);
    renderItems(summary);
    if (SIT.features) SIT.features.onRender(summary);
  }

  // Stats only come from scans, so a range that reaches further back than any finished
  // scan of a site is missing items. Say so instead of showing it as complete.
  function renderCoverage(summary) {
    const note = $('coverage-note');
    note.hidden = true;
    if (state.snapshot || !Object.keys(state.records).length) return;
    const sites = state.platform === 'all' ? ['linkedin', 'x'] : [state.platform];
    const short = [];
    for (const p of sites) {
      // Each finished scan covers from its window's start to the moment it finished.
      const spans = state.history.filter((h) => h.platform === p && h.status === 'done' && h.windowStart)
        .map((h) => [h.windowStart, h.finishedAt]).sort((a, b) => a[0] - b[0]);
      if (!spans.length) continue; // never scanned: nothing of that site is shown at all
      const until = Math.min(summary.end, Math.max(...spans.map((x) => x[1])));
      let reached = summary.start;
      let gap = null;
      for (const [from, to] of spans) {
        if (to <= reached) continue;
        if (from > reached + 12 * 3600e3) { gap = [reached, from]; break; }
        reached = to;
        if (reached >= until) break;
      }
      if (gap && gap[0] < until) short.push(PLATFORM_NAME[p] + ' wasn’t scanned for ' + SIT.formatDate(gap[0]) + ' – ' + SIT.formatDate(gap[1]));
    }
    if (!short.length) return;
    note.hidden = false;
    note.textContent = short.join(' and ') + ', so this range is incomplete. Keep this range picked and scan again to fill it.';
  }

  function renderTiles(summary) {
    for (const kind of KINDS) {
      const b = summary.mine[kind];
      $('kpi-' + kind).textContent = SIT.formatCompact(b.impressions);
      $('kpi-' + kind).title = SIT.formatFull(b.impressions) + ' impressions';
      const sub = $('kpi-' + kind + '-sub');
      sub.textContent = '';
      if (!b.count) {
        sub.appendChild(el('span', null, 'None yet'));
        continue;
      }
      const avg = b.withData ? b.impressions / b.withData : null;
      sub.appendChild(el('span', null, SIT.formatFull(b.count) + (avg != null ? ' · avg ' + SIT.formatCompact(avg) : '')));
      if (avg != null) sub.appendChild(meter(avgLevel(kind, avg), kind));
    }
  }

  function renderBreakdown(summary) {
    const body = $('breakdown-body');
    body.textContent = '';
    const m = summary.mine;
    const total = {
      count: m.post.count + m.comment.count + m.reply.count,
      withData: m.post.withData + m.comment.withData + m.reply.withData,
      impressions: m.post.impressions + m.comment.impressions + m.reply.impressions,
    };
    const rows = [['Posts', m.post, 'post'], ['Comments', m.comment, 'comment'], ['Replies', m.reply, 'reply'], ['Total', total, null]];
    for (const [label, b, kind] of rows) {
      const tr = el('tr', kind ? null : 'strong');
      tr.appendChild(el('td', null, label));
      tr.appendChild(el('td', 'num', SIT.formatFull(b.count)));
      tr.appendChild(el('td', 'num', SIT.formatFull(b.impressions)));
      const avgCell = el('td', 'num');
      const wrap = el('span', 'avg-cell');
      const avg = b.withData ? b.impressions / b.withData : null;
      wrap.appendChild(el('span', null, avg != null ? SIT.formatCompact(avg) : '—'));
      if (kind && avg != null) wrap.appendChild(meter(avgLevel(kind, avg), kind));
      avgCell.appendChild(wrap);
      tr.appendChild(avgCell);
      body.appendChild(tr);
    }

    const missing = total.count - total.withData;
    const note = $('breakdown-note');
    note.hidden = missing === 0;
    note.textContent = missing === 1
      ? '1 item has no impression count yet, so it isn’t in the totals.'
      : missing + ' items have no impression count yet, so they aren’t in the totals.';

    const split = $('platform-split');
    split.hidden = state.platform !== 'all';
    split.textContent = '';
    if (state.platform === 'all') {
      const table = el('table', 'split-table');
      const head = el('tr');
      head.append(el('th', null, ''), el('th', 'num', 'LinkedIn'), el('th', 'num', 'X'));
      table.appendChild(head);
      for (const kind of KINDS) {
        const tr = el('tr');
        tr.append(
          el('td', null, KIND_LABEL[kind]),
          el('td', 'num', SIT.formatCompact(summary.platforms.linkedin[kind])),
          el('td', 'num', SIT.formatCompact(summary.platforms.x[kind]))
        );
        table.appendChild(tr);
      }
      split.appendChild(table);
    }
  }

  function renderReceived(summary) {
    $('recv-comments').textContent = SIT.formatFull(summary.received.comment);
    $('recv-replies').textContent = SIT.formatFull(summary.received.reply);
    const waiting = summary.needs.comment.concat(summary.needs.reply).reduce((n, e) => n + e.pending.length, 0);
    $('recv-waiting-value').textContent = SIT.formatFull(waiting);
    $('recv-waiting').disabled = waiting === 0;
  }

  // ---------- item lists ----------

  function contextText(r) {
    if (r.kind === 'post') return r.replies ? plural(r.replies, 'comment') : '';
    if (r.onMyPost) return 'on your post';
    if (r.platform === 'x') {
      if (r.kind === 'comment') return r.parentAuthor ? 'on ' + r.parentAuthor + '’s post' : '';
      return r.parentAuthor ? 'to ' + r.parentAuthor : '';
    }
    return r.postAuthor ? 'on ' + r.postAuthor + '’s post' : '';
  }

  function badge(r) {
    const b = el('span', 'badge', r.platform === 'linkedin' ? 'in' : 'X');
    b.title = r.platform === 'linkedin' ? 'LinkedIn' : 'X';
    return b;
  }

  function itemLink(url, children) {
    const a = el('a');
    a.href = url || '#';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      openUrl(url);
    });
    a.append(...children);
    return a;
  }

  function allRow(r) {
    const main = el('span', 'item-main');
    main.appendChild(el('span', 'item-text', r.text || '(no text)'));
    const meta = el('span', 'item-meta');
    meta.appendChild(document.createTextNode([SIT.formatDate(r.createdAt), contextText(r)].filter(Boolean).join(' · ')));
    const c = r.kind !== 'post' ? convoOf(r) : null;
    if (c && c.responses.length) {
      meta.appendChild(document.createTextNode(' · ' + plural(c.responses.length, 'response')));
      if (c.threadSize >= 3) meta.appendChild(el('span', 'chip-mini', 'Thread · ' + c.threadSize));
      if (c.pending.length) meta.appendChild(el('span', 'chip-mini', 'Needs reply'));
    }
    if (r.kind === 'post' && SIT.features && !state.snapshot) {
      const why = el('button', 'link-btn why-btn', state.why.has(r.id) ? 'Hide' : 'Why?');
      why.type = 'button';
      why.title = 'How this post compares with your usual, and what might explain it';
      why.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        if (state.why.has(r.id)) state.why.delete(r.id); else state.why.add(r.id);
        renderItems(state.summary);
      });
      meta.appendChild(document.createTextNode(' · '));
      meta.appendChild(why);
    }
    main.appendChild(meta);
    const li = el('li', 'item');
    li.appendChild(itemLink(r.url, [badge(r), main, valueCell(r)]));
    return li;
  }

  function needsRow(entry) {
    const latest = entry.pending[0];
    const mineItem = entry.item;
    const main = el('span', 'item-main');
    const text = el('span', 'item-text');
    text.append(el('b', null, (latest.author && latest.platform === 'x' ? latest.author : latest.authorName || latest.author || 'Someone') + ': '),
      document.createTextNode(latest.text || '(no text)'));
    main.appendChild(text);

    const meta = el('span', 'item-meta');
    const parts = ['waiting ' + SIT.timeAgo(latest.createdAt, nowTs()).replace(/ ago$/, '').replace(/^just now$/, 'a moment')];
    const kindWord = mineItem.kind === 'reply' ? 'reply' : 'comment';
    meta.appendChild(document.createTextNode(parts.join(' · ') + ' · to your ' + kindWord + ' '));
    const quote = mineItem.placeholder ? '(not scanned yet)' : '“' + SIT.truncate(mineItem.text || '', 38) + '”';
    meta.appendChild(el('span', 'quote', quote));
    if (entry.pending.length > 1) meta.appendChild(el('span', 'chip-mini', entry.pending.length + ' waiting'));
    if (entry.threadSize >= 3) meta.appendChild(el('span', 'chip-mini', 'Thread · ' + entry.threadSize));
    main.appendChild(meta);

    const li = el('li', 'item');
    li.appendChild(itemLink(latest.url || mineItem.url, [badge(latest), main, valueCell(mineItem)]));
    return li;
  }

  function renderLevelLegend() {
    const ul = $('level-legend');
    ul.textContent = '';
    for (let n = 5; n >= 1; n--) {
      const lvl = SIT.stats.LEVELS[n];
      const li = el('li');
      const m = meter(lvl, null);
      m.setAttribute('aria-hidden', 'true');
      li.append(m, document.createTextNode(lvl.label));
      ul.appendChild(li);
    }
    ul.title = 'Compared with your usual (median) impressions for that type on that platform';
  }

  function renderItems(summary) {
    for (const b of document.querySelectorAll('.tabs button')) {
      const on = b.dataset.tab === state.tab;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    $('item-panel').setAttribute('aria-labelledby', 'tab-' + state.tab);

    const kind = TAB_KIND[state.tab];
    const hasSub = kind !== 'post';
    const sub = hasSub ? state.sub[state.tab] : 'all';
    const subtabs = $('subtabs');
    subtabs.hidden = !hasSub;
    const needs = hasSub ? summary.needs[kind] : [];
    if (hasSub) {
      $('sub-all').setAttribute('aria-checked', String(sub === 'all'));
      $('sub-needs').setAttribute('aria-checked', String(sub === 'needs'));
      $('sub-all').textContent = 'All';
      $('sub-needs').textContent = 'Needs reply';
      const waiting = needs.reduce((n, e) => n + e.pending.length, 0);
      if (waiting) $('sub-needs').appendChild(el('span', 'count', String(waiting)));
    }

    const count = summary.mine[kind].count;
    let insight;
    if (kind === 'post') insight = 'Your posts, highest impressions first.';
    else if (sub === 'needs') {
      insight = kind === 'comment'
        ? 'Someone answered your comment and you haven’t replied yet.'
        : 'Someone answered your reply and you haven’t replied yet. These are threads that keep going.';
    } else {
      const word = kind === 'comment' ? 'comment' : 'reply';
      insight = count
        ? SIT.formatFull(summary.engaged[kind]) + ' of ' + plural(count, word, word === 'reply' ? 'replies' : null) + ' got responses · ' +
          plural(summary.threads[kind], 'became a thread', 'became threads')
        : '';
    }
    if (sub === 'needs' && SIT.features) insight = [insight, SIT.features.replyTimeText()].filter(Boolean).join(' ');
    $('insight').textContent = insight;
    $('insight').hidden = !insight;
    renderLevelLegend();

    const list = $('item-list');
    list.textContent = '';
    if (sub === 'needs') {
      if (!needs.length) {
        list.appendChild(el('li', 'items-empty', 'Nothing waiting for your reply in this period.'));
        return;
      }
      for (const entry of needs.slice(0, 30)) list.appendChild(needsRow(entry));
      return;
    }
    const items = summary.items[kind];
    if (!items.length) {
      list.appendChild(el('li', 'items-empty', 'No ' + TYPE_WORD[kind] + ' in this period.'));
      return;
    }
    for (const r of items.slice(0, 30)) {
      list.appendChild(allRow(r));
      if (r.kind === 'post' && state.why.has(r.id) && SIT.features) list.appendChild(SIT.features.whyRow(r));
    }
  }

  // ---------- chart ----------

  function xLabel(day, i, n) {
    const d = new Date(day.start);
    if (n <= 3) return SIT.formatDate(day.start);
    if (n <= 10) return String(d.getDate());
    return i % 7 === 0 ? SIT.formatDate(day.start) : null;
  }

  function renderChart(summary) {
    const host = $('chart');
    host.textContent = '';
    host.__chart = null;
    hideTooltip();
    const days = summary.daily;
    const total = (d) => d.post + d.comment + d.reply;
    const max = Math.max(0, ...days.map(total));
    if (max === 0) {
      host.removeAttribute('tabindex');
      host.appendChild(el('p', 'chart-empty', 'No impressions recorded for items published in this period.'));
      return;
    }

    const W = 328;
    const H = 132;
    const top = 8;
    const bottom = 18;
    const top1 = niceCeil(max);
    const ticks = [0, top1 / 2, top1];
    const left = Math.max(...ticks.map((t) => axisFmt.format(t).length)) * 6 + 8;
    const plotW = W - left;
    const plotH = H - top - bottom;
    const baseY = top + plotH;
    const band = plotW / days.length;
    const barW = Math.max(3, Math.min(24, band * 0.62));
    const y = (v) => (v / top1) * plotH;

    const root = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img' });
    const sums = KINDS.map((k) => SIT.formatFull(days.reduce((s, d) => s + d[k], 0)));
    root.setAttribute('aria-label', 'Daily impressions. Posts ' + sums[0] + ', comments ' + sums[1] + ', replies ' + sums[2] + '. Values are also listed in the breakdown table.');

    for (const t of ticks) {
      const ty = Math.round(baseY - y(t)) + 0.5;
      if (t > 0) root.appendChild(svg('line', { class: 'grid', x1: left, x2: W, y1: ty, y2: ty }));
      const label = svg('text', { class: 'tick', x: left - 6, y: ty + 3.5, 'text-anchor': 'end' });
      label.textContent = axisFmt.format(t);
      root.appendChild(label);
    }

    days.forEach((d, i) => {
      const g = svg('g', { class: 'col', 'data-i': i });
      const cx = left + band * i + band / 2;
      const bx = cx - barW / 2;
      g.appendChild(svg('rect', { class: 'hover-band', x: left + band * i, y: top, width: band, height: plotH }));

      // Stack from the baseline: posts, comments, replies, with a 2px surface gap between segments.
      const segments = KINDS.map((k) => ({ k, h: y(d[k]) })).filter((s) => s.h > 0);
      let yTop = baseY;
      segments.forEach((s, idx) => {
        const gap = idx > 0 ? 2 : 0;
        const h = Math.max(1, s.h - gap);
        yTop -= gap + h;
        const isTop = idx === segments.length - 1;
        g.appendChild(svg('path', { class: 'bar-' + s.k, d: barPath(bx, yTop, barW, h, isTop ? 4 : 0) }));
      });

      const label = xLabel(d, i, days.length);
      if (label) {
        const first = i === 0 && days.length > 10;
        const tx = svg('text', { class: 'tick', x: first ? bx : cx, y: H - 4, 'text-anchor': first ? 'start' : 'middle' });
        tx.textContent = label;
        g.appendChild(tx);
      }
      root.appendChild(g);
    });

    root.appendChild(svg('line', { class: 'baseline', x1: left, x2: W, y1: baseY + 0.5, y2: baseY + 0.5 }));

    const hit = svg('rect', { class: 'hit', x: left, y: 0, width: plotW, height: H });
    root.appendChild(hit);
    hit.addEventListener('pointermove', (e) => {
      const rect = root.getBoundingClientRect();
      const x = ((e.clientX - rect.left) / rect.width) * W;
      setHot(Math.min(days.length - 1, Math.max(0, Math.floor((x - left) / band))));
    });
    hit.addEventListener('pointerleave', () => setHot(-1));

    host.tabIndex = 0;
    host.setAttribute('aria-label', 'Daily impressions chart. Use left and right arrow keys to read each day.');
    host.appendChild(root);
    host.__chart = { days, left, band, W, root };
  }

  function barPath(x, yTop, w, h, r) {
    r = Math.min(r, h, w / 2);
    const yb = yTop + h;
    if (r <= 0) return 'M' + x + ',' + yb + 'V' + yTop + 'H' + (x + w) + 'V' + yb + 'Z';
    return 'M' + x + ',' + yb + 'V' + (yTop + r) +
      'A' + r + ',' + r + ' 0 0 1 ' + (x + r) + ',' + yTop +
      'H' + (x + w - r) +
      'A' + r + ',' + r + ' 0 0 1 ' + (x + w) + ',' + (yTop + r) +
      'V' + yb + 'Z';
  }

  function setHot(i) {
    const chart = $('chart').__chart;
    if (!chart) return;
    state.hot = i;
    for (const g of chart.root.querySelectorAll('.col')) {
      g.classList.toggle('is-hot', Number(g.dataset.i) === i);
    }
    if (i < 0) return hideTooltip();
    showTooltip(chart, i);
  }

  function showTooltip(chart, i) {
    const d = chart.days[i];
    const tip = $('tooltip');
    tip.textContent = '';
    tip.appendChild(el('div', 'tt-date', new Date(d.start).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })));
    for (const k of KINDS) {
      const row = el('div', 'tt-row');
      const key = el('span', 'tt-key');
      key.style.background = 'var(--s-' + k + ')';
      row.append(key, el('span', 'tt-val', SIT.formatFull(d[k])), el('span', 'tt-name', KIND_LABEL[k]));
      tip.appendChild(row);
    }
    tip.hidden = false;

    const block = tip.parentElement.getBoundingClientRect();
    const svgRect = chart.root.getBoundingClientRect();
    const scale = svgRect.width / chart.W;
    const colX = svgRect.left - block.left + (chart.left + chart.band * i + chart.band / 2) * scale;
    const tipW = tip.offsetWidth;
    const x = Math.min(block.width - tipW - 8, Math.max(8, colX - tipW / 2));
    tip.style.left = x + 'px';
    tip.style.top = (svgRect.top - block.top - tip.offsetHeight - 6) + 'px';
  }

  function hideTooltip() {
    const tip = $('tooltip');
    if (tip) tip.hidden = true;
  }

  // ---------- footer / scans ----------

  function renderFooter() {
    const scan = state.scan;
    const paused = !!scan && scan.status === 'paused';
    const running = !!scan && (scan.status === 'running' || paused);
    $('scan-row').hidden = running;
    $('scan-range-note').hidden = running;
    $('scan-status').hidden = !running;
    $('scan-status').classList.toggle('is-paused', paused);
    $('scan-notice').hidden = !running || paused;
    for (const id of ['scan-linkedin', 'scan-x', 'full-linkedin', 'full-x']) $(id).disabled = running;
    if (running) {
      const name = scan.platform === 'x' ? 'X' : 'LinkedIn';
      const where = 'step ' + (scan.index + 1) + ' of ' + scan.steps.length;
      $('scan-status-text').textContent = paused
        ? name + ' scan paused at ' + where + (scan.autoPaused ? ' (its tab isn’t in front)' : '')
        : 'Scanning ' + name + (scan.rangeLabel ? ' (' + scan.rangeLabel + ')' : '') + ' · ' + where;
      $('scan-pause').textContent = paused ? 'Resume' : 'Pause';
    }
    $('scan-range-note').textContent = scanRangeText();

    const total = Object.keys(state.records).length;
    const updated = Math.max(0, ...Object.values((state.meta && state.meta.lastUpdated) || {}));
    let text = total ? plural(total, 'item') + ' from your scans · updated ' + SIT.timeAgo(updated) : 'No scans yet';
    const last = state.history[0];
    if (last && last.status === 'done') text += ' · last scan took ' + SIT.formatDuration(scanTook(last));
    if (scan && !running && scan.finishedAt && Date.now() - scan.finishedAt < 15 * 60e3) {
      const name = scan.platform === 'x' ? 'X' : 'LinkedIn';
      if (scan.status === 'failed') text = name + ' scan failed: ' + scan.message;
      else if (scan.status === 'done') text = name + ' scan finished · ' + plural(scan.found || 0, 'item') + ' collected';
      else if (scan.status === 'stopped') text = name + ' scan stopped · ' + text;
    }
    $('status').textContent = text;
  }

  // Time spent scanning: paused time doesn't count.
  const scanTook = (h) => Math.max(0, h.finishedAt - h.startedAt - (h.pausedMs || 0));

  function scanRangeText() {
    const r = state.range;
    if (r.type === 'month') return 'Scans cover ' + SIT.stats.MONTHS[r.month] + ' ' + r.year + ' (the month picked above) up to today.';
    const start = SIT.stats.rangeBounds(r, Date.now()).start;
    return r.days === 1
      ? 'Scans cover today (' + SIT.formatDate(start) + '), the range picked above.'
      : 'Scans cover the last ' + plural(r.days, 'day') + ' (' + SIT.formatDate(start) + ' to today), the range picked above.';
  }

  // What a scan's saved totals cover: its own range (older scans always saved 30 days).
  function totalsLabel(h) {
    const r = h.range;
    if (r && r.type === 'month') return SIT.stats.MONTHS[r.month] + ' ' + r.year + ' then';
    if (r && r.type === 'days') return r.days === 1 ? 'That day' : 'Last ' + r.days + ' days then';
    return 'Last 30 days then';
  }

  async function startScan(platform, mode) {
    const ids = ['scan-linkedin', 'scan-x', 'full-linkedin', 'full-x'];
    for (const id of ids) $(id).disabled = true;
    const res = await chrome.runtime.sendMessage({ type: 'scan:start', platform, mode, range: mode === 'full' ? null : state.range }).catch(() => null);
    if (!res || !res.ok) {
      for (const id of ids) $(id).disabled = false;
      $('status').textContent = "Couldn't start the scan. Try again.";
    }
  }

  // ---------- scans view & snapshots ----------

  const PLATFORM_NAME = { linkedin: 'LinkedIn', x: 'X' };
  const STATUS = {
    done: { label: 'Completed', icon: 'M2.5 6.5 5 9l4.5-6' },
    stopped: { label: 'Stopped', icon: 'M3.5 3.5h5v5h-5z' },
    failed: { label: 'Failed', icon: 'M3 3l6 6M9 3 3 9' },
  };

  function statusBadge(status) {
    const info = STATUS[status] || { label: status, icon: '' };
    const span = el('span', 'scan-badge');
    const icon = svg('svg', { viewBox: '0 0 12 12', 'aria-hidden': 'true' });
    icon.appendChild(svg('path', { d: info.icon, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.6', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    span.append(icon, document.createTextNode(info.label));
    return span;
  }

  function renderScans() {
    const list = $('scan-list');
    list.textContent = '';
    $('scans-empty').hidden = state.history.length > 0;
    for (const h of state.history) {
      const button = el('button', 'scan-item');
      button.type = 'button';
      const head = el('span', 'scan-head');
      head.append(el('b', null, 'Scan ' + h.n), el('span', 'scan-platform', '· ' + (PLATFORM_NAME[h.platform] || h.platform)));
      head.appendChild(el('span', 'chip-mini', h.mode === 'quick' ? 'Quick' : h.rangeLabel ? (h.mode === 'full' ? 'Full · ' : '') + h.rangeLabel : 'Full'));
      head.appendChild(statusBadge(h.status));
      button.appendChild(head);
      button.appendChild(el('span', 'scan-time', SIT.formatScanTime(h.finishedAt)));
      const meta = ['Took ' + SIT.formatDuration(scanTook(h)), plural(h.found || 0, 'item') + ' collected'];
      if (h.windowStart) meta.push('covered since ' + SIT.formatDate(h.windowStart));
      button.appendChild(el('span', 'scan-meta', meta.join(' · ')));
      if (h.totals) {
        button.appendChild(el('span', 'scan-totals', totalsLabel(h) + ': posts ' + SIT.formatCompact(h.totals.post) +
          ' · comments ' + SIT.formatCompact(h.totals.comment) + ' · replies ' + SIT.formatCompact(h.totals.reply) +
          (h.waiting ? ' · ' + h.waiting + ' waiting for reply' : '')));
      }
      if (h.status === 'failed' && h.message) button.title = h.message;
      button.addEventListener('click', () => openSnapshot(h));
      const li = el('li');
      li.appendChild(button);
      list.appendChild(li);
    }
  }

  async function openSnapshot(entry) {
    const key = 'snap:' + entry.id;
    const data = await chrome.storage.local.get(key);
    if (!data[key]) {
      $('status').textContent = 'That scan’s saved stats are no longer available.';
      return;
    }
    state.snapshot = { entry, records: data[key].records || {} };
    showView('stats');
    render();
    $('app').scrollIntoView({ block: 'start' });
  }

  function closeSnapshot() {
    state.snapshot = null;
    render();
  }

  function renderSnapshotBanner() {
    const snap = state.snapshot;
    $('snapshot-banner').hidden = !snap;
    if (!snap) return;
    const e = snap.entry;
    $('snapshot-title').textContent = 'Scan ' + e.n + ' · ' + (PLATFORM_NAME[e.platform] || e.platform) + ' · ' + ((STATUS[e.status] || {}).label || e.status);
    $('snapshot-time').textContent = SIT.formatScanTime(e.finishedAt);
  }

  // ---------- settings view ----------

  const VIEWS = ['stats', 'insights', 'scans', 'settings', 'features'];
  const SUBVIEWS = ['settings', 'features']; // reached from the gear, not the tabs

  function showView(view) {
    state.view = view;
    for (const v of VIEWS) $('view-' + v).hidden = view !== v;
    const sub = SUBVIEWS.includes(view);
    $('view-nav').hidden = sub;
    $('btn-back').hidden = !sub;
    $('btn-settings').hidden = sub;
    for (const b of $('view-nav').querySelectorAll('button')) {
      const on = b.dataset.view === view;
      b.setAttribute('aria-selected', String(on));
      b.tabIndex = on ? 0 : -1;
    }
    if (view === 'settings') renderSettings();
    if (view === 'scans') renderScans();
    if (SIT.features) SIT.features.onView(view);
  }

  function renderSettings() {
    const s = state.settings;
    if (document.activeElement !== $('set-x')) $('set-x').value = s.xHandle || '';
    if (document.activeElement !== $('set-li')) $('set-li').value = s.linkedinProfile || '';
    $('set-expand').checked = !!s.expandComments;

    const xi = state.identity.x;
    $('detected-x').textContent = xi && xi.handle ? 'Detected: @' + xi.handle : 'Not detected yet. Open x.com while signed in.';
    const li = state.identity.linkedin;
    $('detected-li').textContent = li && (li.slug || li.name)
      ? 'Detected: ' + [li.name, li.slug ? 'linkedin.com/in/' + li.slug : null].filter(Boolean).join(' · ')
      : 'Not detected yet. Open linkedin.com while signed in.';

    const list = Object.values(state.records);
    const li2 = list.filter((r) => r.platform === 'linkedin').length;
    $('data-summary').textContent = plural(list.length, 'item') + ' stored · LinkedIn ' + SIT.formatFull(li2) + ' · X ' + SIT.formatFull(list.length - li2);
    if (SIT.features) SIT.features.renderSettings();
  }

  let saveTimer = null;
  function saveSettings() {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      state.settings = Object.assign({}, state.settings, {
        xHandle: $('set-x').value.trim().replace(/^@/, ''),
        linkedinProfile: $('set-li').value.trim(),
        expandComments: $('set-expand').checked,
      });
      chrome.storage.local.set({ settings: state.settings });
    }, 300);
  }

  function download(name, type, content) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const a = el('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  let clearArmed = null;
  function clearData() {
    const btn = $('clear-data');
    if (!clearArmed) {
      btn.textContent = 'Click again to delete';
      clearArmed = setTimeout(() => {
        clearArmed = null;
        btn.textContent = 'Clear all data';
      }, 4000);
      return;
    }
    clearTimeout(clearArmed);
    clearArmed = null;
    btn.textContent = 'Clear all data';
    chrome.runtime.sendMessage({ type: 'data:clear' });
  }

  // ---------- events ----------

  function arrowKeys(group, selector) {
    group.addEventListener('keydown', (e) => {
      if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
      const buttons = Array.from(group.querySelectorAll(selector));
      const i = buttons.indexOf(document.activeElement);
      if (i < 0) return;
      const next = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
      next.focus();
      next.click();
      e.preventDefault();
    });
  }

  function bind() {
    $('platform-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-platform]');
      if (!b) return;
      state.platform = b.dataset.platform;
      savePrefs();
      render();
    });
    $('range-seg').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-days]');
      if (!b) return;
      state.range = { type: 'days', days: Number(b.dataset.days) };
      savePrefs();
      render();
    });
    arrowKeys($('platform-seg'), 'button');
    arrowKeys($('range-seg'), 'button');
    $('month-select').addEventListener('change', (e) => {
      const [year, month] = e.target.value.split('-').map(Number);
      if (!Number.isFinite(year)) return;
      state.range = { type: 'month', year, month };
      savePrefs();
      render();
    });

    const tabs = document.querySelector('.tabs');
    tabs.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-tab]');
      if (!b) return;
      state.tab = b.dataset.tab;
      savePrefs();
      renderItems(state.summary);
    });
    arrowKeys(tabs, 'button[data-tab]');
    $('subtabs').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-sub]');
      if (!b || !state.sub[state.tab]) return;
      state.sub[state.tab] = b.dataset.sub;
      savePrefs();
      renderItems(state.summary);
    });
    arrowKeys($('subtabs'), 'button[data-sub]');
    $('recv-waiting').addEventListener('click', () => {
      const s = state.summary;
      state.tab = s.needs.comment.length || !s.needs.reply.length ? 'comments' : 'replies';
      state.sub[state.tab] = 'needs';
      savePrefs();
      renderItems(s);
      $('tab-' + state.tab).scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    });

    const chart = $('chart');
    chart.addEventListener('keydown', (e) => {
      const c = chart.__chart;
      if (!c) return;
      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        const start = state.hot < 0 ? (e.key === 'ArrowRight' ? -1 : c.days.length) : state.hot;
        setHot(Math.min(c.days.length - 1, Math.max(0, start + (e.key === 'ArrowRight' ? 1 : -1))));
        e.preventDefault();
      } else if (e.key === 'Escape') {
        setHot(-1);
      }
    });
    chart.addEventListener('blur', () => setHot(-1));

    $('btn-settings').addEventListener('click', () => showView('settings'));
    $('btn-back').addEventListener('click', () => { showView(state.view === 'features' ? 'settings' : 'stats'); if (state.view === 'stats') render(); });
    $('view-nav').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-view]');
      if (!b) return;
      showView(b.dataset.view);
      if (b.dataset.view === 'stats') render();
    });
    arrowKeys($('view-nav'), 'button[data-view]');
    $('snapshot-back').addEventListener('click', closeSnapshot);
    $('full-linkedin').addEventListener('click', () => startScan('linkedin', 'full'));
    $('full-x').addEventListener('click', () => startScan('x', 'full'));
    for (const id of ['set-x', 'set-li']) $(id).addEventListener('input', saveSettings);
    $('set-expand').addEventListener('change', saveSettings);
    $('export-csv').addEventListener('click', () => download('profile-lens-impressions.csv', 'text/csv', SIT.stats.toCSV(state.records)));
    $('export-json').addEventListener('click', () => download('profile-lens-impressions.json', 'application/json',
      JSON.stringify(Object.values(state.records), null, 2)));
    $('clear-data').addEventListener('click', clearData);

    $('scan-linkedin').addEventListener('click', () => startScan('linkedin'));
    $('scan-x').addEventListener('click', () => startScan('x'));
    $('scan-pause').addEventListener('click', async () => {
      const paused = state.scan && state.scan.status === 'paused';
      $('scan-pause').disabled = true;
      await chrome.runtime.sendMessage({ type: paused ? 'scan:resume' : 'scan:pause' }).catch(() => null);
      $('scan-pause').disabled = false;
      await loadScan();
      renderFooter();
    });
    $('scan-stop').addEventListener('click', async () => {
      await chrome.runtime.sendMessage({ type: 'scan:stop' }).catch(() => null);
      await loadScan();
      renderFooter();
    });

    let refresh = null;
    let localChanged = false;
    chrome.storage.onChanged.addListener((changes, area) => {
      clearTimeout(refresh);
      if (area === 'local') localChanged = true;
      refresh = setTimeout(async () => {
        await loadScan();
        if (!localChanged) return renderFooter(); // scan progress only changes the footer
        localChanged = false;
        await loadData();
        if (state.view === 'settings') renderSettings();
        else if (state.view === 'scans') renderScans();
        else render(); // a snapshot keeps showing its own frozen records
        renderFooter();
      }, 250);
    });
  }

  async function init() {
    loadPrefs();
    bind();
    // features.js may load before or after this point; whichever comes second wires up.
    const bridge = { state, el, plural, meter, openUrl, render, showView, renderFooter, download, loadData, nowTs, dataRecords, loaded: false };
    SIT.popupBridge = bridge;
    if (SIT.features) SIT.features.init(bridge);
    await chrome.runtime.sendMessage({ type: 'accounts:stamp' }).catch(() => null);
    await Promise.all([loadData(), loadScan()]);
    bridge.loaded = true;
    if (SIT.features) SIT.features.ready();
    showView('stats');
    render();
  }

  init().catch((err) => { console.error(err); const st = $('status'); if (st) st.textContent = 'Something went wrong while opening the popup. Reload it, or clear the extension data in Settings.'; });
})();
