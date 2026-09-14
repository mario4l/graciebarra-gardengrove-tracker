/**
 * GBGG Competition Tracker
 * -------------------------------------------------
 * For every event in config.json:
 *   1. Opens the event page in a real (headless) browser
 *   2. Clicks the "Competitors" tab and lets its data table load
 *   3. Filters that table by your team name (same as typing in the search box)
 *   4. Compares it to the last-known roster (data/state.json)
 *   5. Sends a push notification (via ntfy.sh) if anyone new has registered
 *   6. Saves the new roster back to data/state.json
 *
 * Run locally:   npm install && npx playwright install chromium && npm run track
 * Run in CI:     see .github/workflows/track.yml
 *
 * If scraping fails, run with DEBUG=1 to save a screenshot + HTML dump
 * of the page to ./debug/ so you (or Claude) can find the right selectors.
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

const CONFIG_PATH = path.join(__dirname, "config.json");
const STATE_PATH = path.join(__dirname, "data", "state.json");
const DEBUG_DIR = path.join(__dirname, "debug");
const DEBUG = process.env.DEBUG === "1";

// --- helpers ---------------------------------------------------------

function loadJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (err) {
    return fallback;
  }
}

function saveJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// A stable key for a competitor row. fighter_id (from the site's own data)
// is far more reliable than string-matching name/division/belt/weight.
function rowKey(row) {
  if (row.id != null && row.id !== "") return `id:${row.id}`;
  return [row.name, row.surname, row.division, row.belt, row.weight]
    .map((v) => (v || "").toLowerCase().trim())
    .join("|");
}

async function saveDebugArtifacts(page, eventId) {
  fs.mkdirSync(DEBUG_DIR, { recursive: true });
  await page.screenshot({
    path: path.join(DEBUG_DIR, `${eventId}.png`),
    fullPage: true,
  });
  fs.writeFileSync(
    path.join(DEBUG_DIR, `${eventId}.html`),
    await page.content()
  );
}

async function findFirst(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return el;
  }
  return null;
}

// --- core scrape -------------------------------------------------------
//
// The competitors table on JJWL event pages is a jQuery DataTable
// (#users_offers_list) that only gets initialized once you click the
// "Competitors" tab (#menu_competitors). It loads the full competitor list
// into the browser in one shot, then filters/paginates client-side - so
// once it's loaded, we can read matching rows directly from the DataTables
// API (window.table) instead of scraping visible <td> cells. This also
// gives us each competitor's real ID for reliable "is this new?" checks.

async function scrapeEvent(page, event, teamName) {
  await page.goto(event.url, { waitUntil: "networkidle", timeout: 60000 });

  const tabSelectors = ["#menu_competitors", 'a[href="#Competitors"]', '[href="#Competitors"]'];
  const tab = await findFirst(page, tabSelectors);
  if (!tab) {
    if (DEBUG) await saveDebugArtifacts(page, event.id);
    throw new Error(
      `Could not find the "Competitors" tab on "${event.name}". ` +
        `Run with DEBUG=1 and check debug/${event.id}.png + .html.`
    );
  }
  await tab.click();

  // Wait for the DataTable to exist and finish its initial ajax load.
  try {
    await page.waitForFunction(
      () => window.table && typeof window.table.rows === "function" && window.table.rows().count() > 0,
      { timeout: 30000 }
    );
  } catch {
    if (DEBUG) await saveDebugArtifacts(page, event.id);
    throw new Error(
      `Competitors table on "${event.name}" never loaded any rows. ` +
        `The event may have no competitors yet, or the page structure changed - ` +
        `run with DEBUG=1 and check debug/${event.id}.png + .html.`
    );
  }

  // Apply the global search, same as typing into the on-page search box.
  await page.evaluate((team) => {
    window.table.search(team).draw();
  }, teamName);

  // DataTables debounces search by 'searchDelay' (1000ms on this site).
  await page.waitForTimeout(1500);

  const rows = await page.evaluate(() => {
    return window.table
      .rows({ search: "applied" })
      .data()
      .toArray()
      .map((r) => ({
        id: r.fighter_id ?? null,
        name: r.fighter_name || "",
        surname: r.fighter_surname || "",
        gender: r.cat_gender || "",
        division: r.cat_age || "",
        belt: r.cat_belt || "",
        weight: r.cat_weight || "",
        academy: r.academy_name || "",
        organization: r.organization_name || "",
        mat: r.fight_mat || "",
        time: r.fight_time || "",
      }));
  });

  // Defensive filter: keep only rows whose academy actually matches, in case
  // the global search happened to match some other column instead.
  return rows.filter((r) =>
    (r.academy || "").toLowerCase().includes(teamName.toLowerCase())
  );
}

// --- push notification (ntfy.sh) ------------------------------------------
//
// ntfy.sh is a free, no-signup push notification service: you pick a private
// "topic" name, subscribe to it in the ntfy app on your phone, and anyone who
// knows the topic name can push a notification to it by POSTing to
// https://ntfy.sh/<topic>. Treat the topic name like a password - anyone who
// guesses it can send you notifications (or read them, if they subscribe).

async function sendPushNotification(summary) {
  const NTFY_TOPIC = process.env.NTFY_TOPIC;
  const NTFY_SERVER = process.env.NTFY_SERVER || "https://ntfy.sh";

  if (!NTFY_TOPIC) {
    console.warn(
      "NTFY_TOPIC env var not set - skipping push notification, printing summary instead:\n"
    );
    console.log(summary.text);
    return;
  }

  const res = await fetch(`${NTFY_SERVER}/${NTFY_TOPIC}`, {
    method: "POST",
    headers: {
      Title: summary.title,
      Tags: "boxing_glove",
      Priority: "default",
    },
    body: summary.text,
  });

  if (!res.ok) {
    throw new Error(
      `ntfy notification failed: ${res.status} ${res.statusText}`
    );
  }

  console.log(`Push notification sent to ntfy topic "${NTFY_TOPIC}"`);
}

function formatCompetitor(row) {
  return `${row.name} ${row.surname} — ${row.division || "?"} / ${
    row.belt || "?"
  } / ${row.weight || "?"}`;
}

// --- main ---------------------------------------------------------------

async function main() {
  const config = loadJson(CONFIG_PATH, { teamName: "", events: [] });
  const state = loadJson(STATE_PATH, { events: {} });

  const browser = await chromium.launch();
  const page = await browser.newPage();

  const newlyFound = []; // [{ eventName, competitors: [...] }]
  const errors = [];

  for (const event of config.events) {
    console.log(`Checking ${event.name} ...`);
    try {
      const currentRows = await scrapeEvent(page, event, config.teamName);
      const previousRows = (state.events[event.id] && state.events[event.id].rows) || [];
      const previousKeys = new Set(previousRows.map(rowKey));

      const additions = currentRows.filter((r) => !previousKeys.has(rowKey(r)));

      if (additions.length > 0) {
        newlyFound.push({ eventName: event.name, eventUrl: event.url, competitors: additions });
      }

      state.events[event.id] = {
        eventName: event.name,
        eventUrl: event.url,
        lastChecked: new Date().toISOString(),
        rows: currentRows,
      };

      console.log(
        `  -> ${currentRows.length} total, ${additions.length} new since last check`
      );
    } catch (err) {
      console.error(`  !! ${err.message}`);
      errors.push({ eventName: event.name, message: err.message });
    }
  }

  await browser.close();

  saveJson(STATE_PATH, state);

  if (newlyFound.length > 0) {
    const textParts = [];
    for (const group of newlyFound) {
      textParts.push(`${group.eventName}:`);
      for (const c of group.competitors) {
        textParts.push(`  - ${formatCompetitor(c)}`);
      }
    }
    const total = newlyFound.reduce((n, g) => n + g.competitors.length, 0);

    await sendPushNotification({
      title: `GBGG: ${total} new sign-up${total === 1 ? "" : "s"}`,
      text: textParts.join("\n"),
    });
  } else {
    console.log("No new sign-ups this run.");
  }

  if (errors.length > 0) {
    console.error(`\nCompleted with ${errors.length} error(s).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
