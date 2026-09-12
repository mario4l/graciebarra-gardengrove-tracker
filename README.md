# GBGG Competition Tracker

Watches JJWL event pages for **Gracie Barra Garden Grove** sign-ups, sends a
push notification when someone new registers, and shows a live roster
dashboard.

## How it works

- `track.js` opens each event page in a headless browser, searches for your
  team, and reads the roster table.
- A GitHub Actions workflow (`.github/workflows/track.yml`) runs that script
  once an hour, commits the results to `data/state.json`, and sends a push
  notification if there are new names.
- `dashboard/` is a small React site that reads `data/state.json` straight
  from GitHub and displays it. It's deployed automatically to GitHub Pages.

Nothing needs to run on your own computer once this is set up.

## One-time setup (about 15 minutes)

### 1. Create the repo

Create a new **public** GitHub repository (private repos work too, but then
the dashboard needs a small tweak — see note at the bottom) and push these
files to it.

```bash
cd gbgg-tracker
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git push -u origin main
```

### 2. Set up push notifications (ntfy.sh)

Notifications go through [ntfy.sh](https://ntfy.sh), a free push notification
service with no account or sign-up required.

1. Install the **ntfy** app: [iOS](https://apps.apple.com/us/app/ntfy/id1625396347) /
   [Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) —
   or just use https://ntfy.sh in a browser.
2. Pick a topic name only you would guess — something like
   `gbgg-roster-x7q2p` (anyone who knows the exact topic name can see your
   notifications, so make it unguessable, not just "gbgg-tracker").
3. In the app, tap **+ Subscribe to topic** and enter that name.
4. In your GitHub repo, go to **Settings → Secrets and variables → Actions**
   and add one repository secret:

   | Secret | Value |
   |---|---|
   | `NTFY_TOPIC` | the topic name you picked, e.g. `gbgg-roster-x7q2p` |

That's it — no password, no API key. To test it works, send yourself a
message from a terminal:

```bash
curl -d "test message" https://ntfy.sh/gbgg-roster-x7q2p
```

You should see it pop up on your phone within a few seconds.

### 3. Turn on GitHub Pages

In the repo, go to **Settings → Pages** and set **Source** to
**GitHub Actions**.

### 4. Point the dashboard at your repo

Edit `.github/workflows/deploy-dashboard.yml` and replace both instances of
`YOUR_USERNAME/YOUR_REPO` (in `VITE_STATE_URL`) and `YOUR_REPO` (in
`VITE_BASE_PATH`) with your actual GitHub username and repo name. Commit and
push — this triggers the first dashboard deploy.

### 5. Run the tracker once by hand

Go to the **Actions** tab → **Track GBGG sign-ups** → **Run workflow**, so you
don't have to wait an hour for the first check. Watch the run's logs.

## If the scraper can't find the search box or table

JJWL's site renders the roster with JavaScript, so the exact HTML structure
can only be confirmed by loading the real page. `track.js` uses reasonable
guesses (`input[placeholder*="search" i]`, a `<table>` containing an
"Academy" column) and will fail loudly with a clear error if those don't
match.

To fix it:

1. Run `DEBUG=1 npm run track` locally (after `npm install` and
   `npx playwright install chromium`).
2. Open `debug/<event-id>.png` and `debug/<event-id>.html` to see exactly
   what the scraper saw.
3. Update the selectors at the top of `track.js`
   (`SEARCH_INPUT_SELECTORS`) or the table-detection logic inside
   `scrapeEvent`, then re-run.

Feel free to paste the debug HTML back to Claude for help updating the
selectors.

## Tracking future competitions

Open `config.json` and add another entry to `events`, e.g.:

```json
{
  "id": "san-diego-xix-gi-adults",
  "name": "San Diego XIX - Gi Adults",
  "url": "https://www.jjworldleague.com/events/san-diego-xix-gi-adults"
}
```

Commit and push. The next scheduled run (or a manual "Run workflow") will
start tracking it — no other changes needed. The dashboard will pick up the
new event automatically since it reads directly from `data/state.json`.

## Changing how often it checks

Edit the `cron` line in `.github/workflows/track.yml`. It's currently
`"0 * * * *"` (once an hour). GitHub Actions cron is UTC and scheduled jobs
can run a few minutes late during busy periods — that's normal.

## Note on private repos

If you make the repo private, `raw.githubusercontent.com` URLs require
authentication, so the dashboard's plain `fetch()` won't work as-is. Easiest
fix: keep the repo public (there's no sensitive data in it — just public
tournament roster info), or ask Claude to add a small serverless function
that proxies the private file with a token.
