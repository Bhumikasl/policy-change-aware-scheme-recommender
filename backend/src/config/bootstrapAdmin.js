const UserModel = require("../models/User");
const { ROLES } = require("../middleware/auth");
const logger = require("../utils/logger");

/**
 * Bootstrap the first ADMIN account.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * `.env.example` has said this since K0:
 *
 *     # Bootstrap admin. Created on first boot if no ADMIN user exists.
 *     ADMIN_EMAIL=
 *     ADMIN_PASSWORD=
 *
 * The code was never written. Nothing read either variable, `POST /auth/register`
 * always assigns ROLE=USER, and there was no seed or promote script — so no
 * ADMIN could exist, which made two things unreachable in a live deployment:
 *
 *   - `POST /api/collect/run` (requireAuth + requireAdmin), and with it the
 *     "Run collection" button on the frontend Admin page, which could only ever
 *     return 403;
 *   - the ADMIN branch of `requireSelfOrAdmin`, exercised by tests but dead in
 *     production.
 *
 * A configuration file that promises something the code does not do is worse
 * than one that says nothing: the operator sets a password, sees no error, and
 * reasonably concludes an admin exists.
 *
 * ---------------------------------------------------------------------------
 * WHAT IT DELIBERATELY WILL NOT DO
 * ---------------------------------------------------------------------------
 * It will NOT promote an existing account. If `ADMIN_EMAIL` names a user who is
 * already registered as a USER, this logs and does nothing.
 *
 * That restraint is the security property. Promotion-by-environment means
 * anyone who can edit `.env` — or set an environment variable on the host —
 * can silently grant themselves admin over an account that already holds a
 * real person's data. Creating a NEW account when none exists cannot take
 * anything over; promoting an existing one can. Ownership changes belong in a
 * deliberate, auditable action, not in a boot-time side effect.
 *
 * It is also idempotent: once any ADMIN exists, this does nothing on every
 * subsequent boot, so restarting the server cannot resurrect or reset an
 * account an operator has since changed or removed.
 */
async function bootstrapAdmin({ userModel = UserModel, env = process.env } = {}) {
  const email = String(env.ADMIN_EMAIL || "").trim().toLowerCase();
  const password = env.ADMIN_PASSWORD || "";

  // Not configured is the normal case, not an error.
  if (!email && !password) return { created: false, reason: "not configured" };

  // Half-configured is a mistake worth naming: silently doing nothing here is
  // how an operator ends up believing they have an admin account.
  if (!email || !password) {
    logger.warn(
      "Bootstrap admin: ADMIN_EMAIL and ADMIN_PASSWORD must BOTH be set. No admin created."
    );
    return { created: false, reason: "incomplete configuration" };
  }

  // The model enforces this too; checking here turns a startup crash into a
  // clear message that names the variable at fault.
  if (password.length < 8) {
    logger.warn("Bootstrap admin: ADMIN_PASSWORD is shorter than 8 characters. No admin created.");
    return { created: false, reason: "password too short" };
  }

  const existingAdmin = await userModel.findOne({ role: ROLES.ADMIN }).lean();
  if (existingAdmin) return { created: false, reason: "an admin already exists" };

  const sameEmail = await userModel.findOne({ email }).lean();
  if (sameEmail) {
    // See the header: promotion by environment variable is a privilege-
    // escalation path, so this stops and says so rather than escalating.
    logger.warn(
      "Bootstrap admin: ADMIN_EMAIL matches an existing non-admin account. " +
        "Refusing to promote it — change the role deliberately instead.",
      { email }
    );
    return { created: false, reason: "email belongs to an existing non-admin user" };
  }

  const admin = new userModel({ email, name: "Administrator", role: ROLES.ADMIN });
  await admin.setPassword(password);
  await admin.save();

  // The email identifies the account for the operator; the password is never
  // logged, at any level.
  logger.info("Bootstrap admin: created the first ADMIN account", { email });
  return { created: true, email };
}

module.exports = { bootstrapAdmin };
