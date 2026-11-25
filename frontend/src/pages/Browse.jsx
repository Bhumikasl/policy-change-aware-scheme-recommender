import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import "./Browse.css";

const STATUS_CLASS = {
  Active: "status-active",
  Closed: "status-closed",
  Announced: "status-announced",
  Upcoming: "status-upcoming",
};

export function VersionDots({ version }) {
  const count = Math.max(1, version || 1);
  const shown = Math.min(count, 6);
  const overflow = count - shown;
  return (
    <span className="version-dots" title={`${count} recorded version${count === 1 ? "" : "s"}`}>
      {Array.from({ length: shown }).map((_, i) => (
        <span key={i} className="dot" />
      ))}
      {overflow > 0 && <span className="dot-overflow">+{overflow}</span>}
    </span>
  );
}

export function SchemeCard({ scheme }) {
  const visibleCategories = scheme.category?.slice(0, 3) || [];
  const extraCategories = (scheme.category?.length || 0) - visibleCategories.length;
  const exp = scheme.matchExplanation;

  // Trust level for the corner badge — driven by which stage(s) confirmed the
  // recommendation. rules+llm = both agreed → highest trust; rules-only means
  // the verifier was unavailable / not asked; needs-more-info means the LLM
  // wants more profile data before promising eligibility.
  let trustBadge = null;
  if (exp) {
    if (exp.needsMoreInfo) {
      trustBadge = { label: "Needs more info", tone: "warn", title: "You may qualify — a few profile fields are missing" };
    } else if (exp.stage === "rules+llm") {
      trustBadge = { label: "AI-verified", tone: "verified", title: "Both the rules engine and the LLM verifier confirmed this match" };
    } else if (exp.stage === "rules-only") {
      trustBadge = { label: "Rules match", tone: "rules", title: "Matched by rules; LLM verifier didn't run for this scheme" };
    }
  }

  return (
    <article className="scheme-card">
      <div className="scheme-card-top">
        <span className={`status-badge ${STATUS_CLASS[scheme.status] || ""}`}>
          {scheme.status}
        </span>
        <VersionDots version={scheme.version} />
      </div>
      {trustBadge && (
        <span className={`trust-badge trust-${trustBadge.tone}`} title={trustBadge.title}>
          {trustBadge.label}
        </span>
      )}

      <h3 className="scheme-card-title">
        <Link to={`/schemes/${scheme.schemeId}`}>{scheme.name}</Link>
      </h3>

      <div className="scheme-card-meta">
        {scheme.ministry && <span>{scheme.ministry}</span>}
        {scheme.state && <span className="dot-sep">·</span>}
        {scheme.state && <span>{scheme.state}</span>}
      </div>

      {scheme.description && (
        <p className="scheme-card-desc">
          {scheme.description.length > 160
            ? `${scheme.description.slice(0, 160)}...`
            : scheme.description}
        </p>
      )}

      {visibleCategories.length > 0 && (
        <div className="tag-row">
          {visibleCategories.map((c) => (
            <span key={c} className="tag-chip">{c}</span>
          ))}
          {extraCategories > 0 && <span className="tag-chip tag-chip-muted">+{extraCategories}</span>}
        </div>
      )}

      <div className="scheme-card-footer">
        {scheme.lastDate && <span>Apply by {scheme.lastDate}</span>}
        <Link to={`/schemes/${scheme.schemeId}`} className="scheme-card-link">
          View details →
        </Link>
      </div>

      {scheme.matchExplanation && scheme.matchExplanation.matched?.length > 0 && (
        <div
          className="doc-readiness"
          title={`Match mode: ${scheme.matchExplanation.mode} · score ${scheme.matchExplanation.score}`}
        >
          Why matched: {scheme.matchExplanation.matched
            .slice(0, 3)
            .map((m) => m.reason)
            .join(" · ")}
          {typeof exp?.relevance === "number" && (
            <span className="relevance-pill" title="Relevance score — how useful this scheme is for your profile and stated intent">
              relevance {exp.relevance}
            </span>
          )}
        </div>
      )}

      {exp?.needsMoreInfo && exp?.verifier?.missingInformation?.length > 0 && (
        <div className="doc-readiness doc-readiness-warn">
          To confirm eligibility we need: {exp.verifier.missingInformation.slice(0, 3).join(" · ")}
          {exp.verifier.missingInformation.length > 3 && (
            <span> · +{exp.verifier.missingInformation.length - 3} more</span>
          )}
        </div>
      )}

      {scheme.documentReadiness && scheme.documentReadiness.required > 0 && (
        <div
          className={`doc-readiness ${
            scheme.documentReadiness.have === scheme.documentReadiness.required
              ? "doc-readiness-full"
              : ""
          }`}
        >
          Documents: {scheme.documentReadiness.have}/{scheme.documentReadiness.required} ready
          {scheme.documentReadiness.missing.length > 0 && (
            <span className="doc-readiness-missing">
              {" "}
              — missing {scheme.documentReadiness.missing.join(", ")}
            </span>
          )}
        </div>
      )}
    </article>
  );
}

