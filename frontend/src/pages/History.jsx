import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import api from "../api/client";

/**
 * "Why did my recommendations change?"
 *
 * The read side of the Phase J audit trail. Until K0 these rows were written
 * on every policy change and were unreachable, so the system could say "you
 * are eligible" but never "you became eligible on 12 March, because the income
 * ceiling rose from ₹2.5 lakh to ₹3 lakh".
 *
 * Everything shown here is grounded in stored data: the scheme versions that
 * bracket the change, the fields that actually moved, and the transition the
 * matcher computed. Nothing on this page is generated prose — the Explanation
 * Agent (Phase K) fills `explanation`, and until it runs the field is null and
 * this page says so rather than showing a blank.
 */

const ELIGIBILITY_LABEL = {
  INELIGIBLE_TO_ELIGIBLE: "You became eligible",
  ELIGIBLE_TO_INELIGIBLE: "You are no longer eligible",
  ELIGIBLE_TO_ELIGIBLE: "Still eligible",
  INELIGIBLE_TO_INELIGIBLE: "Still not eligible",
};

const RECOMMENDATION_LABEL = {
  NOT_RECOMMENDED_TO_RECOMMENDED: "Added to your recommendations",
  RECOMMENDED_TO_NOT_RECOMMENDED: "Removed from your recommendations",
  // Rank 1 is the best position, so "moved up" means the NUMBER went down.
  RANK_INCREASED: "Moved up your list",
  RANK_DECREASED: "Moved down your list",
  NO_CHANGE: "Position unchanged",
};

const money = (v) =>
  typeof v === "number" ? `₹${v.toLocaleString("en-IN")}` : String(v ?? "—");

function fieldLabel(field) {
  const map = {
    "eligibilityRules.maxAnnualIncome": "Maximum annual income",
    "eligibilityRules.minAnnualIncome": "Minimum annual income",
    "eligibilityRules.maxAge": "Maximum age",
    "eligibilityRules.minAge": "Minimum age",
    "eligibilityRules.minEducationLevel": "Minimum education",
    "eligibilityRules.minMarksPercentage": "Minimum marks",
    lastDate: "Application deadline",
    benefits: "Benefits",
    documents: "Required documents",
    status: "Scheme status",
    eligibility: "Eligibility wording",
  };
  return map[field] || field;
}

function ChangedField({ field, oldValue, newValue }) {
  const isMoney = String(field).includes("Income");
  const fmt = isMoney ? money : (v) => (Array.isArray(v) ? v.join(", ") : String(v ?? "—"));
  return (
    <li>
      <strong>{fieldLabel(field)}:</strong> {fmt(oldValue)} → {fmt(newValue)}
    </li>
  );
}

export default function History() {
  const [data, setData] = useState(null);
  const [page, setPage] = useState(1);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    api
      .get("/users/me/recommendation-history", { params: { page, limit: 20 } })
      .then((res) => {
        if (!cancelled) {
          setData(res.data);
          setError("");
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err.friendlyMessage || "Could not load your history.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [page]);

  if (loading && !data) {
    return (
      <div className="container" style={{ padding: "48px 0" }}>
        <p>Loading your recommendation history…</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="container" style={{ padding: "48px 0" }}>
        <h2>Recommendation history</h2>
        <p role="alert" style={{ color: "#B3261E" }}>{error}</p>
      </div>
    );
  }

  const items = data?.items || [];

  return (
    <div className="container" style={{ padding: "32px 0", maxWidth: 780 }}>
      <h2>Why did my recommendations change?</h2>
      <p style={{ color: "#555" }}>
        Every entry here was created by a real change to a government scheme, and links
        back to the exact versions it happened between.
      </p>

      {items.length === 0 && (
        <p style={{ marginTop: 32 }}>
          Nothing yet. Entries appear when a scheme you match against is updated in a way
          that affects you — not for routine edits like a ministry being renamed.
        </p>
      )}

      {items.map((item) => (
        <article
          key={item.id}
          style={{
            border: "1px solid #E0DCD3",
            borderRadius: 8,
            padding: 20,
            marginTop: 20,
          }}
        >
          <div style={{ display: "flex", justifyContent: "space-between", gap: 16 }}>
            <h3 style={{ margin: 0 }}>
              <Link to={`/schemes/${encodeURIComponent(item.scheme.schemeId)}`}>
                {item.scheme.name || item.scheme.schemeId}
              </Link>
            </h3>
            <time style={{ color: "#777", whiteSpace: "nowrap" }}>
              {new Date(item.createdAt).toLocaleDateString("en-IN")}
            </time>
          </div>

          <p style={{ marginTop: 8 }}>
            <strong>{ELIGIBILITY_LABEL[item.eligibility.transition] || item.eligibility.transition}</strong>
            {" · "}
            {RECOMMENDATION_LABEL[item.recommendation.transition] || item.recommendation.transition}
          </p>

          {item.recommendation.previousRank !== item.recommendation.currentRank && (
            <p style={{ color: "#555", margin: "4px 0" }}>
              Position: {item.recommendation.previousRank ?? "not listed"} →{" "}
              {item.recommendation.currentRank ?? "not listed"}
              {item.recommendation.topK ? ` (top ${item.recommendation.topK})` : ""}
            </p>
          )}

          {item.reason.changedFields.length > 0 && (
            <>
              <p style={{ marginTop: 12, marginBottom: 4 }}>What changed in the scheme:</p>
              <ul style={{ marginTop: 0 }}>
                {item.reason.changedFields.map((f) => (
                  <ChangedField key={f.field} {...f} />
                ))}
              </ul>
            </>
          )}

          <p style={{ color: "#777", fontSize: 14, marginTop: 12 }}>
            Scheme version {item.versions.previous ?? "—"} → {item.versions.current ?? "—"}
          </p>

          {item.explanation ? (
            <p style={{ marginTop: 12, fontStyle: "italic" }}>{item.explanation}</p>
          ) : (
            <p style={{ marginTop: 12, color: "#999", fontSize: 14 }}>
              A plain-language explanation is not available for this entry.
            </p>
          )}
        </article>
      ))}

      {data && data.pages > 1 && (
        <div style={{ display: "flex", gap: 12, marginTop: 24, alignItems: "center" }}>
          <button onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={page <= 1}>
            Previous
          </button>
          <span>
            Page {data.page} of {data.pages}
          </span>
          <button
            onClick={() => setPage((p) => Math.min(data.pages, p + 1))}
            disabled={page >= data.pages}
          >
            Next
          </button>
        </div>
      )}
    </div>
  );
}
