/**
 * ELIGIBILITY UPDATES ROUTE — additive new endpoint.
 *
 * GET /api/users/me/eligibility-updates
 *
 * Returns schemes for which the current user has become newly eligible
 * (or whose eligibility rules updated while the user remains eligible)
 * due to a scheme version change.
 *
 * This route is ADDITIVE and does not modify any existing route behaviour.
 * It sits beside, not inside, the existing /users/:email/matches route.
 *
 * Authorization: requireAuth — the user id comes from the verified JWT,
 * never from a query parameter. No other user's data can be reached.
 *
 * Query parameters:
 *   ?limit=N                      — max results per bucket (default 10, max 50)
 *   ?includeEligibilityUpdated=true — also return schemes where rules changed
 *                                    but user was already eligible
 */

const express = require("express");
const asyncHandler = require("../middleware/asyncHandler");
const { requireAuth } = require("../middleware/auth");
const User = require("../models/User");
const { notFound } = require("../middleware/errorHandler");
const { getNewlyEligibleForUser } = require("../services/eligibilityUpdateService");

const router = express.Router();

router.get(
  "/users/me/eligibility-updates",
  requireAuth,
  asyncHandler(async (req, res) => {
    // The user id comes from the verified token — the caller cannot substitute
    // another user's id by sending a different query parameter.
    const user = await User.findById(req.user.sub);
    if (!user) throw notFound("User not found");

    const rawLimit = parseInt(req.query.limit, 10);
    const limit = Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.min(rawLimit, 50)
      : 10;

    const includeEligibilityUpdated =
      req.query.includeEligibilityUpdated === "true";

    const result = await getNewlyEligibleForUser({ user, limit });

    res.json({
      newlyEligible: result.newlyEligible,
      eligibilityUpdated: includeEligibilityUpdated ? result.eligibilityUpdated : [],
      total: result.newlyEligible.length +
        (includeEligibilityUpdated ? result.eligibilityUpdated.length : 0),
      checkedAt: result.checkedAt,
      totalUpdatesChecked: result.totalChecked,
      lookbackDays: Number(process.env.ELIGIBILITY_UPDATE_LOOKBACK_DAYS) || 30,
      ...(result.error ? { warning: result.error } : {}),
    });
  })
);

module.exports = router;
