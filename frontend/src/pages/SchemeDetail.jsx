import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import api from "../api/client";
import "./SchemeDetail.css";

const STATUS_CLASS = {
  Active: "status-active",
  Closed: "status-closed",
  Announced: "status-announced",
  Upcoming: "status-upcoming",
};

function formatDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleDateString("en-IN", { year: "numeric", month: "short", day: "numeric" });
}

function formatValue(value) {
  if (value === null || value === undefined || value === "") return "(empty)";
  if (Array.isArray(value)) return value.length ? value.join(", ") : "(empty)";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function VersionTimeline({ history, selectedVersion, onSelect }) {
  return (
    <div className="timeline-track" role="list">
      {history.map((entry) => {
        const isSelected = entry.version === selectedVersion;
        return (
          <button
            key={entry.version}
            type="button"
            role="listitem"
            className={`timeline-dot-btn ${isSelected ? "selected" : ""}`}
            onClick={() => onSelect(entry.version)}
            aria-current={isSelected}
            title={`Version ${entry.version} — ${entry.eventType}`}
          >
            <span className="dot" />
            <span className="timeline-dot-label">v{entry.version}</span>
          </button>
        );
      })}
    </div>
  );
}

function HistoryEntryDetail({ entry }) {
  if (!entry) return null;
  return (
    <div className="history-entry">
      <div className="history-entry-header">
        <span className={`event-badge event-${entry.eventType.toLowerCase()}`}>
          {entry.eventType === "CREATED" ? "First seen" : "Updated"}
        </span>
        <span className="history-entry-date">{formatDate(entry.createdAt)}</span>
      </div>

      {entry.aiSummary && <p className="history-entry-summary">{entry.aiSummary}</p>}

      {entry.diffs?.length > 0 && (
        <table className="diff-table">
          <thead>
            <tr>
              <th>Field</th>
              <th>Before</th>
              <th>After</th>
            </tr>
          </thead>
          <tbody>
            {entry.diffs.map((d, i) => (
              <tr key={i}>
                <td className="diff-field">{d.field}</td>
                <td className="diff-old">{formatValue(d.oldValue)}</td>
                <td className="diff-new">{formatValue(d.newValue)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {entry.eventType === "CREATED" && (!entry.diffs || entry.diffs.length === 0) && (
        <p className="history-entry-note">Scheme first added to tracking at this version.</p>
      )}
    </div>
  );
}

export default function SchemeDetail() {
  const { schemeId } = useParams();
  const [scheme, setScheme] = useState(null);
  const [history, setHistory] = useState([]);
  const [selectedVersion, setSelectedVersion] = useState(null);
  const [status, setStatus] = useState("loading"); // loading | ready | notfound | error
  const [errorMsg, setErrorMsg] = useState("");

  useEffect(() => {
    let cancelled = false;
    setStatus("loading");

    Promise.all([
      api.get(`/schemes/${schemeId}`),
      api.get(`/schemes/${schemeId}/history`),
    ])
      .then(([schemeRes, historyRes]) => {
        if (cancelled) return;
        setScheme(schemeRes.data);
        setHistory(historyRes.data);
        setSelectedVersion(
          historyRes.data.length
            ? historyRes.data[historyRes.data.length - 1].version
            : null
        );
        setStatus("ready");
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.response?.status === 404) {
          setStatus("notfound");
        } else {
          setStatus("error");
          setErrorMsg(err.response?.data?.error || "Couldn't load this scheme. Please try again.");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [schemeId]);

  if (status === "loading") {
    return (
      <div className="container detail-page">
        <p className="detail-status-msg">Loading scheme...</p>
      </div>
    );
  }

  if (status === "notfound") {
    return (
      <div className="container detail-page">
        <p className="detail-status-msg">We couldn't find a scheme with this ID.</p>
        <Link to="/" className="back-link">← Back to Browse</Link>
      </div>
    );
  }

  if (status === "error") {
    return (
      <div className="container detail-page">
        <p className="detail-status-msg detail-error">{errorMsg}</p>
        <Link to="/" className="back-link">← Back to Browse</Link>
      </div>
    );
  }

  const selectedEntry = history.find((h) => h.version === selectedVersion);

  return (
    <div className="container detail-page">
      <Link to="/" className="back-link">← Back to Browse</Link>

      <header className="detail-header">
        <div className="detail-header-top">
          <span className={`status-badge ${STATUS_CLASS[scheme.status] || ""}`}>
            {scheme.status}
          </span>
          <span className="detail-source">Source: {scheme.source}</span>
        </div>
        <h2>{scheme.name}</h2>
        <div className="detail-meta">
          {scheme.ministry && <span>{scheme.ministry}</span>}
          {scheme.state && <span className="dot-sep">·</span>}
          {scheme.state && <span>{scheme.state}</span>}
        </div>
      </header>

      {(scheme.category?.length > 0 || scheme.tags?.length > 0) && (
        <div className="tag-row">
          {scheme.category?.map((c) => (
            <span key={`cat-${c}`} className="tag-chip">{c}</span>
          ))}
          {scheme.tags?.map((t) => (
            <span key={`tag-${t}`} className="tag-chip tag-chip-accent">{t}</span>
          ))}
        </div>
      )}

      <div className="detail-grid">
        <section className="detail-section">
          {scheme.description && (
            <>
              <h3>Description</h3>
              <p>{scheme.description}</p>
            </>
          )}
          {scheme.eligibility && (
            <>
              <h3>Eligibility</h3>
              <p>{scheme.eligibility}</p>
            </>
          )}
          {scheme.benefits && (
            <>
              <h3>Benefits</h3>
              <p>{scheme.benefits}</p>
            </>
          )}
          {scheme.documents?.length > 0 && (
            <>
              <h3>Documents required</h3>
              <ul className="doc-list">
                {scheme.documents.map((d) => (
                  <li key={d}>{d}</li>
                ))}
              </ul>
            </>
          )}
        </section>

        <aside className="detail-sidebar">
          {scheme.lastDate && (
            <div className="sidebar-row">
              <span className="sidebar-label">Apply by</span>
              <span>{scheme.lastDate}</span>
            </div>
          )}
          <div className="sidebar-row">
            <span className="sidebar-label">Last updated</span>
            <span>{formatDate(scheme.lastUpdatedAt)}</span>
          </div>
          <div className="sidebar-row">
            <span className="sidebar-label">First tracked</span>
            <span>{formatDate(scheme.firstSeenAt)}</span>
          </div>
          {scheme.applicationLink && (
            <a
              className="btn-primary detail-apply-btn"
              href={scheme.applicationLink}
              target="_blank"
              rel="noreferrer"
            >
              Apply now
            </a>
          )}
          {scheme.sourceUrl && (
            <a
              className="detail-source-link"
              href={scheme.sourceUrl}
              target="_blank"
              rel="noreferrer"
            >
              View on official portal ↗
            </a>
          )}
        </aside>
      </div>

      <section className="detail-section version-section">
        <h3>Version history</h3>
        {history.length === 0 ? (
          <p className="detail-status-msg">No recorded history for this scheme yet.</p>
        ) : (
          <>
            <VersionTimeline
              history={history}
              selectedVersion={selectedVersion}
              onSelect={setSelectedVersion}
            />
            <HistoryEntryDetail entry={selectedEntry} />
          </>
        )}
      </section>
    </div>
  );
}