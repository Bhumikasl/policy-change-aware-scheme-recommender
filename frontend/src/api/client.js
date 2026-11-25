import axios from "axios";

/**
 * API client.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS FILE CHANGED
 * ---------------------------------------------------------------------------
 * The backend was secured (JWT, requireAuth, requireSelfOrAdmin) without the
 * frontend being updated, so every protected call returned 401 and the app
 * could not talk to its own API. This adds the missing half: a token store, an
 * Authorization header, and handling for the two rejection codes.
 *
 * ---------------------------------------------------------------------------
 * TOKEN STORAGE — the tradeoff, stated
 * ---------------------------------------------------------------------------
 * The backend returns the JWT in the response body, so the browser has to keep
 * it somewhere. localStorage is used here because it survives a refresh and
 * needs no backend change.
 *
 * It is readable by any script on this origin, so a cross-site scripting bug
 * becomes a token theft. The stronger design is an httpOnly, SameSite=Strict
 * cookie, which script cannot read at all — but that requires the backend to
 * set and clear cookies and to carry CSRF protection, which is a backend
 * change and so outside K0. Recorded as known work, not silently accepted.
 *
 * What this file does do: keep the token in exactly one place, never log it,
 * and never send it anywhere but the Authorization header.
 */

const TOKEN_KEY = "schemeMonitor.token";

export const tokenStore = {
  get() {
    try {
      return localStorage.getItem(TOKEN_KEY);
    } catch {
      // Private mode, or storage disabled. Treat as logged out rather than
      // crashing the app on load.
      return null;
    }
  },
  set(token) {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {
      /* non-fatal: the session just will not survive a refresh */
    }
  },
  clear() {
    this.set(null);
  },
};

const api = axios.create({
  baseURL: import.meta.env?.VITE_API_BASE_URL || "http://localhost:4000/api",
});

/** Attach the bearer token to every outgoing request that has one. */
api.interceptors.request.use((config) => {
  const token = tokenStore.get();
  if (token) {
    config.headers = config.headers || {};
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

/**
 * Callbacks the auth provider registers, so this module can react to 401/403
 * without importing React state — which would be a circular dependency.
 */
const handlers = { onUnauthorized: null, onForbidden: null };

export function setAuthHandlers({ onUnauthorized, onForbidden } = {}) {
  handlers.onUnauthorized = onUnauthorized || null;
  handlers.onForbidden = onForbidden || null;
}

api.interceptors.response.use(
  (res) => res,
  (error) => {
    const status = error?.response?.status;

    // 401 — the token is missing, expired or invalid.
    if (status === 401) {
      tokenStore.clear();
      const url = error?.config?.url || "";
      if (url.includes("/auth/login") || url.includes("/auth/register")) {
        error.friendlyMessage =
          error?.response?.data?.error || "Invalid email or password.";
      } else {
        if (handlers.onUnauthorized) handlers.onUnauthorized();
        error.friendlyMessage =
          error?.response?.data?.error || "Your session has ended. Please sign in again.";
      }
    }

    // 403 — authenticated, but not allowed. The token is still VALID, so it
    // must not be cleared: logging someone out for opening an admin page they
    // cannot use would be wrong.
    if (status === 403) {
      if (handlers.onForbidden) handlers.onForbidden(error);
      error.friendlyMessage =
        error?.response?.data?.error || "You do not have permission to do that.";
    }

    if (!error.friendlyMessage) {
      error.friendlyMessage =
        error?.response?.data?.error || "Something went wrong. Please try again.";
    }
    return Promise.reject(error);
  }
);

export default api;
