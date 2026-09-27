# Profile Lens

Version 1.4.0.

## What's new in 1.4.0

Everything below works for both LinkedIn and X.

- **Insights tab.** One place for "what should I change":
  - **Best time to post:** a weekday-by-hour grid of your average impressions, with your best slot in one sentence ("Your best slot: Tue and Thu, 8 am–10 am").
  - **Post types:** text, image, video, document, link, poll, quote and carousel posts compared.
  - **Length and hooks:** post length, first-line length, hashtags and questions against your impressions.
  - **Engagement return:** whose posts your comments earn the most impressions on.
  - **Top supporters:** the people who comment and reply on your content most often.
  - **Follower trend:** your follower count over time, recorded by each scan.
  - **Reply time:** how fast you usually reply.
  - **Comment check:** paste a comment before posting it; it flags stock phrases, very short comments and near-repeats of comments you already posted.
- **Dashboard.**
  - Every tile shows the change against the period before ("↑ 34%").
  - **This week:** your weekly goals for posts, comments and replies, how far you are, and your streak of weeks that met them (set the goals in Settings).
  - **Weekly digest:** each week, a card with last week's total, best and weakest post, follower change and replies waiting. **Share as image** saves it as a picture.
  - **Why?** on any post: how it compares with your usual, and whether its time, type or length explains it.
  - **Needs reply** shows how long each person has been waiting, and how fast you usually reply.
  - Follower change for the period shown, under the platform split.
- **Scans tab: automatic scans.** A daily scan at a time you pick, of the sites you pick, covering the last 1, 3 or 7 days. It runs in a small window that closes by itself. Chrome has to be running.
- **Settings.**
  - **Reminders:** a notification when someone has waited for your reply longer than 4 hours, 12 hours, a day or 2 days. Off by default.
  - **Backup and restore:** save everything to a file and load it into another browser or a newer version, merging with or replacing what is there.
  - **Accounts:** stats of different LinkedIn or X accounts stay apart. The Dashboard shows the account you are signed in to; remove any account's data in Settings.
  - **Features:** a page listing every feature and the tab it lives in, and a button to show the tour again.
- **First-run tour** and a **What's new** card after each update, so nothing has to be discovered by accident. Empty states say what a section needs before it can show something ("appears after 5 posts").
- **Languages.** LinkedIn scans now also work with the LinkedIn interface in Spanish, French, German, Portuguese, Italian, Dutch and Turkish.
- New permissions: **alarms** (automatic scans) and **notifications** (reminders). Both are only used when you turn those features on.

## Earlier releases

### 1.3.1

- **Stats only come from scans.** Nothing is shown after installing until you run a scan, and browsing LinkedIn or X adds nothing to your numbers.
- **A scan covers the range you picked.** Pick 1D, 3D, 7D, 10D, 30D or a month on the Dashboard, then click **Scan LinkedIn** or **Scan X**. **Full scan** in the Scans tab covers the last 30 days.
- **Scan history says what each scan covered**, with totals for that site and that range.
- **Pause and resume.** The scan card and the popup have a **Pause** button. **Resume** continues from where the scan stopped, in place or in a new tab, and can move to the tab you are looking at.
- **Stay on the scan tab.** The scan pauses by itself while its tab isn't in front and continues when you come back.
- **A range that was never fully scanned says so.**
- New icon and logo, and many fixes.

### 1.3.0

- Clearer level colors, the Scans tab with frozen scan stats, much faster X and LinkedIn scans, less page freezing.

## About

A Chrome / Edge / Brave extension that totals the impressions on your **LinkedIn** and **X** posts, comments and replies, shows who is waiting for your reply, tells you when and what to post, and presents it all in a popup card with 1‑day, 3‑day, 7‑day, 10‑day, 30‑day and month views.

Everything stays in your browser. Nothing is sent to any server.

## Install (about 1 minute)

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Then search for Profile Lens. Once found, click add to chrome / edge / brave.
3. Pin the extension (puzzle-piece icon → pin **Profile Lens**).

