import { Link } from "react-router-dom";

/**
 * One notification.
 *
 * Renders only fields the API returns. The server's serialiser is an
 * allow-list, so userId, processingJobId, retryCount, lastError and the
 * denormalised email never arrive here — but this component also never reaches
 * for them, so adding a field server-side does not silently surface it.
 */

const TYPE_LABEL = {
  NEWLY_ELIGIBLE: "Newly eligible",
  NO_LONGER_ELIGIBLE: "No longer eligible",
  RECOMMENDATION_ENTERED_TOP_K: "Added to your recommendations",
  RECOMMENDATION_LEFT_TOP_K: "Left your recommendations",
  RANK_INCREASED: "Moved up",
  RANK_DECREASED: "Moved down",
  DEADLINE_CHANGED: "Deadline changed",
  BENEFIT_CHANGED: "Benefits changed",
  DOCUMENTS_CHANGED: "Documents changed",
};

const SEVERITY_COLOR = {
  CRITICAL: "#B3261E",
  HIGH: "#E08D3C",
  MEDIUM: "#4A6FA5",
  LOW: "#777",
};

function timeAgo(iso) {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";
  const mins = Math.floor((Date.now() - then) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(then).toLocaleDateString("en-IN");
}

export default function NotificationItem({ notification, onMarkRead, compact = false }) {
  const n = notification;

  return (
    <article
      style={{
        padding: compact ? "12px 14px" : "18px 20px",
        borderBottom: "1px solid #EDEAE4",
        background: n.read ? "transparent" : "#FFF8EF",
        display: "flex",
        gap: 12,
      }}
    >
      <span
        aria-hidden="true"
        style={{
          width: 8,
          height: 8,
          borderRadius: "50%",
          marginTop: 6,
          flexShrink: 0,
          background: n.read ? "transparent" : SEVERITY_COLOR[n.severity] || "#777",
        }}
      />

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: 10 }}>
          <span
            style={{
              fontSize: 12,
              textTransform: "uppercase",
              letterSpacing: 0.4,
              color: SEVERITY_COLOR[n.severity] || "#777",
            }}
          >
            {TYPE_LABEL[n.type] || n.type}
          </span>
          <time
            dateTime={n.createdAt}
            title={new Date(n.createdAt).toLocaleString("en-IN")}
            style={{ fontSize: 12, color: "#888", whiteSpace: "nowrap" }}
          >
            {timeAgo(n.createdAt)}
          </time>
        </div>

        <h4 style={{ margin: "4px 0 0", fontSize: compact ? 14 : 16 }}>{n.title}</h4>

        {/* When Phase K produced a grounded explanation this is that sentence.
            bodySource lets the UI say so rather than presenting a generic line
            as though it were specific. */}
        <p style={{ margin: "6px 0 0", fontSize: 14, color: "#444" }}>{n.body}</p>

        <div style={{ display: "flex", gap: 14, marginTop: 10, flexWrap: "wrap" }}>
          <Link
            to={`/schemes/${encodeURIComponent(n.scheme.schemeId)}`}
            style={{ fontSize: 13 }}
          >
            View scheme
          </Link>
          <Link to="/history" style={{ fontSize: 13 }}>
            Why did this change?
          </Link>
          {!n.read && (
            <button
              type="button"
              onClick={() => onMarkRead?.(n.id)}
              style={{
                fontSize: 13,
                background: "none",
                border: "none",
                color: "#4A6FA5",
                cursor: "pointer",
                padding: 0,
              }}
            >
              Mark as read
            </button>
          )}
          {n.bodySource === "explanation" && (
            <span style={{ fontSize: 12, color: "#8A8A8A" }} title="Generated from the recorded scheme change">
              explained
            </span>
          )}
        </div>
      </div>
    </article>
  );
}
