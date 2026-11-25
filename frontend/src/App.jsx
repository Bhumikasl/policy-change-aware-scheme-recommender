import { BrowserRouter, Routes, Route, NavLink, Link } from "react-router-dom";
import { AuthProvider, useAuth } from "./auth/AuthContext";
import ProtectedRoute from "./auth/ProtectedRoute";
import { NotificationProvider } from "./notifications/NotificationContext";
import NotificationBell from "./notifications/NotificationBell";
import Register from "./pages/Register";
import Login from "./pages/Login";
import Browse from "./pages/Browse";
import SchemeDetail from "./pages/SchemeDetail";
import MyMatches from "./pages/MyMatches";
import History from "./pages/History";
import Notifications from "./pages/Notifications";
import Assistant from "./pages/Assistant";
import Admin from "./pages/Admin";

function Nav() {
  const { isAuthenticated, isAdmin, user, logout, loading } = useAuth();

  const linkStyle = ({ isActive }) => ({
    color: isActive ? "#E08D3C" : "#FAF9F6",
    fontWeight: isActive ? 600 : 400,
    textDecoration: "none",
    padding: "6px 0",
  });

  return (
    <nav style={{ background: "var(--color-primary)", padding: "16px 0" }}>
      <div
        className="container"
        style={{ display: "flex", alignItems: "center", gap: 28, flexWrap: "wrap" }}
      >
        <span
          style={{
            fontFamily: "var(--font-display)",
            color: "#FAF9F6",
            fontSize: 20,
            fontWeight: 600,
          }}
        >
          Scheme Monitor
        </span>

        <NavLink to="/" style={linkStyle} end>
          Browse
        </NavLink>

        {/* Signed-in destinations are hidden rather than shown-and-broken: the
            server rejects them anyway, so offering them would only produce a
            401 the visitor cannot act on. */}
        {isAuthenticated && (
          <>
            <NavLink to="/matches" style={linkStyle}>
              My Matches
            </NavLink>
            <NavLink to="/history" style={linkStyle}>
              What Changed
            </NavLink>
            <NavLink to="/assistant" style={linkStyle}>
              Assistant
            </NavLink>
          </>
        )}

        {isAdmin && (
          <NavLink to="/admin" style={linkStyle}>
            Admin
          </NavLink>
        )}

        <span style={{ marginLeft: "auto", display: "flex", gap: 16, alignItems: "center" }}>
          {loading ? null : isAuthenticated ? (
            <>
              <NotificationBell />
              <span style={{ color: "#FAF9F6", opacity: 0.85 }}>
                {user?.name || user?.email}
              </span>
              <button
                onClick={logout}
                style={{
                  background: "transparent",
                  color: "#FAF9F6",
                  border: "1px solid #FAF9F6",
                  borderRadius: 4,
                  padding: "4px 12px",
                  cursor: "pointer",
                }}
              >
                Sign out
              </button>
            </>
          ) : (
            <>
              <Link to="/login" style={{ color: "#FAF9F6", textDecoration: "none" }}>
                Sign in
              </Link>
              <Link to="/register" style={{ color: "#E08D3C", textDecoration: "none" }}>
                Create account
              </Link>
            </>
          )}
        </span>
      </div>
    </nav>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        {/* Inside AuthProvider: it reads isAuthenticated to know when to load,
            and to clear one user's notifications when another signs in. */}
        <NotificationProvider>
        <Nav />
        <Routes>
          {/* Public: browsing schemes needs no account. */}
          <Route path="/" element={<Browse />} />
          <Route path="/schemes/:schemeId" element={<SchemeDetail />} />
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />

          {/* Signed in. The server enforces this too — these guards only
              prevent a broken-looking page, they are not the boundary. */}
          <Route
            path="/matches"
            element={
              <ProtectedRoute>
                <MyMatches />
              </ProtectedRoute>
            }
          />
          <Route
            path="/history"
            element={
              <ProtectedRoute>
                <History />
              </ProtectedRoute>
            }
          />
          <Route
            path="/notifications"
            element={
              <ProtectedRoute>
                <Notifications />
              </ProtectedRoute>
            }
          />
          <Route
            path="/assistant"
            element={
              <ProtectedRoute>
                <Assistant />
              </ProtectedRoute>
            }
          />
          <Route
            path="/admin"
            element={
              <ProtectedRoute requireAdmin>
                <Admin />
              </ProtectedRoute>
            }
          />
        </Routes>
        </NotificationProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}
