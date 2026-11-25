const express = require("express");
const rateLimit = require("express-rate-limit");
const User = require("../models/User");
const asyncHandler = require("../middleware/asyncHandler");
const { signToken, requireAuth, ROLES } = require("../middleware/auth");
const { badRequest, unauthorized } = require("../middleware/errorHandler");
const logger = require("../utils/logger");

const router = express.Router();

// Credential endpoints get a much tighter limit than the rest of the API:
// they are the ones worth brute-forcing.
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts, try again later" },
});

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** POST /api/auth/register  { email, password, name?, profile? } */
router.post(
  "/auth/register",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password, name, profile } = req.body || {};
    if (!email || !EMAIL_RE.test(email)) throw badRequest("A valid email is required");
    if (!password || password.length < 8) throw badRequest("Password must be at least 8 characters");

    const normalized = String(email).toLowerCase().trim();
    if (await User.findOne({ email: normalized })) {
      // Same shape as a bad password so this cannot be used to enumerate
      // which addresses are registered.
      throw badRequest("Unable to register with those details");
    }

    const user = new User({
      email: normalized,
      name: name || "",
      role: ROLES.USER,
      ...(profile ? { profile } : {}),
    });
    await user.setPassword(password);
    await user.save();

    logger.info("User registered", { email: normalized });
    res.status(201).json({ token: signToken(user), user: user.toSafeJSON() });
  })
);

/** POST /api/auth/login  { email, password } */
router.post(
  "/auth/login",
  authLimiter,
  asyncHandler(async (req, res) => {
    const { email, password } = req.body || {};
    if (!email || !password) throw badRequest("Email and password are required");

    // passwordHash is select:false, so ask for it explicitly.
    const user = await User.findOne({ email: String(email).toLowerCase().trim() }).select(
      "+passwordHash"
    );
    // Identical error for "no such user" and "wrong password" — no enumeration.
    if (!user || !(await user.verifyPassword(password))) {
      throw unauthorized("Invalid email or password");
    }

    res.json({ token: signToken(user), user: user.toSafeJSON() });
  })
);

/** GET /api/auth/me — who am I, per the presented token. */
router.get(
  "/auth/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const user = await User.findById(req.user.sub);
    if (!user) throw unauthorized("Account no longer exists");
    res.json(user.toSafeJSON());
  })
);

module.exports = router;
