import { useState } from "react";
import { Link, useLocation, useNavigate } from "react-router-dom";
import { useAuth } from "../auth/AuthContext";

/**
 * Sign in.
 *
 * The backend deliberately returns the SAME message for an unknown address and
 * a wrong password, so this page must not try to be more helpful than that —
 * distinguishing them here would hand an attacker the account-enumeration
 * oracle the backend was written to deny.
 */
export default function Login() {
  const { login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  const destination = location.state?.from || "/matches";

  async function onSubmit(e) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await login(email.trim(), password);
      navigate(destination, { replace: true });
    } catch (err) {
      setError(err.friendlyMessage || "Could not sign in.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="container" style={{ maxWidth: 420, padding: "48px 0" }}>
      <h2>Sign in</h2>

      <form onSubmit={onSubmit}>
        <label htmlFor="login-email" style={{ display: "block", marginTop: 16 }}>
          Email
        </label>
        <input
          id="login-email"
          type="email"
          autoComplete="username"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          required
          style={{ width: "100%", padding: 10 }}
        />

        <label htmlFor="login-password" style={{ display: "block", marginTop: 16 }}>
          Password
        </label>
        <input
          id="login-password"
          type="password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          style={{ width: "100%", padding: 10 }}
        />

        {error && (
          <p role="alert" style={{ color: "#B3261E", marginTop: 16 }}>
            {error}
          </p>
        )}

        <button type="submit" disabled={busy} style={{ marginTop: 24, padding: "10px 20px" }}>
          {busy ? "Signing in…" : "Sign in"}
        </button>
      </form>

      <p style={{ marginTop: 24 }}>
        No account yet? <Link to="/register">Create one</Link>
      </p>
    </div>
  );
}
