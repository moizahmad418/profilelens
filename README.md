# Profile Lens

Version 1.3.1.

## What changed in this release (1.3.1)

- **Stats only come from scans.** Nothing is shown after installing until you run a scan, and browsing LinkedIn or X no longer adds anything to your numbers. Earlier versions also recorded whatever happened to load while you browsed, which gave partial, misleading numbers before the first scan. Items stored that way before any scan are removed once.
- **A scan covers the range you picked.** Pick 1D, 3D, 7D, 10D, 30D or a month on the Dashboard, then click **Scan LinkedIn** or **Scan X**: the scan goes back exactly that far. **Full scan** in the Scans tab covers the last 30 days. The "quick scan" and "how far back" settings are gone.
- **Scan history says what each scan covered.** A 10-day scan now shows "Last 10 days then: …" with totals for that site and that range (it used to say "Last 30 days then" for every scan, with both sites mixed together).
- **Pause and resume.** The scan card and the popup have a **Pause** button. **Resume** continues from where the scan stopped: in place when the scan tab is still there, otherwise the scan's page is loaded again (or a new tab opens) at the step it was on. Finished steps are never repeated. If the scan's page got stuck, pause, open a new LinkedIn or X tab, and click **Resume** in the popup: the scan moves to the tab you are looking at. Paused time isn't counted in "Took …".
- **Stay on the scan tab.** The scan card and the popup say so while a scan runs, because switching tabs can lead to incomplete or misleading stats. If you do leave the tab, the scan pauses by itself and continues when you come back.
- **A range that was never fully scanned says so.** If you look at 30D after only scanning 7D, the Dashboard notes that the range is incomplete and how to fill it.
- **New icon and logo.**
- Fixes: what the scan tab has collected is saved before a stopped scan is recorded (the last items used to be missing from its stats); a progress update can no longer undo a step change; the X pager no longer gives up after 5 minutes while it is still making progress; LinkedIn's comment API is only called during scans. Counts written with a space as the thousands separator ("1 234") are read correctly; the daily chart no longer loses days after a daylight-saving change; two comment threads on the same post are both opened during a LinkedIn scan; CSV exports can no longer start a cell with a formula; Stop and Pause also stop LinkedIn's comment lookups; a closed scan card stays closed; only the popup can start scans or clear data.

## Changes from Profile Lens 2 (1.3.0)

- **Clearer level colors.** Orange and red are now a true orange and a deep true red, re-checked for color blindness and normal vision. Meter bars are larger, and empty bars carry a light wash of the level's color, so even a one-bar "very low" meter reads red.
- **Scans tab.** Every scan is listed with its number, site, result and time in your browser's own time zone, e.g. `Scan 3 · LinkedIn — 16th September, 2026 3:35 pm PKT (GMT +5)`.
- **Frozen scan stats.** Opening a scan shows the whole dashboard exactly as it was when that scan finished, with all filters and tabs. Newer data never changes it. The last 20 scans are kept.
- **Much faster scans.**
  - **X:** reads timelines page by page through X's own requests instead of scrolling (checked on a live account). It also switches between your Posts, Replies and Mentions without reloading.
  - **LinkedIn:** checks comments 4 at a time, skips comments whose reply status can't have changed, and only reopens posts and threads whose comment count changed since the last scan. It waits for content to appear instead of sleeping.
- **Less page freezing:** finding "See previous replies" no longer reads the text of every element on the page, unchanged cards and comments aren't re-read, and saves to storage are batched.

## About

A Chrome / Edge / Brave extension that totals the impressions on your **LinkedIn** and **X** posts, comments and replies, shows who is waiting for your reply, and presents it all in a popup card with 1‑day, 3‑day, 7‑day, 10‑day, 30‑day and month views.

Everything stays in your browser. Nothing is sent to any server.

## Install (about 1 minute)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Then search for Profile Lens. Once found, click add to chrome / edge / brave.
4. Pin the extension (puzzle-piece icon → pin **Profile Lens**).

Your stored data carries over from earlier versions. Run a scan on each site once so existing items are re-sorted into comments and replies.

## Use it

- **Scan:** pick the range on the Dashboard (1D, 3D, 7D, 10D, 30D or a month), then click **Scan LinkedIn** or **Scan X**. The extension opens your activity pages in a new tab with a small progress card in the corner and collects everything from that range. **Full scan** in the Scans tab covers the last 30 days. Nothing is shown until your first scan.
- **Pause / Resume / Stop:** on the scan card and in the popup. Resume continues from where the scan stopped.
- **Scans tab:** lists past scans with their date, time, time zone and range. Click one to see the dashboard as it was then, and **Back to latest stats** to return.

| Scan | Pages it reads |
|---|---|
| X | `x.com/<you>` (your posts), `x.com/<you>/with_replies` (your comments and replies), then `x.com/notifications/mentions` (comments and replies you received). Each timeline is read page by page through X's own request, falling back to scrolling if X refuses. |
| LinkedIn | `/in/<you>/recent-activity/all/` (your posts), each recent post whose comment count changed, `/recent-activity/comments/` (your comments and replies), then each comment thread whose replies changed (or that you replied in during the last week) |

