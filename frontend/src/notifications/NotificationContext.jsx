import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import api from "../api/client";
import { useAuth } from "../auth/AuthContext";

/**
 * Notification state.
 *
 * Every call goes to the authenticated `/users/me/notifications` endpoints.
 * There is no public notification route and this must never gain one: the
 * server derives the user from the verified token, so the client never sends
 * an id and there is nothing here for a caller to tamper with.
 *
 * Polling rather than websockets. A five-minute-scale pipeline does not need a
 * persistent connection, and a socket would add reconnection, auth-on-upgrade
 * and fan-out concerns for no benefit the user could perceive.
 */
const NotificationContext = createContext(null);

const POLL_MS = Number(import.meta.env?.VITE_NOTIFICATION_POLL_MS) || 60_000;

export function NotificationProvider({ children }) {
  const { isAuthenticated } = useAuth();
  const [items, setItems] = useState([]);
  const [unread, setUnread] = useState(0);
  const [page, setPage] = useState(1);
  const [pages, setPages] = useState(1);
  const [total, setTotal] = useState(0);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [error, setError] = useState("");

  const reset = useCallback(() => {
    setItems([]);
    setUnread(0);
    setPage(1);
    setPages(1);
    setTotal(0);
    setStatus("idle");
    setError("");
  }, []);

  /**
   * @param {number} nextPage
   * @param {boolean} append  true for "load more", false to replace
   */
  const load = useCallback(
    async (nextPage = 1, append = false) => {
      if (!isAuthenticated) return;
      setStatus("loading");
      try {
        const res = await api.get("/users/me/notifications", {
          params: { page: nextPage, limit: 20 },
        });
        const data = res.data || {};
        setItems((prev) => (append ? [...prev, ...(data.items || [])] : data.items || []));
        setUnread(data.unread || 0);
        setPage(data.page || nextPage);
        setPages(data.pages || 1);
        setTotal(data.total || 0);
        setStatus("ready");
        setError("");
      } catch (err) {
        // A 401 has already cleared the token in the interceptor; the auth
        // provider will unmount this. Anything else is shown to the user.
        setStatus("error");
        setError(err.friendlyMessage || "Could not load your notifications.");
      }
    },
    [isAuthenticated]
  );

  /** Refresh only the unread count — the bell, without the list. */
  const refreshUnread = useCallback(async () => {
    if (!isAuthenticated) return;
    try {
      const res = await api.get("/users/me/notifications", { params: { limit: 1 } });
      setUnread(res.data?.unread || 0);
    } catch {
      // A failing badge must not surface an error banner over the whole app.
    }
  }, [isAuthenticated]);

  const markRead = useCallback(async (id) => {
    // Optimistic: the badge should not lag a click. Reverted if the server
    // disagrees, so a failure cannot leave a permanently wrong count.
    let wasUnread = false;
    setItems((prev) =>
      prev.map((n) => {
        if (n.id !== id) return n;
        wasUnread = !n.read;
        return { ...n, read: true };
      })
    );
    if (wasUnread) setUnread((u) => Math.max(0, u - 1));

    try {
      await api.post(`/users/me/notifications/${encodeURIComponent(id)}/read`);
    } catch (err) {
      setItems((prev) => prev.map((n) => (n.id === id ? { ...n, read: false } : n)));
      if (wasUnread) setUnread((u) => u + 1);
      throw err;
    }
  }, []);

  const markAllRead = useCallback(async () => {
    const snapshot = items;
    const previousUnread = unread;
    setItems((prev) => prev.map((n) => ({ ...n, read: true })));
    setUnread(0);
    try {
      await api.post("/users/me/notifications/read-all");
    } catch (err) {
      setItems(snapshot);
      setUnread(previousUnread);
      throw err;
    }
  }, [items, unread]);

  // Load on sign-in, clear on sign-out. Without the clear, one user's
  // notifications would still be on screen after another signs in.
  useEffect(() => {
    if (!isAuthenticated) {
      reset();
      return undefined;
    }
    load(1, false);
    const timer = setInterval(refreshUnread, POLL_MS);
    return () => clearInterval(timer);
  }, [isAuthenticated, load, refreshUnread, reset]);

  const value = useMemo(
    () => ({
      items,
      unread,
      page,
      pages,
      total,
      status,
      error,
      hasMore: page < pages,
      load,
      loadMore: () => load(page + 1, true),
      refreshUnread,
      markRead,
      markAllRead,
    }),
    [items, unread, page, pages, total, status, error, load, refreshUnread, markRead, markAllRead]
  );

  return <NotificationContext.Provider value={value}>{children}</NotificationContext.Provider>;
}

export function useNotifications() {
  const ctx = useContext(NotificationContext);
  if (!ctx) throw new Error("useNotifications must be used inside <NotificationProvider>");
  return ctx;
}