Your stored data carries over from earlier versions. Run a scan on each site once after updating. To move your data to another browser, use **Settings → Backup and restore**.

## Use it

- **Scan:** pick the range on the Dashboard (1D, 3D, 7D, 10D, 30D or a month), then click **Scan LinkedIn** or **Scan X**. The extension opens your activity pages in a new tab with a small progress card in the corner and collects everything from that range. **Full scan** in the Scans tab covers the last 30 days. Nothing is shown until your first scan.
- **Pause / Resume / Stop:** on the scan card and in the popup. Resume continues from where the scan stopped.
- **Automatic scans:** in the Scans tab, turn on **Scan automatically every day**, pick the time, the sites and how many days each scan covers.
- **Dashboard:** the numbers for the range you picked, with the change against the period before, your weekly goals, the weekly digest, **Why?** on each post and who is waiting for your reply.
- **Insights:** best time to post, post types, length and hooks, engagement return, top supporters, follower trend, reply time and the comment check. Pick a site and how far back to look (30 days to everything scanned).
- **Scans tab:** lists past scans with their date, time, time zone and range. Click one to see the dashboard as it was then, and **Back to latest stats** to return.
- **Settings:** weekly goals, reminders, backup and restore, accounts, your X handle or LinkedIn profile, export CSV/JSON, clear data, the Features page and the tour.

| Scan | Pages it reads |
|---|---|
| X | `x.com/<you>` (your posts and your follower count), `x.com/<you>/with_replies` (your comments and replies), then `x.com/notifications/mentions` (comments and replies you received). Each timeline is read page by page through X's own request, falling back to scrolling if X refuses. |
| LinkedIn | `/in/<you>/recent-activity/all/` (your posts), each recent post whose comment count changed, `/recent-activity/comments/` (your comments and replies), then each comment thread whose replies changed (or that you replied in during the last week). Your follower count comes from LinkedIn's own profile network-info request. |

Stay on the scan tab while it runs. LinkedIn only loads impression counts for a page you can see, and Chrome slows down background tabs, so the scan pauses by itself while its tab isn't in front and continues when you come back. Automatic scans run in their own small window and don't pause; leave that window alone until it closes.

## What the popup shows

- **Filters:** All / LinkedIn / X, and 1D · 3D · 7D · 10D · 30D · a month picker.
- **This week:** goals and streak (once goals are set in Settings).
- **Impressions:** tiles for posts, comments and replies, each with the item count, average, level meter and the change against the period before.
- **By publish day** chart with posts, comments and replies stacked (hover or use the arrow keys for exact values).
- **Breakdown** table with averages rated by level, split by platform, and the follower change for the period.
- **Engagement:** comments on your posts, responses to your comments and replies, and how many are **waiting for your reply** (click it to jump to the list).
- **Posts / Comments / Replies** tabs. Posts have **Why?**; Comments and Replies have **All** and **Needs reply** sub-tabs, with waiting times.
- **Insights** and **Scans** tabs, and **Settings** behind the gear.

### How the numbers are counted

- Time ranges are **by publish date**: "7D" means items you published in the last 7 calendar days (including today), with their latest known lifetime impressions. Needs reply lists use the date the response arrived. The change shown on each tile compares with the same number of days right before ("the month before" for a month).
- **Impression levels** compare an item with the median of your items of the same type on the same platform: very high (green) is 2× or more, high (blue) 1.25×, medium (yellow) around your usual, low (orange) under 0.75×, very low (red) under 0.4×. Levels appear once there are 5 items of a type. The number of filled bars shows the level too, so it doesn't rely on color alone.
- **Weeks** run Monday to Sunday in your own time zone. A streak counts consecutive weeks that met every goal you set; this week counts as soon as it has.
- **Best time to post** needs 5 posts with impression counts; each slot needs 2 posts before it is rated. Post types, lengths and hooks need 2 posts per group. **Why?** needs 3 other posts to compare with. Lengths count what the scan reads of each post (up to 280 characters).
- **Reply time** is the median time between someone's response and your next message in that conversation.
- **X threads** are a tree: a response waits on you until you reply to that exact post.
- **LinkedIn threads** are one level deep (a top-level comment plus replies), so a response belongs to your most recent message before it in that thread, and it waits on you until you post again in the thread.
- A thread counts as **became a thread** once it has 3 or more messages.
- Impression counts only ever go up. Rescanning refreshes them. An item with no visible count is listed but left out of the totals.
- **Follower counts** are recorded once per day per site, whenever a scan sees them.

