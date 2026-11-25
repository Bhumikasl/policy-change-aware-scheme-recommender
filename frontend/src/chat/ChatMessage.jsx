import { Link } from "react-router-dom";
import EligibilityVerdict from "./EligibilityVerdict";

/**
 * One turn of the conversation.
 *
 * Assistant turns render in a fixed order that mirrors how the answer was
 * produced: the deterministic verdict first, then the wording, then the
 * evidence it was grounded in. A reader who stops after the first block still
 * has the part that is true by construction.
 */
/**
 * What each degradation code means, in the reader's terms.
 *
 * The previous copy was a single fixed line — "Answered in reduced mode — some
 * services were unavailable" — shown for ANY degradation. In the default
 * configuration (EMBEDDING_PROVIDER unset, so local-hash vectors) that line
 * appeared on every answer while every service was in fact up, which reads as
 * an outage and is simply untrue.
 *
 * Each entry says what actually happened and, where it matters, what it does
 * NOT affect: the eligibility verdict comes from the rules engine, so no
 * degradation here can change it.
 */
const DEGRADED_TEXT = {
  EMBEDDINGS_LEXICAL:
    "Scheme search matched on wording rather than meaning, so a relevant passage may have been missed. Nothing was unavailable.",
  RETRIEVAL_UNAVAILABLE:
    "Scheme search was unavailable, so this answer may quote less supporting text than usual.",
  LLM_UNAVAILABLE:
    "The language model was unavailable, so this answer uses the built-in wording. The eligibility verdict is unaffected.",
  ANSWER_REJECTED_BY_GUARD:
    "A generated answer failed the safety checks and was replaced with the verified wording.",
};

export default function ChatMessage({ message }) {
  const isUser = message.role === "user";

  if (isUser) {
    return (
      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 14 }}>
        <div
          style={{
            background: "var(--color-primary, #1B3A2F)",
            color: "#FAF9F6",
            borderRadius: "12px 12px 2px 12px",
            padding: "9px 13px",
            maxWidth: "78%",
            whiteSpace: "pre-wrap",
          }}
        >
          {message.text}
        </div>
      </div>
    );
  }

  return (
    <div style={{ marginBottom: 18, maxWidth: "92%" }}>
      <EligibilityVerdict decision={message.eligibilityDecision} />

      <div
        style={{
          background: message.failed ? "#FDF3F2" : "#F4F3EF",
          border: message.failed ? "1px solid #E7C3C0" : "1px solid #E3E1DA",
          borderRadius: "12px 12px 12px 2px",
          padding: "10px 14px",
          whiteSpace: "pre-wrap",
          color: message.failed ? "#8A2B22" : "#222",
        }}
      >
        {message.text}
      </div>

      {message.recommendationContext && (
        <p style={{ fontSize: 13, color: "#555", margin: "8px 0 0" }}>
          {message.recommendationContext.rank != null
            ? `Currently ranked ${message.recommendationContext.rank} among the schemes you are eligible for.`
            : "This scheme is not currently in your eligible set."}
        </p>
      )}

      {/* Citations. An answer the reader cannot check is not much better than
          an ungrounded one, so the scheme and the version behind each excerpt
          are named and linked. */}
      {message.sources?.length > 0 && (
        <details style={{ marginTop: 8 }}>
          <summary style={{ cursor: "pointer", fontSize: 13, color: "#555" }}>
            Based on {message.sources.length} source
            {message.sources.length === 1 ? "" : "s"}
          </summary>
          <ul style={{ margin: "8px 0 0", paddingLeft: 18, fontSize: 13, color: "#444" }}>
            {message.sources.map((s, i) => (
              <li key={i} style={{ marginBottom: 6 }}>
                <Link to={`/schemes/${s.schemeId}`} style={{ color: "var(--color-primary, #1B3A2F)" }}>
                  {s.schemeId}
                </Link>{" "}
                <span style={{ color: "#777" }}>
                  (version {s.schemeVersion}, {s.field})
                </span>
                <div style={{ color: "#555", marginTop: 2 }}>{s.excerpt}</div>
              </li>
            ))}
          </ul>
        </details>
      )}

      {/* Grounding is stated, not implied. An answer with no verified evidence
          behind it must not look the same as one with citations. */}
      {!message.failed && !message.grounded && (
        <p style={{ fontSize: 12, color: "#8A6D3B", margin: "6px 0 0" }}>
          No verified scheme information matched this question.
        </p>
      )}
      {message.degraded && (
        <div style={{ fontSize: 12, color: "#8A6D3B", margin: "6px 0 0" }}>
          {(message.degradedReasons || [])
            .filter((code) => DEGRADED_TEXT[code])
            .map((code) => (
              <p key={code} style={{ margin: "2px 0" }}>
                {DEGRADED_TEXT[code]}
              </p>
            ))}
          {/* An older server, or a code this build does not recognise: fall
              back to a line that claims nothing specific rather than one that
              asserts an outage. */}
          {(message.degradedReasons || []).filter((code) => DEGRADED_TEXT[code]).length === 0 && (
            <p style={{ margin: "2px 0" }}>
              Answered in reduced mode. The eligibility verdict is unaffected.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