Stay on the scan tab while it runs. LinkedIn only loads impression counts for a page you can see, and Chrome slows down background tabs, so the scan pauses by itself while its tab isn't in front and continues when you come back.

## What the popup shows

- **Filters:** All / LinkedIn / X, and 1D · 3D · 7D · 10D · 30D · a month picker.
- **Impressions:** tiles for posts, comments and replies, each with the item count, average and its level meter.
- **By publish day** chart with posts, comments and replies stacked (hover or use the arrow keys for exact values).
- **Breakdown** table with averages rated by level, split by platform.
- **Engagement:** comments on your posts, responses to your comments and replies, and how many are **waiting for your reply** (click it to jump to the list).
- **Posts / Comments / Replies** tabs. Comments and Replies have **All** and **Needs reply** sub-tabs.
- **Settings:** override your X handle or LinkedIn profile, export CSV/JSON (including impression level), clear data.

### How the numbers are counted

- Time ranges are **by publish date**: "7D" means items you published in the last 7 calendar days (including today), with their latest known lifetime impressions. Needs reply lists use the date the response arrived.
- **Impression levels** compare an item with the median of your items of the same type on the same platform: very high (green) is 2× or more, high (blue) 1.25×, medium (yellow) around your usual, low (orange) under 0.75×, very low (red) under 0.4×. Levels appear once there are 5 items of a type. The number of filled bars shows the level too, so it doesn't rely on color alone. In dark mode the red is a deeper berry red so it stays distinguishable from orange.
- **X threads** are a tree: a response waits on you until you reply to that exact post.
- **LinkedIn threads** are one level deep (a top-level comment plus replies), so a response belongs to your most recent message before it in that thread, and it waits on you until you post again in the thread.
- A thread counts as **became a thread** once it has 3 or more messages.
- Impression counts only ever go up. Rescanning refreshes them. An item with no visible count is listed but left out of the totals.

## How it reads the data

- **X:** The site's own API responses are copied as they arrive (`src/injected/net-hook.js`) and parsed for posts and their view counts (`src/lib/x-parser.js`). Replies carry the exact post they answer, which builds the reply tree.
- **LinkedIn:** Posts and comments are read from the page (`src/lib/li-parser.js`) using `componentkey` attributes, analytics links and the "1,234 impressions" text. Each comment is then checked with `/voyager/api/voyagerSocialDashComments/…`, which gives its latest impressions, its reply count (`numComments`) and, for replies, the parent comment (`parentCommentBackendUrn`). Others' comments on a post page are checked only when you are in that conversation, and kept only if they reply in your thread.
- Your account is detected automatically (X: login cookie and profile link; LinkedIn: `/voyager/api/me`). If detection fails, set it in Settings.

## Limitations

- LinkedIn and X change their page structure without notice. If numbers stop appearing, the parsers in `src/lib/` need updating.
- LinkedIn only shows impressions on content you're allowed to see analytics for. Some comments have no count.
- On LinkedIn, replies to you are found by opening threads, during a scan. A scan only opens threads where the API reports replies, up to 40 per scan.
- On X, replies to you come from your Mentions timeline. Very old replies beyond what X loads there won't appear.
- The scan scrolls automatically. Keep scan depth reasonable; very long scans can hit the sites' rate limits.
- The page text matching expects the sites in **English**.

## Development

```bash
npm test          # parser, stats and background worker tests (Node 18+)
npm run preview   # http://localhost:5178 — popup with sample data
npm run icons     # regenerate icons/*.png from tools/logo.png
```

Browser test pages (open them while `npm run preview` is running):

- `/tests/browser/linkedin-dom-v2.html`: LinkedIn's 2026 page design against sample markup
- `/tests/browser/linkedin-dom.html`: the older LinkedIn page design
- `/tests/browser/content-linkedin-threads.html`: LinkedIn reply detection with a fake comment API
- `/tests/browser/x-pager.html`: X timeline paging with a fake timeline API
- `/tests/browser/content-x.html`, `/tests/browser/content-linkedin.html`: content-script wiring with a fake extension API (add `?idle` to the X page to check that nothing is saved outside a scan)
- `/tests/browser/scan-pause.html`: the scan loop pausing, resuming and finishing

```
manifest.json
src/
  background.js            storage, de-duplication, guided scans, scan history + snapshots
  injected/net-hook.js     copies site API responses; pages X timelines for scans (page world)
  lib/common.js            number/date helpers
  lib/x-parser.js          X payload → records
  lib/li-parser.js         LinkedIn page + comment API → records
  lib/stats.js             totals, impression levels, conversations waiting on you
  content/                 per-site content scripts, scan loop, progress card
  popup/                   the popup card
tests/                     Node tests + browser test pages
tools/                     icon generator, preview server, fake chrome API
```

Author and Publisher:

#Moiz Ahmad
LinkedIn: https://linkedin.com/in/moizahmad418
x: https://x.com/moizahmad418
Website: moizahmad.vercel.app