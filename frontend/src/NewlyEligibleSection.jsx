import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "./api/client";
import { useAuth } from "./auth/AuthContext";
import "./NewlyEligibleSection.css";

/**
 * NewlyEligibleSection — "Newly eligible for you" / "Eligibility updated" UI.
 *
 * ADDITIVE. This component renders a section above the existing My Matches
 * grid when there are schemes the current user has recently become eligible
 * for due to an eligibility-rule change.
 *
 * If there are no newly-eligible schemes, the component renders nothing —
 * it has zero visual footprint in the normal case.
 *
 * It does NOT replace, modify, or wrap the existing MyMatches logic.
 */
export default function NewlyEligibleSection() {
  const { user } = useAuth();
  const [data, setData] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error

  useEffect(() => {
    if (!user?.email) return;
    let cancelled = false;
    setStatus("loading");
    api
      .get("/users/me/eligibility-updates", {
        params: { limit: 10, includeEligibilityUpdated: "false" },
      })
      .then((res) => {
        if (cancelled) return;
        setData(res.data);
        setStatus("ready");
      })
      .catch(() => {
        if (cancelled) return;
        setStatus("error");
      });
    return () => {
      cancelled = true;
    };
  }, [user?.email]);

  // Render nothing while loading, on error, or when there are no results.
  // The existing matches section is always shown regardless.
  if (status !== "ready") return null;
  if (!data?.newlyEligible?.length) return null;

  return (
    <section className="newly-eligible-section" aria-labelledby="newly-eligible-heading">
      <div className="newly-eligible-header">
        <h3 id="newly-eligible-heading" className="newly-eligible-title">
          🆕 Newly eligible for you
        </h3>
        <p className="newly-eligible-subtitle">
          Eligibility rules for these schemes were recently updated — and
          based on your current profile, you now qualify.
        </p>
      </div>

      <div className="newly-eligible-cards">
        {data.newlyEligible.map((item) => (
          <NewlyEligibleCard key={`${item.schemeId}:${item.triggeringChangeId}`} item={item} />
        ))}
      </div>

      {data.checkedAt && (
        <p className="newly-eligible-meta">
          Checked against{" "}
          {data.totalUpdatesChecked ?? "—"} recent update
          {data.totalUpdatesChecked !== 1 ? "s" : ""} ·{" "}
          last checked{" "}
          {new Date(data.checkedAt).toLocaleString("en-IN", {
            dateStyle: "medium",
            timeStyle: "short",
          })}
        </p>
      )}
    </section>
  );
}

function NewlyEligibleCard({ item }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <article className="newly-eligible-card" aria-label={`Newly eligible: ${item.schemeName}`}>
      <div className="newly-eligible-card-badge">
        <span className="neu-badge">🆕 Newly eligible</span>
        {item.ministry && (
          <span className="neu-ministry">{item.ministry}</span>
        )}
      </div>

      <h4 className="newly-eligible-card-title">{item.schemeName}</h4>

      <p className="newly-eligible-card-reason">{item.reason}</p>

      {item.explanation && (
        <div className="newly-eligible-card-explanation">
          <strong>Why you're seeing this:</strong>
          <br />
          {item.explanation}
        </div>
      )}

      {item.changedRules && item.changedRules.length > 0 && (
        <details
          className="newly-eligible-card-changes"
          open={expanded}
          onToggle={(e) => setExpanded(e.target.open)}
        >
          <summary className="neu-changes-summary">
            What changed ({item.changedRules.length} rule
            {item.changedRules.length !== 1 ? "s" : ""})
          </summary>
          <ul className="neu-changes-list">
            {item.changedRules.map((rule, i) => (
              // Rules are plain strings — key by index is fine (static list)
              // eslint-disable-next-line react/no-array-index-key
              <li key={i}>{rule}</li>
            ))}
          </ul>
        </details>
      )}

      {item.benefits && (
        <div className="newly-eligible-card-benefits">
          <strong>Benefits:</strong> {item.benefits}
        </div>
      )}

      <div className="newly-eligible-card-actions">
        <Link
          to={`/schemes/${item.schemeId}`}
          className="neu-view-link"
          aria-label={`View details for ${item.schemeName}`}
        >
          View scheme →
        </Link>
        {item.applicationLink && (
          <a
            href={item.applicationLink}
            target="_blank"
            rel="noopener noreferrer"
            className="neu-apply-link"
            aria-label={`Apply for ${item.schemeName} (opens in new tab)`}
          >
            Apply now ↗
          </a>
        )}
      </div>

      {item.updatedAt && (
        <p className="newly-eligible-card-date">
          Rules updated{" "}
          {new Date(item.updatedAt).toLocaleDateString("en-IN", {
            day: "numeric",
            month: "short",
            year: "numeric",
          })}
        </p>
      )}
    </article>
  );
}
