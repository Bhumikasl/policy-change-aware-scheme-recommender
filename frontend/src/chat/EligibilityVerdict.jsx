/**
 * The deterministic eligibility verdict, rendered as a verdict — not as prose.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS A SEPARATE COMPONENT
 * ---------------------------------------------------------------------------
 * The whole architecture rests on the rules engine deciding eligibility and
 * the language model only phrasing it. If the interface renders both as one
 * undifferentiated paragraph, the person cannot tell which part is a computed
 * decision and which part is generated wording — and a separation the user
 * cannot see gives the user nothing.
 *
 * So the verdict is shown first, on its own, visually distinct, with the rules
 * that produced it. The generated explanation sits below it as commentary. If
 * generation failed entirely, this block is still complete and still correct.
 */
export default function EligibilityVerdict({ decision }) {
  if (!decision) return null;

  const eligible = decision.eligible;
  const needsMoreInfo = decision.status === "NEEDS_MORE_INFORMATION" || decision.needsMoreInfo;
  const reasons = eligible
    ? decision.satisfied || []
    : needsMoreInfo
      ? decision.unresolved || decision.unsatisfied || []
      : decision.unsatisfied || [];

  const color = eligible ? "#2E7D32" : needsMoreInfo ? "#B26A00" : "#B3261E";
  const bg = eligible ? "#F1F8F2" : needsMoreInfo ? "#FFF7E8" : "#FDF3F2";
  const label = eligible ? "ELIGIBLE" : needsMoreInfo ? "NEEDS MORE INFORMATION" : "NOT ELIGIBLE";

  return (
    <div
      style={{
        border: `1px solid ${color}`,
        borderLeftWidth: 4,
        borderRadius: 6,
        padding: "12px 14px",
        marginBottom: 10,
        background: bg,
      }}
    >
      <div style={{ display: "flex", alignItems: "baseline", gap: 10, flexWrap: "wrap" }}>
        <strong
          style={{
            color,
            letterSpacing: 0.4,
            fontSize: 14,
          }}
        >
          {label}
        </strong>
        <span style={{ color: "#444", fontSize: 14 }}>{decision.schemeName}</span>
        {decision.schemeVersion != null && (
          <span style={{ color: "#777", fontSize: 12 }}>version {decision.schemeVersion}</span>
        )}
      </div>

      {needsMoreInfo && (
        <p style={{ margin: "8px 0 0", fontSize: 13, color: "#8a5a00" }}>
          We can't confirm this yet — some profile information is missing.
        </p>
      )}

      {reasons.length > 0 && (
        <ul style={{ margin: "8px 0 0", paddingLeft: 18, color: "#333", fontSize: 14 }}>
          {reasons.map((r, i) => (
            <li key={i}>{r.reason}</li>
          ))}
        </ul>
      )}

      {/* Says plainly where the decision came from. The model did not make it,
          and the person is entitled to know that. */}
      <p style={{ margin: "8px 0 0", fontSize: 12, color: "#666" }}>
        Decided by the eligibility rules engine from your profile
        {decision.source ? "" : ""} — not by the assistant.
      </p>
    </div>
  );
}
