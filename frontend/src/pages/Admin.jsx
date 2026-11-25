import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import "./Browse.css";
import "./Admin.css";

const EVENT_LABEL = {
  CREATED: "First seen",
  UPDATED: "Updated",
};

function formatDateTime(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString("en-IN", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function UpdateRow({ entry }) {
  const schemeId = entry.schemeId;
  const name = entry.snapshot?.name || schemeId;

  return (
    <li className="update-row">
      <div className="update-row-top">
        <span className={`event-badge event-${entry.eventType.toLowerCase()}`}>
          {EVENT_LABEL[entry.eventType] || entry.eventType}
        </span>
        <span className="update-row-date">{formatDateTime(entry.createdAt)}</span>
      </div>
      <Link to={`/schemes/${schemeId}`} className="update-row-title">
        {name}
      </Link>
      {entry.aiSummary && <p className="update-row-summary">{entry.aiSummary}</p>}
      {entry.diffs?.length > 0 && (
        <p className="update-row-fields">
          Changed: {entry.diffs.map((d) => d.field).join(", ")}
        </p>
      )}
    </li>
  );
}

export default function Admin() {
  const [updates, setUpdates] = useState([]);
  const [limit, setLimit] = useState(20);
  const [feedStatus, setFeedStatus] = useState("loading"); // loading | ready | error
  const [feedError, setFeedError] = useState("");

  const [runStatus, setRunStatus] = useState("idle"); // idle | running | done | error
  const [runResult, setRunResult] = useState(null);
  const [runError, setRunError] = useState("");

  const loadFeed = useCallback((lim) => {
    setFeedStatus("loading");
    api
      .get("/updates/recent", { params: { limit: lim } })
      .then((res) => {
        setUpdates(res.data);
        setFeedStatus("ready");
      })
      .catch((err) => {
        setFeedStatus("error");
        setFeedError(err.response?.data?.error || "Couldn't load the recent changes feed.");
      });
  }, []);

  useEffect(() => {
    loadFeed(limit);
  }, [limit, loadFeed]);

  async function handleRunCollection() {
    setRunStatus("running");
    setRunResult(null);
    setRunError("");

    try {
      const res = await api.post("/collect/run", null, { timeout: 0 });
      if (res.data.ok) {
        setRunStatus("done");
        setRunResult(res.data.summary);
        loadFeed(limit);
      } else {
        setRunStatus("error");
        setRunError(res.data.error || "Collection run failed.");
      }
    } catch (err) {
      setRunStatus("error");
      setRunError(err.response?.data?.error || err.message || "Collection run failed.");
    }
  }

  return (
    <div className="container admin-page">
      <header className="admin-header">
        <h2>Admin</h2>
        <p className="browse-subtitle">
          Trigger a manual collection run and review recent scheme changes.
        </p>
      </header>

      <section className="admin-section">
        <h3>Run collection now</h3>
        <p className="admin-warning">
          This fetches from every source and reconciles the full catalogue against MongoDB —
          on a full run this has taken close to an hour against real data. The page will show a
          spinner the whole time; don't close this tab or resubmit while it's running.
        </p>

        <button
          type="button"
          className="btn-primary"
          onClick={handleRunCollection}
          disabled={runStatus === "running"}
        >
          {runStatus === "running" ? "Running collection..." : "Run collection now"}
        </button>

        {runStatus === "running" && (
          <p className="admin-run-status">
            Collection in progress — this can take a while, feel free to leave this tab open in
            the background.
          </p>
        )}

        {runStatus === "done" && runResult && (
          <div className="run-summary">
            <span className="run-stat run-stat-new">{runResult.new} new</span>
            <span className="run-stat run-stat-updated">{runResult.updated} updated</span>
            <span className="run-stat run-stat-unchanged">{runResult.unchanged} unchanged</span>
            {runResult.failed > 0 && (
              <span className="run-stat run-stat-failed">{runResult.failed} failed</span>
            )}
          </div>
        )}

        {runStatus === "error" && <p className="browse-error">{runError}</p>}
      </section>

      <section className="admin-section">
        <div className="admin-feed-header">
          <h3>Recent changes</h3>
          <select value={limit} onChange={(e) => setLimit(Number(e.target.value))}>
            <option value={20}>Last 20</option>
            <option value={50}>Last 50</option>
            <option value={100}>Last 100</option>
          </select>
        </div>

        {feedStatus === "loading" && <p className="browse-status-msg">Loading feed...</p>}
        {feedStatus === "error" && <p className="browse-status-msg browse-error">{feedError}</p>}

        {feedStatus === "ready" && updates.length === 0 && (
          <p className="browse-status-msg">No recorded changes yet.</p>
        )}

        {feedStatus === "ready" && updates.length > 0 && (
          <ul className="update-list">
            {updates.map((u) => (
              <UpdateRow key={`${u.schemeId}-${u.version}`} entry={u} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}