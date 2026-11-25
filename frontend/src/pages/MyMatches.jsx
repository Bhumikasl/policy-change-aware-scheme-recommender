import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";
import { useAuth } from "../auth/AuthContext";
import { SchemeCard } from "./Browse";
import NewlyEligibleSection from "../NewlyEligibleSection";
import "./Browse.css";
import "./MyMatches.css";

const PAGE_SIZE = 20;

export default function MyMatches() {
  // The email used to come from a text box and localStorage, so anyone could
  // type someone else's address and read their matches. `/users/:email/matches`
  // is now requireAuth + requireSelfOrAdmin, so the only address that works is
  // the signed-in one — it comes from the verified session, not from input.
  const { user } = useAuth();
  const activeEmail = user?.email || "";
  const [matches, setMatches] = useState([]);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | notfound | error
  const [errorMsg, setErrorMsg] = useState("");

  // Filter state — all client-side because /matches returns everything sorted.
  const [stateFilter, setStateFilter] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [ministryFilter, setMinistryFilter] = useState("");
  const [trustFilter, setTrustFilter] = useState(""); // "" | "verified" | "needs-info" | "rules-only"
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);

  // Free-text intent — sent to the ranker so results follow what the user
  // actually wants, not just what they're eligible for.
  const [intentInput, setIntentInput] = useState("");
  const [intent, setIntent] = useState("");
  // Funnel counts from ?meta=true so the UI can explain "20 of 181 eligible".
  const [funnel, setFunnel] = useState(null);

  useEffect(() => {
    if (!activeEmail) return;
    let cancelled = false;
    setStatus("loading");
    api
      .get(`/users/${encodeURIComponent(activeEmail)}/matches`, {
        params: { meta: "true", limit: 60, ...(intent ? { intent } : {}) },
      })
      .then((res) => {
        if (cancelled) return;
        // ?meta=true returns { funnel, results }; plain returns an array.
        const payload = Array.isArray(res.data) ? { results: res.data, funnel: null } : res.data;
        setMatches(payload.results || []);
        setFunnel(payload.funnel || null);
        setStatus("ready");
        setVisibleCount(PAGE_SIZE);
      })
      .catch((err) => {
        if (cancelled) return;
        if (err.response?.status === 404) setStatus("notfound");
        else { setStatus("error"); setErrorMsg(err.friendlyMessage || "Couldn't load matches. Please try again."); }
      });
    return () => { cancelled = true; };
  }, [activeEmail, intent]);

  // Build filter dropdown options from the matches themselves — no extra API call.
  const filterOptions = useMemo(() => {
    const states = new Set();
    const cats = new Set();
    const mins = new Set();
    for (const m of matches) {
      if (m.state) states.add(m.state);
      (m.category || []).forEach((c) => cats.add(c));
      if (m.ministry) mins.add(m.ministry);
    }
    return {
      states: [...states].sort(),
      categories: [...cats].sort(),
      ministries: [...mins].sort(),
    };
  }, [matches]);

  // Apply filters. The API already sorted by score, so we preserve that order.
  const filtered = useMemo(() => {
    return matches.filter((m) => {
      if (stateFilter && m.state !== stateFilter) return false;
      if (categoryFilter && !(m.category || []).includes(categoryFilter)) return false;
      if (ministryFilter && m.ministry !== ministryFilter) return false;
      if (trustFilter) {
        const stage = m.matchExplanation?.stage;
        const needsInfo = m.matchExplanation?.needsMoreInfo;
        if (trustFilter === "verified" && stage !== "rules+llm") return false;
        if (trustFilter === "needs-info" && !needsInfo) return false;
        if (trustFilter === "rules-only" && stage !== "rules-only") return false;
      }
      return true;
    });
  }, [matches, stateFilter, categoryFilter, ministryFilter, trustFilter]);

  const visible = filtered.slice(0, visibleCount);
  const hasMore = filtered.length > visibleCount;
  const hasActiveFilters = stateFilter || categoryFilter || ministryFilter || trustFilter;

  function clearAllFilters() {
    setStateFilter(""); setCategoryFilter(""); setMinistryFilter(""); setTrustFilter("");
    setVisibleCount(PAGE_SIZE);
  }

  // Counts for the trust-filter chips — computed once per matches[] change.
  const trustCounts = useMemo(() => {
    let verified = 0, needsInfo = 0, rulesOnly = 0;
    for (const m of matches) {
      const stage = m.matchExplanation?.stage;
      if (m.matchExplanation?.needsMoreInfo) needsInfo += 1;
      else if (stage === "rules+llm") verified += 1;
      else if (stage === "rules-only") rulesOnly += 1;
    }
    return { verified, needsInfo, rulesOnly };
  }, [matches]);

  return (
    <div className="container matches-page">
      <header className="matches-header">
        <h2>My matches</h2>
        <p className="browse-subtitle">
          Schemes matched against your profile, most relevant first.
        </p>
      </header>

      {status === "idle" && <p className="detail-status-msg">Loading your matches…</p>}
      {status === "loading" && <p className="browse-status-msg">Loading your matches...</p>}
      {status === "notfound" && (
        <div className="empty-state">
          <p>Your profile is not complete yet, so there is nothing to match against.</p>
          <Link to="/register" className="scheme-card-link">Complete your profile →</Link>
        </div>
      )}
      {status === "error" && <p className="browse-status-msg browse-error">{errorMsg}</p>}
      {status === "ready" && matches.length === 0 && (
        <div className="empty-state">
          <p>No active schemes match your profile right now.</p>
          <p className="detail-status-msg" style={{ padding: 0 }}>
            We'll keep checking — you don't need to do anything.
          </p>
        </div>
      )}

      {status === "ready" && matches.length > 0 && (
        <>
          {/* ADDITIVE: Newly eligible section — renders nothing when empty */}
          <NewlyEligibleSection />

          {/* Intent search — reranks by what the user says they want */}
          <form
            className="intent-form"
            onSubmit={(e) => { e.preventDefault(); setIntent(intentInput.trim()); }}
          >
            <input
              type="text"
              className="search-input"
              placeholder="What are you looking for? e.g. scholarships for B.Tech, business loan, pension"
              value={intentInput}
              onChange={(e) => setIntentInput(e.target.value)}
            />
            <button type="submit" className="btn-primary">Rank by this</button>
            {intent && (
              <button
                type="button"
                className="clear-filters-btn"
                onClick={() => { setIntentInput(""); setIntent(""); }}
              >
                Clear intent
              </button>
            )}
          </form>

          {funnel && (
            <p className="funnel-line">
              {funnel.eligible} scheme{funnel.eligible === 1 ? "" : "s"} you're eligible for ·
              {" "}ranked by relevance · showing the top {funnel.returned}
              {funnel.llmVerified > 0 && ` · ${funnel.llmVerified} AI-verified`}
              {funnel.vetoed > 0 && ` · ${funnel.vetoed} filtered out by the verifier`}
            </p>
          )}

          {/* Trust-level chips: quick filter on how the match was reached */}
          <div className="trust-chip-row">
            <button
              type="button"
              className={`trust-chip ${trustFilter === "" ? "trust-chip-active" : ""}`}
              onClick={() => setTrustFilter("")}
            >
              All ({matches.length})
            </button>
            <button
              type="button"
              className={`trust-chip trust-chip-verified ${trustFilter === "verified" ? "trust-chip-active" : ""}`}
              onClick={() => setTrustFilter(trustFilter === "verified" ? "" : "verified")}
              title="Confirmed by both rules and LLM verifier"
            >
              ✓ AI-verified ({trustCounts.verified})
            </button>
            <button
              type="button"
              className={`trust-chip trust-chip-warn ${trustFilter === "needs-info" ? "trust-chip-active" : ""}`}
              onClick={() => setTrustFilter(trustFilter === "needs-info" ? "" : "needs-info")}
              title="You may qualify but the profile is missing some fields"
            >
              ⚠ Needs more info ({trustCounts.needsInfo})
            </button>
            <button
              type="button"
              className={`trust-chip trust-chip-rules ${trustFilter === "rules-only" ? "trust-chip-active" : ""}`}
              onClick={() => setTrustFilter(trustFilter === "rules-only" ? "" : "rules-only")}
              title="Matched by rules; LLM verifier didn't run for this scheme"
            >
              ○ Rules only ({trustCounts.rulesOnly})
            </button>
          </div>

          {/* Structured filters */}
          <div className="filter-bar">
            <select value={stateFilter} onChange={(e) => { setStateFilter(e.target.value); setVisibleCount(PAGE_SIZE); }}>
              <option value="">All states</option>
              {filterOptions.states.map((s) => (<option key={s} value={s}>{s}</option>))}
            </select>
            <select value={categoryFilter} onChange={(e) => { setCategoryFilter(e.target.value); setVisibleCount(PAGE_SIZE); }}>
              <option value="">All categories</option>
              {filterOptions.categories.map((c) => (<option key={c} value={c}>{c}</option>))}
            </select>
            <select value={ministryFilter} onChange={(e) => { setMinistryFilter(e.target.value); setVisibleCount(PAGE_SIZE); }}>
              <option value="">All ministries</option>
              {filterOptions.ministries.map((m) => (<option key={m} value={m}>{m}</option>))}
            </select>
            {hasActiveFilters && (
              <button type="button" className="clear-filters-btn" onClick={clearAllFilters}>
                Clear filters
              </button>
            )}
          </div>

          <p className="result-count">
            Showing {visible.length} of {filtered.length}
            {filtered.length !== matches.length && ` (of ${matches.length} ranked)`}
            {" "}scheme{filtered.length === 1 ? "" : "s"}, most relevant first
          </p>

          <div className="scheme-grid">
            {visible.map((s) => (<SchemeCard key={s.schemeId} scheme={s} />))}
          </div>

          {hasMore && (
            <div style={{ textAlign: "center", marginTop: "1.5rem" }}>
              <button
                type="button"
                className="btn-primary"
                onClick={() => setVisibleCount((n) => n + PAGE_SIZE)}
              >
                Load more ({filtered.length - visibleCount} remaining)
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
