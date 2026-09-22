const test = require('node:test');
const assert = require('node:assert/strict');
const { loadSIT } = require('./helpers');

const SIT = loadSIT();

test('parseCount handles the formats both sites display', () => {
  assert.equal(SIT.parseCount('1,234'), 1234);
  assert.equal(SIT.parseCount('1.2K'), 1200);
  assert.equal(SIT.parseCount('12K views'), 12000);
  assert.equal(SIT.parseCount('3.4M'), 3400000);
  assert.equal(SIT.parseCount('987'), 987);
  assert.equal(SIT.parseCount('1.234'), 1234);
  assert.equal(SIT.parseCount('45 impressions'), 45);
  assert.equal(SIT.parseCount('1234 views. View post analytics'), 1234);
  assert.equal(SIT.parseCount('3 min'), 3);
  assert.equal(SIT.parseCount(56), 56);
  assert.equal(SIT.parseCount('no numbers'), null);
  assert.equal(SIT.parseCount(null), null);
});

test('X snowflake ids decode to the post time', () => {
  // Build an id the way X does: (ms - X epoch) << 22 | worker/sequence bits.
  const posted = Date.UTC(2022, 8, 15, 10, 39, 8, 878);
  const id = (((BigInt(posted) - 1288834974657n) << 22n) | 12345n).toString();
  assert.equal(SIT.xIdToMs(id), posted);
  assert.equal(SIT.xIdToMs('not-an-id'), null);
});

test('LinkedIn ids decode to plausible timestamps', () => {
  const ms = SIT.liIdToMs('7240000000000000000');
  assert.equal(new Date(ms).getUTCFullYear(), 2024);
  assert.equal(SIT.liIdToMs('12'), null);
});

test('relativeToMs understands LinkedIn short times', () => {
  const now = Date.UTC(2026, 8, 17, 12);
  const DAY = SIT.DAY;
  assert.equal(SIT.relativeToMs('3d • Edited', now), now - 3 * DAY);
  assert.equal(SIT.relativeToMs('2w', now), now - 14 * DAY);
  assert.equal(SIT.relativeToMs('4mo', now), now - 120 * DAY);
  assert.equal(SIT.relativeToMs('1yr', now), now - 365 * DAY);
  assert.equal(SIT.relativeToMs('5h', now), now - 5 * 3600e3);
  assert.equal(SIT.relativeToMs('12m', now), now - 12 * 60e3);
  assert.equal(SIT.relativeToMs('2 days ago', now), now - 2 * DAY);
  assert.equal(SIT.relativeToMs('Edited', now), null);
});

test('formatCompact keeps small numbers exact', () => {
  assert.equal(SIT.formatCompact(1284), '1,284');
  assert.equal(SIT.formatCompact(12900), '12.9K');
  assert.equal(SIT.formatCompact(4200000), '4.2M');
});

test('scan times show the viewer\'s zone abbreviation and GMT offset', () => {
  const t = Date.UTC(2026, 8, 16, 10, 35);
  assert.equal(SIT.formatScanTime(t, 'Asia/Karachi'), '16th September, 2026 3:35 pm PKT (GMT +5)');
  assert.equal(SIT.formatScanTime(t, 'America/New_York'), '16th September, 2026 6:35 am EDT (GMT -4)');
  assert.equal(SIT.formatScanTime(Date.UTC(2026, 0, 1, 23, 5), 'America/New_York'), '1st January, 2026 6:05 pm EST (GMT -5)');
  assert.equal(SIT.formatScanTime(t, 'Europe/London'), '16th September, 2026 11:35 am BST (GMT +1)');
  assert.equal(SIT.formatScanTime(t, 'Asia/Kolkata'), '16th September, 2026 4:05 pm IST (GMT +5:30)');
  assert.equal(SIT.formatScanTime(t, 'UTC'), '16th September, 2026 10:35 am UTC (GMT +0)');
  assert.equal(SIT.formatScanTime(Date.UTC(2026, 8, 22, 0, 0), 'Asia/Karachi'), '22nd September, 2026 5:00 am PKT (GMT +5)');
  assert.equal(SIT.formatScanTime(Date.UTC(2026, 8, 13, 0, 0), 'Asia/Karachi'), '13th September, 2026 5:00 am PKT (GMT +5)');
  assert.match(SIT.formatScanTime(t, 'America/Argentina/Salta'), /^16th September, 2026 7:35 am (\w+ )?\(GMT -3\)$/, 'unknown abbreviations fall back to the offset only');
});

test('durations read naturally', () => {
  assert.equal(SIT.formatDuration(45000), '45s');
  assert.equal(SIT.formatDuration(134000), '2m 14s');
  assert.equal(SIT.formatDuration(3.9e6), '1h 5m');
});

test('parseCount reads numbers grouped with spaces and numbers with both separators', () => {
  assert.equal(SIT.parseCount('1\u202f234 impressions'), 1234);
  assert.equal(SIT.parseCount('1\u00a0234'), 1234);
  assert.equal(SIT.parseCount('12 345 678'), 12345678);
  assert.equal(SIT.parseCount('1,234.5K'), 1234500);
  assert.equal(SIT.parseCount('3 comments'), 3, 'a count followed by a word is left alone');
});
