import { useEffect, useState } from "react";

// Set VITE_STATE_URL at build time to the raw GitHub URL of data/state.json, e.g.
// https://raw.githubusercontent.com/<user>/<repo>/main/data/state.json
const STATE_URL =
  import.meta.env.VITE_STATE_URL ||
  "https://raw.githubusercontent.com/YOUR_USERNAME/YOUR_REPO/main/data/state.json";

const SEEN_KEY = "gbgg-seen-competitors";

function rowKey(row) {
  return [row.name, row.surname, row.division, row.belt, row.weight]
    .map((v) => (v || "").toLowerCase().trim())
    .join("|");
}

function loadSeen() {
  try {
    return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || "[]"));
  } catch {
    return new Set();
  }
}

function saveSeen(set) {
  localStorage.setItem(SEEN_KEY, JSON.stringify(Array.from(set)));
}

function formatDate(iso) {
  if (!iso) return "never";
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function App() {
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [events, setEvents] = useState([]);
  const [seen, setSeen] = useState(() => loadSeen());

  useEffect(() => {
    let cancelled = false;

    fetch(STATE_URL, { cache: "no-store" })
      .then((res) => {
        if (!res.ok) throw new Error(`Request failed (${res.status})`);
        return res.json();
      })
      .then((data) => {
        if (cancelled) return;
        const list = Object.entries(data.events || {}).map(([id, e]) => ({
          id,
          ...e,
        }));
        list.sort((a, b) => (a.eventName || "").localeCompare(b.eventName || ""));
        setEvents(list);
        setStatus("ready");
      })
      .catch(() => {
        if (!cancelled) setStatus("error");
      });

    return () => {
      cancelled = true;
    };
  }, []);

  function markAllSeen() {
    const next = new Set(seen);
    for (const ev of events) {
      for (const row of ev.rows || []) next.add(rowKey(row));
    }
    saveSeen(next);
    setSeen(next);
  }

  const totalCompetitors = events.reduce((n, e) => n + (e.rows || []).length, 0);
  const totalNew = events.reduce(
    (n, e) => n + (e.rows || []).filter((r) => !seen.has(rowKey(r))).length,
    0
  );

  return (
    <div className="page">
      <header className="hero">
        <p className="hero-eyebrow">Gracie Barra Garden Grove</p>
        <h1 className="hero-title">Roster Watch</h1>
        <p className="hero-sub">
          Live sign-up tracking across every JJWL event we're following.
        </p>
        {status === "ready" && (
          <div className="hero-stats">
            <div className="stat">
              <span className="stat-value">{totalCompetitors}</span>
              <span className="stat-label">competitors registered</span>
            </div>
            <div className="stat">
              <span className="stat-value stat-value--accent">{totalNew}</span>
              <span className="stat-label">new since your last visit</span>
            </div>
          </div>
        )}
      </header>

      <main className="content">
        {status === "loading" && <p className="status-msg">Loading roster data…</p>}

        {status === "error" && (
          <div className="status-msg status-msg--error">
            <p>
              Couldn't load roster data from <code>{STATE_URL}</code>.
            </p>
            <p>
              Check that the tracker workflow has run at least once, and that
              VITE_STATE_URL points at your repo's data/state.json.
            </p>
          </div>
        )}

        {status === "ready" && events.length === 0 && (
          <div className="status-msg">
            <p>No events tracked yet.</p>
            <p>Add one to config.json in the repo and the next scheduled run will pick it up.</p>
          </div>
        )}

        {status === "ready" &&
          events.map((event) => (
            <section className="event-card" key={event.id}>
              <div className="event-card-header">
                <div>
                  <h2>
                    <a href={event.eventUrl} target="_blank" rel="noreferrer">
                      {event.eventName}
                    </a>
                  </h2>
                  <p className="event-meta">
                    {(event.rows || []).length} registered · last checked{" "}
                    {formatDate(event.lastChecked)}
                  </p>
                </div>
              </div>

              {(event.rows || []).length === 0 ? (
                <p className="empty-note">No Gracie Barra Garden Grove sign-ups yet for this event.</p>
              ) : (
                <table className="roster-table">
                  <thead>
                    <tr>
                      <th>Name</th>
                      <th>Division</th>
                      <th>Belt</th>
                      <th>Weight</th>
                      <th>Mat</th>
                      <th>Time</th>
                    </tr>
                  </thead>
                  <tbody>
                    {event.rows.map((row) => {
                      const isNew = !seen.has(rowKey(row));
                      return (
                        <tr key={rowKey(row)} className={isNew ? "is-new" : ""}>
                          <td>
                            {row.name} {row.surname}
                            {isNew && <span className="badge-new">New</span>}
                          </td>
                          <td>{row.division || "—"}</td>
                          <td>{row.belt || "—"}</td>
                          <td>{row.weight || "—"}</td>
                          <td>{row.mat || "—"}</td>
                          <td>{row.time || "—"}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </section>
          ))}

        {status === "ready" && totalNew > 0 && (
          <button className="mark-seen-btn" onClick={markAllSeen}>
            Mark all as seen
          </button>
        )}
      </main>
    </div>
  );
}
