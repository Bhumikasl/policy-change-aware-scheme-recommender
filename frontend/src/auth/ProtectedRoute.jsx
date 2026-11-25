import { Navigate, useLocation } from "react-router-dom";
import { useAuth } from "./AuthContext";

/**
 * Gate for pages that need a signed-in user.
 *
 * This is a CONVENIENCE, not a security control. It stops an anonymous visitor
 * seeing an empty broken page; it does not protect data. Every protected route
 * is enforced server-side by requireAuth/requireSelfOrAdmin, and must stay that
 * way — anyone can edit client state, so a frontend check is a hint, never a
 * boundary.
 *
 * `requireAdmin` behaves differently from "not signed in" on purpose: an
 * ordinary user who opens the admin page is told they lack permission, rather
 * than being sent to a login form they have already completed.
 */
export default function ProtectedRoute({ children, requireAdmin = false }) {
  const { isAuthenticated, isAdmin, loading } = useAuth();
  const location = useLocation();

  // Still confirming a stored token. Redirecting now would bounce a signed-in
  // user to the login page on every refresh.
  if (loading) {
    return (
      <div className="container" style={{ padding: "48px 0" }}>
        <p>Checking your session…</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    // Remember where they were headed so login can return them there.
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  if (requireAdmin && !isAdmin) {
    return (
      <div className="container" style={{ padding: "48px 0" }}>
        <h2>Not available</h2>
        <p>
          This page is for administrators. Your account is signed in, but does not have
          that role.
        </p>
      </div>
    );
  }

  return children;
}
