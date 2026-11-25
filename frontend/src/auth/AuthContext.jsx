import { createContext, useContext, useEffect, useMemo, useState, useCallback } from "react";
import api, { tokenStore, setAuthHandlers } from "../api/client";

/**
 * Authentication state for the whole app.
 *
 * The backend is the only authority on who the caller is. This provider never
 * decodes the JWT to decide anything — a token payload is attacker-controlled
 * once it leaves the server, so `role` is read from GET /api/auth/me, which is
 * verified server-side on every call.
 *
 * `loading` matters: on a refresh there is a token in storage but no confirmed
 * user yet, and rendering a protected route during that gap would bounce the
 * user to the login page every time they reload.
 */
const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true);
  const [forbiddenNotice, setForbiddenNotice] = useState("");

  const logout = useCallback(() => {
    tokenStore.clear();
    setUser(null);
  }, []);

  // Let the axios interceptor drive logout when a 401 comes back mid-session,
  // so an expired token clears the UI instead of leaving a stale name in the nav.
  useEffect(() => {
    setAuthHandlers({
      onUnauthorized: () => setUser(null),
      onForbidden: (err) =>
        setForbiddenNotice(err?.response?.data?.error || "You do not have permission to do that."),
    });
    return () => setAuthHandlers({});
  }, []);

  // Restore the session on load, if the stored token is still accepted.
  useEffect(() => {
    let cancelled = false;
    async function restore() {
      if (!tokenStore.get()) {
        setLoading(false);
        return;
      }
      try {
        const res = await api.get("/auth/me");
        if (!cancelled) setUser(res.data);
      } catch {
        // The interceptor has already cleared an invalid token.
        if (!cancelled) setUser(null);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    restore();
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const res = await api.post("/auth/login", { email, password });
    tokenStore.set(res.data.token);
    setUser(res.data.user);
    return res.data.user;
  }, []);

  const register = useCallback(async (payload) => {
    const res = await api.post("/auth/register", payload);
    tokenStore.set(res.data.token);
    setUser(res.data.user);
    return res.data.user;
  }, []);

  /** PUT /api/users/me — the authenticated replacement for the old POST /users. */
  const updateProfile = useCallback(async (payload) => {
    const res = await api.put("/users/me", payload);
    setUser(res.data);
    return res.data;
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: !!user,
      isAdmin: user?.role === "ADMIN",
      forbiddenNotice,
      clearForbiddenNotice: () => setForbiddenNotice(""),
      login,
      register,
      logout,
      updateProfile,
    }),
    [user, loading, forbiddenNotice, login, register, logout, updateProfile]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used inside <AuthProvider>");
  return ctx;
}
