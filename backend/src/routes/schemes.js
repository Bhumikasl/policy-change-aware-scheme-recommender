const express = require("express");
const rateLimit = require("express-rate-limit");
const asyncHandler = require("../middleware/asyncHandler");
const { requireAuth, requireAdmin } = require("../middleware/auth");
const Scheme = require("../models/Scheme");
const SchemeHistory = require("../models/SchemeHistory");
const { runCollectionCycle } = require("../services/pipeline");
const {
  toPublicScheme,
  toPublicSchemes,
  toPublicHistory,
} = require("../services/publicProjection");

const router = express.Router();

// GET /api/schemes/meta/filters -> distinct states and categories across the
// full collection (not capped like the main list route), so filter dropdowns
// can offer every real option instead of a best-effort sample.
router.get(
  "/schemes/meta/filters",
  asyncHandler(async (req, res) => {
    const [rawStates, categories] = await Promise.all([
      Scheme.distinct("state", { status: { $ne: "Closed" } }),
      Scheme.distinct("category", { status: { $ne: "Closed" } }),
    ]);
    // scheme.state can be a comma-joined list of states (mySchemeCollector
    // joins beneficiaryState arrays as "Karnataka, Tamil Nadu"); flatten so
    // the dropdown shows individual states, not compound strings.
    const states = [
      ...new Set(
        rawStates
          .filter(Boolean)
          .flatMap((s) => s.split(",").map((x) => x.trim()))
          .filter(Boolean)
      ),
    ].sort();
    res.json({
      states,
      categories: categories.filter(Boolean).sort(),
    });
  })
);

function escapeRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// GET /api/schemes?state=Karnataka&category=Student&search=kisan
router.get(
  "/schemes",
  asyncHandler(async (req, res) => {
    const { state, category, search, includeClosed } = req.query;
    const filter = {};
    // scheme.state may be a single value ("Karnataka"), "All India", or a
    // comma-joined list. Match schemes whose state field contains the
    // requested state as one of its members, so multi-state schemes still
    // appear when filtered by any of their states.
    if (state) {
      filter.state = {
        $regex: new RegExp(`(^|,\\s*)${escapeRegex(state)}(\\s*,|$)`, "i"),
      };
    }
    if (category) filter.category = category;
    if (search) filter.name = { $regex: search, $options: "i" };
    // Hide expired/closed schemes by default - pass ?includeClosed=true to see them anyway.
    if (includeClosed !== "true") filter.status = { $ne: "Closed" };

    const schemes = await Scheme.find(filter).sort({ lastUpdatedAt: -1 }).limit(100);
    // PHASE W. Every response below goes through the public projection in
    // services/publicProjection.js. `res.json(doc)` on a raw Mongoose document
    // publishes whatever the model happens to hold today, so each field a later
    // phase adds joins the public response with no change at this boundary —
    // which is exactly how the pipeline's retry flags and provider error
    // messages came to be readable without an Authorization header.
    res.json(toPublicSchemes(schemes));
  })
);

// GET /api/schemes/:schemeId
router.get(
  "/schemes/:schemeId",
  asyncHandler(async (req, res) => {
    const scheme = await Scheme.findOne({ schemeId: req.params.schemeId });
    if (!scheme) return res.status(404).json({ error: "Scheme not found" });
    res.json(toPublicScheme(scheme));
  })
);

// GET /api/schemes/:schemeId/history  -> the version timeline for one scheme
router.get(
  "/schemes/:schemeId/history",
  asyncHandler(async (req, res) => {
    const history = await SchemeHistory.find({ schemeId: req.params.schemeId }).sort({ version: 1 });
    res.json(toPublicHistory(history));
  })
);

// GET /api/updates/recent -> latest changes across all schemes, for an activity feed
router.get(
  "/updates/recent",
  asyncHandler(async (req, res) => {
    const limit = Math.min(parseInt(req.query.limit, 10) || 20, 100);
    const updates = await SchemeHistory.find({}).sort({ createdAt: -1 }).limit(limit);
    res.json(toPublicHistory(updates));
  })
);

/**
 * POST /api/collect/run — trigger a collection cycle on demand.
 *
 * ADMIN ONLY, and heavily rate-limited (PROJECT_AUDIT S-4). Unauthenticated,
 * this was the single most abusable endpoint in the system: each call fans out
 * to ~4,700 schemes x 2 follow-up requests against the myScheme API and can
 * trigger thousands of LLM calls. An anonymous attacker could exhaust the
 * upstream quota, the LLM budget and the Atlas connection pool with a loop.
 */
const collectLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: Number(process.env.COLLECT_RATE_LIMIT_MAX) || 2,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Collection can only be triggered a couple of times per hour" },
});

router.post(
  "/collect/run",
  requireAuth,
  requireAdmin,
  collectLimiter,
  asyncHandler(async (req, res) => {
    const summary = await runCollectionCycle();
    res.json({ ok: true, summary });
  })
);

module.exports = router;