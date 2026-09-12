/**
 * GBGG Competition Tracker
 * -------------------------------------------------
 * For every event in config.json:
 *   1. Opens the event page in a real (headless) browser
 *   2. Types the team name into the competitor search box
 *   3. Reads the filtered roster table
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

// A stable key for a competitor row so we can tell "new" from "already seen".
// Falls back gracefully if some columns are blank.
function rowKey(row) {
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

// --- core scrape -------------------------------------------------------

const SEARCH_INPUT_SELECTORS = [
  'input[placeholder*="search" i]',
  'input[type="search"]',
  '.search input',
  '.search-box input',
];

async function findFirst(page, selectors) {
  for (const sel of selectors) {
    const el = await page.$(sel);
    if (el) return el;
  }
  return null;
}

async function scrapeEvent(page, event, teamName) {
  await page.goto(event.url, { waitUntil: "networkidle", timeout: 60000 });

  // The roster table on JJWL pages loads asynchronously - give it a moment.
  await page.waitForTimeout(2000);

  const searchInput = await findFirst(page, SEARCH_INPUT_SELECTORS);
  if (!searchInput) {
    if (DEBUG) await saveDebugArtifacts(page, event.id);
    throw new Error(
      `Could not find the competitor search box on "${event.name}". ` +
        `Run with DEBUG=1 and check debug/${event.id}.png + .html to find the right selector, ` +
        `then update SEARCH_INPUT_SELECTORS in track.js.`
    );
  }

  await searchInput.click();
  await searchInput.fill("");
  await searchInput.type(teamName, { delay: 30 });

  // let the table re-filter client-side
  await page.waitForTimeout(2000);

  const rows = await page.evaluate((team) => {
    const tables = Array.from(document.querySelectorAll("table"));
    // Pick the table whose header row mentions "Academy" - that's the roster table.
    const table = tables.find((t) => t.innerText.includes("Academy"));
    if (!table) return { headerFound: false, rows: [] };

    const headerCells = Array.from(
      table.querySelectorAll("thead th, tr:first-child th, tr:first-child td")
    ).map((c) => c.innerText.trim().toLowerCase());

    const idx = (label) => headerCells.findIndex((h) => h.includes(label));
    const iName = idx("name");
    const iSurname = idx("surname");
    const iGender = idx("gender");
    const iDivision = idx("age") >= 0 ? idx("age") : idx("division");
    const iBelt = idx("belt");
    const iWeight = idx("weight");
    const iAcademy = idx("academy");
    const iOrg = idx("organization");
    const iMat = idx("mat");
    const iTime = idx("time");

    const bodyRows = Array.from(table.querySelectorAll("tbody tr"));
    const out = [];
    for (const tr of bodyRows) {
      const cells = Array.from(tr.querySelectorAll("td")).map((td) =>
        td.innerText.trim()
      );
      if (cells.length === 0) continue;
      const academy = iAcademy >= 0 ? cells[iAcademy] : "";
      if (!academy.toLowerCase().includes(team.toLowerCase())) continue;
      out.push({
        name: iName >= 0 ? cells[iName] : "",
        surname: iSurname >= 0 ? cells[iSurname] : "",
        gender: iGender >= 0 ? cells[iGender] : "",
        division: iDivision >= 0 ? cells[iDivision] : "",
        belt: iBelt >= 0 ? cells[iBelt] : "",
        weight: iWeight >= 0 ? cells[iWeight] : "",
        academy,
        organization: iOrg >= 0 ? cells[iOrg] : "",
        mat: iMat >= 0 ? cells[iMat] : "",
        time: iTime >= 0 ? cells[iTime] : "",
      });
    }
    return { headerFound: true, rows: out };
  }, teamName);

  if (!rows.headerFound) {
    if (DEBUG) await saveDebugArtifacts(page, event.id);
    throw new Error(
      `Could not find the roster table (no "Academy" column) on "${event.name}". ` +
        `Run with DEBUG=1 to inspect debug/${event.id}.png + .html.`
    );
  }

  return rows.rows;
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
