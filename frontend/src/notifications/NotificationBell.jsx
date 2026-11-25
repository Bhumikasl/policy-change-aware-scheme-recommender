import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { useNotifications } from "./NotificationContext";
import NotificationItem from "./NotificationItem";

/**
 * The bell, and the short dropdown behind it.
 *
 * The dropdown shows the five most recent; the full list lives at /notifications.
 * Loading, empty and error states are all rendered explicitly — a dropdown that
 * silently shows nothing is indistinguishable from one that failed.
 */
export default function NotificationBell() {
  const { items, unread, status, error, markRead, load } = useNotifications();
  const [open, setOpen] = useState(false);
  const ref = useRef(null);

  // Close on an outside click or Escape.
  useEffect(() => {
    if (!open) return undefined;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target)) setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const recent = items.slice(0, 5);

  return (
    <span ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) load(1, false);
        }}
        style={{
          background: "transparent",
          border: "none",
          color: "#FAF9F6",
          cursor: "pointer",
          fontSize: 18,
          position: "relative",
          lineHeight: 1,
          padding: "4px 6px",
        }}
      >
        <span aria-hidden="true">&#9993;</span>
        {unread > 0 && (
          <span
            style={{
              position: "absolute",
              top: -4,
              right: -4,
              background: "#B3261E",
              color: "#fff",
              borderRadius: 10,
              fontSize: 11,
              minWidth: 18,
              height: 18,
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              padding: "0 5px",
            }}
          >
            {/* Capped so a large backlog cannot stretch the nav bar. */}
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Notifications"
          style={{
            position: "absolute",
            right: 0,
            top: "calc(100% + 10px)",
            width: 380,
            maxWidth: "90vw",
            maxHeight: 460,
            overflowY: "auto",
            background: "#fff",
            color: "#222",
            border: "1px solid #E0DCD3",
            borderRadius: 8,
            boxShadow: "0 8px 24px rgba(0,0,0,0.14)",
            zIndex: 50,
          }}
        >
          <div
            style={{
              padding: "12px 16px",
              borderBottom: "1px solid #EDEAE4",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
            }}
          >
            <strong style={{ fontSize: 14 }}>Notifications</strong>
            <Link to="/notifications" onClick={() => setOpen(false)} style={{ fontSize: 13 }}>
              See all
            </Link>
          </div>

          {status === "loading" && recent.length === 0 && (
            <p style={{ padding: 20, color: "#666", margin: 0 }}>Loading…</p>
          )}

          {status === "error" && (
            <p role="alert" style={{ padding: 20, color: "#B3261E", margin: 0 }}>
              {error}
            </p>
          )}

          {status === "ready" && recent.length === 0 && (
            <p style={{ padding: 20, color: "#666", margin: 0 }}>
              Nothing yet. You will hear from us when a scheme change actually affects you —
              not for routine edits.
            </p>
          )}

          {recent.map((n) => (
            <NotificationItem key={n.id} notification={n} onMarkRead={markRead} compact />
          ))}
        </div>
      )}
    </span>
  );
}
