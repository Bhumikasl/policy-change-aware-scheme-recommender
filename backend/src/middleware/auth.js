const jwt = require("jsonwebtoken");
const { unauthorized, forbidden } = require("./errorHandler");

/**
 * JWT authentication + role-based authorization.
 *
 * Threat this closes (PROJECT_AUDIT S-4): before this, every route was public.
 * `GET /api/users/:email` returned a stranger's caste categories, income, age
 * and education to anyone who guessed an email — a textbook IDOR over data
 * that is sensitive under India's DPDP Act. `POST /api/collect/run` let an
 * anonymous caller trigger a ~4,700-scheme crawl, burning the myScheme quota
 * and the LLM budget.
 *
 * Roles: USER (own data only) and ADMIN (everything + operational routes).
 */

const ROLES = Object.freeze({ USER: "USER", ADMIN: "ADMIN" });

function getSecret() {
  const s = process.env.JWT_SECRET;
  if (!s || s.length < 32) {
    // Fail loudly rather than silently signing with a weak/default key.
    throw new Error(
      "JWT_SECRET is missing or shorter than 32 characters. Generate one with: " +
        `node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`
    );
  }
  return s;
}

function signToken(user) {
  return jwt.sign(
    { sub: String(user._id), email: user.email, role: user.role || ROLES.USER },
    getSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

function readBearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7).trim() : null;
}

/** Hard gate: a valid token is required. */
function requireAuth(req, res, next) {
  const token = readBearer(req);
  if (!token) return next(unauthorized("Missing bearer token"));
  try {
    req.user = jwt.verify(token, getSecret());
    return next();
  } catch (err) {
    const msg = err.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    return next(unauthorized(msg));
  }
}

/** Attach req.user when a token is present; never rejects. */
function optionalAuth(req, res, next) {
  const token = readBearer(req);
  if (token) {
    try {
      req.user = jwt.verify(token, getSecret());
    } catch {
      /* ignore — treated as anonymous */
    }
  }
  return next();
}

function requireRole(...allowed) {
  return function roleGate(req, res, next) {
    if (!req.user) return next(unauthorized());
    if (!allowed.includes(req.user.role)) {
      return next(forbidden(`Requires role: ${allowed.join(" or ")}`));
    }
    return next();
  };
}

const requireAdmin = requireRole(ROLES.ADMIN);

/**
 * Ownership gate for `/users/:email/...`.
 *
 * A USER may only read their own record; an ADMIN may read anyone's. The email
 * comparison is case-insensitive because addresses are stored lowercased.
 */
function requireSelfOrAdmin(paramName = "email") {
  return function ownershipGate(req, res, next) {
    if (!req.user) return next(unauthorized());
    if (req.user.role === ROLES.ADMIN) return next();
    const target = String(req.params[paramName] || "").toLowerCase();
    if (target && target === String(req.user.email || "").toLowerCase()) return next();
    // 403, not 404: the caller is authenticated, just not entitled. We do not
    // reveal whether the target account exists.
    return next(forbidden("You can only access your own profile"));
  };
}

module.exports = {
  ROLES,
  signToken,
  requireAuth,
  optionalAuth,
  requireRole,
  requireAdmin,
  requireSelfOrAdmin,
};
