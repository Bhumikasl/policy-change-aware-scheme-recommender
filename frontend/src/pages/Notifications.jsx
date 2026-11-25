import { useState } from "react";
import { useNotifications } from "../notifications/NotificationContext";
import NotificationItem from "../notifications/NotificationItem";

/** The full inbox: every state rendered explicitly, and paged on demand. */
export default function Notifications() {
  const { items, unread, total, status, error, hasMore, loadMore, markRead, markAllRead, load } =
    useNotifications();
  const [actionError, setActionError] = useState("");

  async function onMarkAll() {
    setActionError("");
    try {
      await markAllRead();
    } catch (err) {
      setActionError(err.friendlyMessage || "Could not mark everything as read.");
    }
  }

  async function onMarkOne(id) {
    setActionError("");
    try {
      await markRead(id);
    } catch (err) {
      setActionError(err.friendlyMessage || "Could not mark that as read.");
    }
  }

  return (
    <div className="container" style={{ padding: "32px 0", maxWidth: 760 }}>
      <header style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 16 }}>
        <div>
          <h2 style={{ margin: 0 }}>Notifications</h2>
          <p style={{ color: "#555", margin: "6px 0 0" }}>
            {total > 0
              ? `${total} in total${unread > 0 ? `, ${unread} unread` : ""}`
              : "Changes to schemes that actually affect you."}
          </p>
        </div>
        {unread > 0 && (
          <button type="button" onClick={onMarkAll} style={{ padding: "8px 14px" }}>
            Mark all as read
          </button>
        )}
      </header>

      {actionError && (
        <p role="alert" style={{ color: "#B3261E", marginTop: 16 }}>
          {actionError}
        </p>
      )}

      {status === "loading" && items.length === 0 && (
        <p style={{ marginTop: 32, color: "#666" }}>Loading your notifications…</p>
      )}

      {status === "error" && (
        <div style={{ marginTop: 32 }}>
          <p role="alert" style={{ color: "#B3261E" }}>{error}</p>
          <button type="button" onClick={() => load(1, false)} style={{ marginTop: 12 }}>
            Try again
          </button>
        </div>
      )}

      {status === "ready" && items.length === 0 && (
        <div style={{ marginTop: 40, padding: 28, border: "1px dashed #DDD7CC", borderRadius: 8 }}>
          <h3 style={{ marginTop: 0 }}>Nothing yet</h3>
          <p style={{ color: "#555", marginBottom: 0 }}>
            You will be told when a scheme change moves your eligibility or your recommendations —
            not when a ministry is renamed or wording is tidied up.
          </p>
        </div>
      )}

      {items.length > 0 && (
        <div style={{ marginTop: 24, border: "1px solid #E0DCD3", borderRadius: 8, overflow: "hidden" }}>
          {items.map((n) => (
            <NotificationItem key={n.id} notification={n} onMarkRead={onMarkOne} />
          ))}
        </div>
      )}

      {hasMore && (
        <button
          type="button"
          onClick={loadMore}
          disabled={status === "loading"}
          style={{ marginTop: 20, padding: "10px 18px" }}
        >
          {status === "loading" ? "Loading…" : "Load more"}
        </button>
      )}
    </div>
  );
}