export default function Browse() {
  const [schemes, setSchemes] = useState([]);
  const [status, setStatus] = useState("loading"); // loading | ready | error
  const [errorMsg, setErrorMsg] = useState("");

  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const [state, setState] = useState("");
  const [category, setCategory] = useState("");
  const [includeClosed, setIncludeClosed] = useState(false);

  const [categoryOptions, setCategoryOptions] = useState([]);
  const [stateOptions, setStateOptions] = useState([]);

  // Debounce the free-text search so we're not firing a request per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setSearch(searchInput.trim()), 350);
    return () => clearTimeout(t);
  }, [searchInput]);

  // Filter dropdown options come from a dedicated distinct-values endpoint,
  // so they reflect every state/category in the collection — not just
  // whatever happens to be in the most recently updated schemes.
  useEffect(() => {
    api
      .get("/schemes/meta/filters")
      .then((res) => {
        setStateOptions(res.data.states || []);
        setCategoryOptions(res.data.categories || []);
      })
      .catch(() => {
        // Non-critical — filters just show no options if this fails.
      });
  }, []);

  useEffect(() => {
    setStatus("loading");
    const params = {};
    if (search) params.search = search;
    if (state) params.state = state;
    if (category) params.category = category;
    if (includeClosed) params.includeClosed = "true";

    api
      .get("/schemes", { params })
      .then((res) => {
        setSchemes(res.data);
        setStatus("ready");
      })
      .catch((err) => {
        setStatus("error");
        setErrorMsg(err.response?.data?.error || "Couldn't load schemes. Please try again.");
      });
  }, [search, state, category, includeClosed]);

  const hasActiveFilters = search || state || category || includeClosed;

  function clearFilters() {
    setSearchInput("");
    setSearch("");
    setState("");
    setCategory("");
    setIncludeClosed(false);
  }

  const resultCountLabel = useMemo(() => {
    if (status !== "ready") return "";
    return `${schemes.length} scheme${schemes.length === 1 ? "" : "s"}`;
  }, [schemes, status]);

  return (
    <div className="container browse-page">
      <header className="browse-header">
        <h2>Browse schemes</h2>
        <p className="browse-subtitle">
          Search and filter government schemes we're tracking. Each card shows how many
          times we've seen it change.
        </p>
      </header>

      <div className="filter-bar">
        <input
          type="text"
          className="search-input"
          placeholder="Search by scheme name..."
          value={searchInput}
          onChange={(e) => setSearchInput(e.target.value)}
        />

        <select value={state} onChange={(e) => setState(e.target.value)}>
          <option value="">All states</option>
          {stateOptions.map((s) => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>

        <select value={category} onChange={(e) => setCategory(e.target.value)}>
          <option value="">All categories</option>
          {categoryOptions.map((c) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>

        <label className="include-closed-toggle">
          <input
            type="checkbox"
            checked={includeClosed}
            onChange={(e) => setIncludeClosed(e.target.checked)}
          />
          Include closed
        </label>

        {hasActiveFilters && (
          <button type="button" className="clear-filters-btn" onClick={clearFilters}>
            Clear filters
          </button>
        )}
      </div>

      {status === "ready" && <p className="result-count">{resultCountLabel}</p>}

      {status === "loading" && <p className="browse-status-msg">Loading schemes...</p>}

      {status === "error" && <p className="browse-status-msg browse-error">{errorMsg}</p>}

      {status === "ready" && schemes.length === 0 && (
        <div className="empty-state">
          <p>No schemes match these filters.</p>
          {hasActiveFilters && (
            <button type="button" className="clear-filters-btn" onClick={clearFilters}>
              Clear filters
            </button>
          )}
        </div>
      )}

      {status === "ready" && schemes.length > 0 && (
        <div className="scheme-grid">
          {schemes.map((s) => (
            <SchemeCard key={s.schemeId} scheme={s} />
          ))}
        </div>
      )}
    </div>
  );
}