// Shared helpers used by the content scripts, the popup and the Node tests.
(function (root) {
  'use strict';
  const SIT = root.SIT || (root.SIT = {});

  const DAY = 24 * 60 * 60 * 1000;
  const MIN_TS = Date.UTC(2006, 2, 1);
  const X_EPOCH = 1288834974657n;

  SIT.DAY = DAY;

  // "1,234" -> 1234, "1.2K" -> 1200, "3M" -> 3000000, "1.234" -> 1234
  SIT.parseCount = function parseCount(input) {
    if (input == null) return null;
    if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input) : null;
    // Some languages group thousands with a (thin or non-breaking) space: "1 234".
    const text = String(input).replace(/[   ]/g, ' ').replace(/(\d) (?=\d{3}(?!\d))/g, '$1');
    const m = text.match(/(\d[\d.,]*)\s*([KkMmBb](?![a-z]))?/);
    if (!m) return null;
    let digits = m[1].replace(/[.,]+$/, '');
    const suffix = m[2] ? m[2].toUpperCase() : '';
    let value;
    if (suffix) {
      // "1,234.5K": with both separators, the last one is the decimal point.
      if (/[.,].*[.,]/.test(digits)) digits = digits.replace(/[.,](?=.*[.,])/g, '');
      value = parseFloat(digits.replace(',', '.'));
      value *= suffix === 'K' ? 1e3 : suffix === 'M' ? 1e6 : 1e9;
    } else if (/^\d{1,3}([.,]\d{3})+$/.test(digits)) {
      value = parseInt(digits.replace(/[.,]/g, ''), 10);
    } else {
      value = parseFloat(digits.replace(',', '.'));
    }
    return Number.isFinite(value) ? Math.round(value) : null;
  };

  SIT.plausibleTs = function plausibleTs(ms) {
    return typeof ms === 'number' && Number.isFinite(ms) && ms > MIN_TS && ms < Date.now() + 2 * DAY;
  };

  // X post ids are snowflakes: the top bits hold milliseconds since the X epoch.
  SIT.xIdToMs = function xIdToMs(id) {
    try {
      const ms = Number((BigInt(String(id)) >> 22n) + X_EPOCH);
      return SIT.plausibleTs(ms) ? ms : null;
    } catch (_) {
      return null;
    }
  };

  // LinkedIn activity / ugcPost / comment ids carry a Unix-ms timestamp in the top 41 bits.
  SIT.liIdToMs = function liIdToMs(id) {
    try {
      const ms = Number(BigInt(String(id)) >> 22n);
      return SIT.plausibleTs(ms) ? ms : null;
    } catch (_) {
      return null;
    }
  };

  // Converts "5h", "3d", "2w", "4mo", "1yr", "2 days ago" into an approximate timestamp.
  SIT.relativeToMs = function relativeToMs(text, now) {
    if (!text) return null;
    now = now || Date.now();
    const t = String(text).toLowerCase();
    if (/\b(now|just now)\b/.test(t)) return now;
    const m = t.match(/(\d+)\s*(years?|yrs?|y|months?|mos?|weeks?|wks?|w|days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/);
    if (!m) return null;
    const n = parseInt(m[1], 10);
    const unit = m[2];
    let ms;
    if (/^y/.test(unit)) ms = n * 365 * DAY;
    else if (/^mo/.test(unit)) ms = n * 30 * DAY;
    else if (/^w/.test(unit)) ms = n * 7 * DAY;
    else if (/^d/.test(unit)) ms = n * DAY;
    else if (/^h/.test(unit)) ms = n * 3600e3;
    else if (/^m/.test(unit)) ms = n * 60e3;
    else ms = n * 1e3;
    return now - ms;
  };

  SIT.truncate = function truncate(text, max) {
    if (!text) return '';
    // Count code points so emoji and styled letters (𝐁𝐎𝐋𝐃) are never cut in half.
    const chars = Array.from(String(text).replace(/\s+/g, ' ').trim());
    return chars.length > max ? chars.slice(0, max - 1).join('').trimEnd() + '…' : chars.join('');
  };

  SIT.eqi = function eqi(a, b) {
    return !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
  };

  SIT.hash = function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
  };

  SIT.sleep = function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  };

  // ---------- formatting (popup) ----------

  SIT.formatFull = function formatFull(n) {
    return new Intl.NumberFormat('en-US').format(Math.round(n || 0));
  };

  // 1,284 / 12.9K / 4.2M
  SIT.formatCompact = function formatCompact(n) {
    n = Math.round(n || 0);
    if (Math.abs(n) < 10000) return SIT.formatFull(n);
    return new Intl.NumberFormat('en-US', { notation: 'compact', maximumFractionDigits: 1 }).format(n);
  };

  SIT.formatDate = function formatDate(ts, withYear) {
    const opts = { month: 'short', day: 'numeric' };
    if (withYear) opts.year = 'numeric';
    return new Date(ts).toLocaleDateString('en-US', opts);
  };

  // Zones where the browser's time-zone data has no English abbreviation (it would say "GMT+5").
  const ZONE_ABBR = {
    'Asia/Karachi': 'PKT', 'Asia/Kolkata': 'IST', 'Asia/Calcutta': 'IST', 'Asia/Dhaka': 'BST', 'Asia/Kathmandu': 'NPT',
    'Asia/Colombo': 'SLST', 'Asia/Dubai': 'GST', 'Asia/Muscat': 'GST', 'Asia/Riyadh': 'AST', 'Asia/Qatar': 'AST',
    'Asia/Kuwait': 'AST', 'Asia/Bahrain': 'AST', 'Asia/Baghdad': 'AST', 'Asia/Tehran': 'IRST', 'Asia/Kabul': 'AFT',
    'Asia/Tashkent': 'UZT', 'Asia/Almaty': 'ALMT', 'Asia/Bangkok': 'ICT', 'Asia/Ho_Chi_Minh': 'ICT', 'Asia/Jakarta': 'WIB',
    'Asia/Singapore': 'SGT', 'Asia/Kuala_Lumpur': 'MYT', 'Asia/Manila': 'PHT', 'Asia/Hong_Kong': 'HKT',
    'Asia/Shanghai': 'CST', 'Asia/Taipei': 'CST', 'Asia/Tokyo': 'JST', 'Asia/Seoul': 'KST', 'Europe/Istanbul': 'TRT',
    'Europe/Moscow': 'MSK', 'Africa/Lagos': 'WAT', 'Africa/Nairobi': 'EAT', 'Africa/Johannesburg': 'SAST',
    'America/Sao_Paulo': 'BRT', 'America/Argentina/Buenos_Aires': 'ART', 'America/Bogota': 'COT', 'America/Lima': 'PET',
    'UTC': 'UTC', 'Etc/UTC': 'UTC',
  };

  function localTimeZone() {
    try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (_) { return undefined; }
  }

  // Minutes east of UTC for a zone at a moment.
  function zoneOffsetMinutes(date, timeZone) {
    if (!timeZone) return -date.getTimezoneOffset();
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-US', {
      timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric',
    }).formatToParts(date)) parts[p.type] = Number(p.value);
    const asUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second);
    return Math.round((asUtc - Math.floor(date.getTime() / 1000) * 1000) / 60000);
  }

  function zoneAbbreviation(date, timeZone) {
    const locales = [];
    try { if (typeof navigator !== 'undefined' && navigator.language) locales.push(navigator.language); } catch (_) { /* no navigator */ }
    locales.push('en-US', 'en-GB', 'en-AU', 'en-IN', 'en-NZ', 'en-CA', 'en-ZA', 'en-AE');
    for (const locale of locales) {
      try {
        const part = new Intl.DateTimeFormat(locale, { timeZone, timeZoneName: 'short' })
          .formatToParts(date).find((p) => p.type === 'timeZoneName');
        if (part && /^[A-Z]{2,5}$/.test(part.value) && !/^(GMT|UTC)$/.test(part.value)) return part.value;
      } catch (_) { /* unsupported locale */ }
    }
    return ZONE_ABBR[timeZone] || null;
  }

  // "16th September, 2026 3:35 pm PKT (GMT +5)" in the browser's own time zone.
  SIT.formatScanTime = function formatScanTime(ts, timeZone) {
    const date = new Date(ts);
    timeZone = timeZone || localTimeZone();
    const parts = {};
    for (const p of new Intl.DateTimeFormat('en-GB', {
      timeZone, day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(date)) parts[p.type] = p.value;
    const day = Number(parts.day);
    const v = day % 100;
    const suffix = v >= 11 && v <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][day % 10] || 'th';
    const offset = zoneOffsetMinutes(date, timeZone);
    const abs = Math.abs(offset);
    const gmt = 'GMT ' + (offset < 0 ? '-' : '+') + Math.floor(abs / 60) + (abs % 60 ? ':' + String(abs % 60).padStart(2, '0') : '');
    const abbr = zoneAbbreviation(date, timeZone);
    const time = parts.hour + ':' + parts.minute + ' ' + String(parts.dayPeriod || '').toLowerCase();
    return day + suffix + ' ' + parts.month + ', ' + parts.year + ' ' + time.trim() + (abbr ? ' ' + abbr : '') + ' (' + gmt + ')';
  };

  SIT.formatDuration = function formatDuration(ms) {
    const s = Math.max(0, Math.round((ms || 0) / 1000));
    if (s < 60) return s + 's';
    const m = Math.floor(s / 60);
    return m < 60 ? m + 'm ' + (s % 60) + 's' : Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  };

  SIT.timeAgo = function timeAgo(ts, now) {
    if (!ts) return 'never';
    const diff = Math.max(0, (now || Date.now()) - ts);
    if (diff < 60e3) return 'just now';
    if (diff < 3600e3) return Math.floor(diff / 60e3) + 'm ago';
    if (diff < DAY) return Math.floor(diff / 3600e3) + 'h ago';
    return Math.floor(diff / DAY) + 'd ago';
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = SIT;
})(typeof globalThis !== 'undefined' ? globalThis : this);