## How it reads the data

- **X:** The site's own API responses are copied as they arrive (`src/injected/net-hook.js`) and parsed for posts, their view counts and their type (`src/lib/x-parser.js`). Replies carry the exact post they answer, which builds the reply tree.
- **LinkedIn:** Posts and comments are read from the page (`src/lib/li-parser.js`) using `componentkey` attributes, analytics links and the "1,234 impressions" text, in any of the supported interface languages. Each comment is then checked with `/voyager/api/voyagerSocialDashComments/…`, which gives its latest impressions, its reply count (`numComments`) and, for replies, the parent comment (`parentCommentBackendUrn`). Others' comments on a post page are checked only when you are in that conversation, and kept only if they reply in your thread.
- Your account is detected automatically (X: login cookie and profile link; LinkedIn: `/voyager/api/me`). If detection fails, set it in Settings.
- Advice (`src/lib/insights.js`) is computed from the stored records alone: nothing is sent anywhere.

## Limitations

- LinkedIn and X change their page structure without notice. If numbers stop appearing, the parsers in `src/lib/` need updating.
- LinkedIn only shows impressions on content you're allowed to see analytics for. Some comments have no count.
- On LinkedIn, replies to you are found by opening threads, during a scan. A scan only opens threads where the API reports replies, up to 40 per scan.
- On X, replies to you come from your Mentions timeline. Very old replies beyond what X loads there won't appear.
- The scan scrolls automatically. Keep scan depth reasonable; very long scans can hit the sites' rate limits.
- LinkedIn's page text is matched in English, Spanish, French, German, Portuguese, Italian, Dutch and Turkish. X is read from its API, so its interface language doesn't matter.
- Automatic scans and reminders only run while Chrome is open.

## Development

```bash
npm test          # parser, stats, insights and background worker tests (Node 18+)
npm run preview   # http://localhost:5178 — popup with sample data
npm run icons     # regenerate icons/*.png from tools/logo.png
```

Preview pages: `?view=insights` or `?view=scans` opens that tab, `?settings` opens Settings, `?features` the Features page, `?tour` the tour, `?scanning` a running scan, `?new` the What's new card, `?empty` no data.

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
  background.js            storage, de-duplication, guided and automatic scans, scan history + snapshots,
                           followers, reminders, backup and restore, accounts
  injected/net-hook.js     copies site API responses; pages X timelines for scans (page world)
  lib/common.js            number/date helpers
  lib/x-parser.js          X payload → records (with post types and follower counts)
  lib/li-parser.js         LinkedIn page + comment API → records (with post types, in 8 languages)
  lib/stats.js             totals, impression levels, conversations waiting on you
  lib/insights.js          best times, post types, length and hooks, supporters, engagement return,
                           reply times, goals and streaks, the digest, "Why?", the comment check
  content/                 per-site content scripts, scan loop, progress card
  popup/popup.js           the dashboard, scans and settings
  popup/features.js        Insights, digest, goals, deltas, tour, Features page, backup, accounts
tests/                     Node tests + browser test pages
tools/                     icon generator, preview server, fake chrome API
```

Author and Publisher:

#Moiz Ahmad
LinkedIn: https://linkedin.com/in/moizahmad418
x: https://x.com/moizahmad418
Website: moizahmad.vercel.app
