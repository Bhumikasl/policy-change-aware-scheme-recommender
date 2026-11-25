const express = require("express");
const User = require("../models/User");
const asyncHandler = require("../middleware/asyncHandler");
const { requireAuth, requireSelfOrAdmin } = require("../middleware/auth");
const { badRequest, notFound } = require("../middleware/errorHandler");
const { listUserHistory } = require("../services/recommendationHistoryService");
const {
  listUserNotifications,
  markRead,
  markAllRead,
} = require("../services/notificationReadService");

const router = express.Router();

/**
 * AUTHORIZATION NOTE (PROJECT_AUDIT S-4)
 *
 * Every `/users/:email/...` route is now `requireAuth` + `requireSelfOrAdmin`.
 * Previously they were public, so guessing an email returned that person's
 * caste categories, income, age and education — an IDOR over data that is
 * sensitive under India's DPDP Act. A USER may now read only their own
 * record; an ADMIN may read any.
 */
const ownData = [requireAuth, requireSelfOrAdmin("email")];

/**
 * PUT /api/users/me — update the caller's own profile.
 *
 * Replaces the old anonymous upsert-by-email POST, which let anyone overwrite
 * anyone else's profile (and echoed the saved document straight back).
 * Account creation now lives in POST /api/auth/register.
 */
router.put(
  "/users/me",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { name, profile, notificationPrefs } = req.body || {};
    const user = await User.findById(req.user.sub);
    if (!user) throw notFound("User not found");

    if (typeof name === "string") user.name = name;
    if (profile && typeof profile === "object") {
      // Assign field-by-field so a caller cannot inject arbitrary keys, and
      // cannot reach `role` or `passwordHash` through a nested spread.
      const allowed = [
        "state", "gender", "age", "occupation", "annualIncome",
        "categories", "education", "course", "marksPercentage",
        "disability", "disabilityPercentage", "singleGirlChild",
        "idLast4", "documentsAvailable",
      ];
      for (const k of allowed) {
        if (profile[k] !== undefined) user.profile[k] = profile[k];
      }
    }
    if (notificationPrefs && typeof notificationPrefs === "object") {
      if (typeof notificationPrefs.email === "boolean") {
        user.notificationPrefs.email = notificationPrefs.email;
      }
      if (["LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(notificationPrefs.minSeverity)) {
        user.notificationPrefs.minSeverity = notificationPrefs.minSeverity;
      }
    }
    await user.save();
    res.json(user.toSafeJSON());
  })
);

/**
 * GET /api/users/me/recommendation-history
 *
 * The read side of the Phase J audit trail. Until now those rows were written
 * and unreadable, so a user could be told "you are eligible" but never "you
 * became eligible on 12 March because the income ceiling rose".
 *
 * Own data only. The user id comes from the verified token (`req.user.sub`),
 * never from a path or query parameter, so there is no identifier for a caller
 * to tamper with — this route cannot be turned into an IDOR the way the old
 * `/users/:email/*` routes could.
 *
 * Query: ?page= &limit= (max 100) &schemeId= &eligibilityTransition=
 *        &recommendationTransition= &since=<ISO date>
 *
 * MUST be declared before `/users/:email`, or Express matches that first and
 * treats the literal string "me" as an email address.
 */
router.get(
  "/users/me/recommendation-history",
  requireAuth,
  asyncHandler(async (req, res) => {
    const result = await listUserHistory({ userId: req.user.sub, query: req.query });
    res.json(result);
  })
);

/**
 * GET /api/users/me/notifications
 *
 * The in-app inbox. Own data only — the user id comes from the verified token,
 * so there is no identifier a caller could tamper with.
 *
 * Query: ?page= &limit= (max 100) &type= &unread=true &schemeId=
 */
router.get(
  "/users/me/notifications",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await listUserNotifications({ userId: req.user.sub, query: req.query }));
  })
);

/**
 * POST /api/users/me/notifications/:id/read
 *
 * The update is filtered by id AND the caller's own userId together, so
 * another user's id simply matches nothing. 404 rather than 403 is correct
 * here: confirming that an id exists but belongs to someone else would leak
 * the existence of their notification.
 */
router.post(
  "/users/me/notifications/:id/read",
  requireAuth,
  asyncHandler(async (req, res) => {
    const { updated } = await markRead({
      userId: req.user.sub,
      notificationId: req.params.id,
    });
    if (!updated) throw notFound("Notification not found");
    res.json({ ok: true });
  })
);

/** POST /api/users/me/notifications/read-all */
router.post(
  "/users/me/notifications/read-all",
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await markAllRead({ userId: req.user.sub }));
  })
);

router.get(
  "/users/:email",
  ownData,
  asyncHandler(async (req, res) => {
    const user = await User.findOne({ email: String(req.params.email).toLowerCase() });
    if (!user) throw notFound("User not found");
    res.json(user.toSafeJSON());
  })
);

// GET /api/users/:email/matches -> ranked scheme RECOMMENDATIONS.
//
// FOUR-STAGE PIPELINE. The key insight: eligibility, relevance and
// verification are three different questions and must be separate stages.
//
//   ~4,700 Active schemes
//         ↓
//   [1] ELIGIBILITY GATE  (services/matcher.js)
//       "CAN this person apply?" — strict deterministic rules with
//       AND-of-OR categories. Authoritative: nothing downstream can
//       promote a scheme this stage rejected. Yields maybe 100-600
//       eligible candidates for a broad profile.
//         ↓
//   [2] RELEVANCE RANKING  (services/relevanceRanker.js)
//       "Which of these is most USEFUL to this person?" — BM25-lite
//       lexical overlap between the user's (expanded) profile vocabulary
//       and the scheme text, plus targeting specificity, benefit
//       concreteness, document readiness and deadline urgency. No LLM:
//       ranking hundreds of schemes with a model is the anti-pattern.
//         ↓
//   [3] TRUNCATE to `limit` (default 20)
//       This is what fixes "157 results". maxVerify caps LLM CALLS;
//       `limit` caps what is RETURNED. Previously everything past the
//       verify cap was still returned as rules-only.
//         ↓
//   [4] LLM VERIFICATION of the surviving top-K
//       Reads the chunked scheme document against the full profile and
//       can only CONFIRM, VETO, or flag missingInformation.
//         ↓
//   Top 5-20 recommendations
//
// Query flags:
//   ?limit=N          — how many recommendations to RETURN (default 20,
//                        max 100). Use limit=0 for "everything eligible"
//                        (the old behaviour, for admin/debug).
//   ?intent=text      — free-text "what are you looking for", e.g.
//                        "scholarships for B.Tech". Terms are weighted 2x
//                        in ranking, so the results follow the stated ask.
//   ?verify=false     — skip stage 4 entirely (fastest, zero LLM cost)
//   ?maxVerify=N      — cap LLM calls (default: min(limit, 20))
//   ?includeUnknown=true — include unparsed-eligibility schemes (admin)
//   ?showVetoed=true  — also return what the verifier rejected (debug)
//   ?explain=true     — include the per-signal relevance breakdown
router.get("/users/:email/matches", ...ownData, asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: String(req.params.email).toLowerCase() });
  if (!user) throw notFound("User not found");

  const { verifyEligibility, decideRecommendation } = require("../services/schemeVerifier");
  const { rankCandidates } = require("../services/relevanceRanker");
  const { buildCandidates } = require("../services/recommendationPropagation");
  const Scheme = require("../models/Scheme");

  const includeUnknown = req.query.includeUnknown === "true";
  const wantVerify = req.query.verify === "false"
    ? false
    : (req.query.verify === "true" || process.env.SCHEME_VERIFIER_ENABLED !== "false");

  // limit=0 means "no truncation" (admin / debug view of the full
  // eligible set). Anything else is clamped to a sane page size.
  const rawLimit = req.query.limit === undefined
    ? Number(process.env.DEFAULT_MATCH_LIMIT) || 20
    : parseInt(req.query.limit, 10);
  const limit = Number.isNaN(rawLimit) ? 20 : Math.max(0, Math.min(100, rawLimit));

  const intent = typeof req.query.intent === "string" ? req.query.intent.slice(0, 300) : "";
  const explain = req.query.explain === "true";

  // PHASE X. `status: "Active"` was an exact, case-sensitive equality filter,
  // while every other ranking surface gates on
  // `recommendationPropagation.isActive`, which also accepts "active" and a
  // blank status. A third copy of one rule — the file exporting `isActive`
  // says in as many words that two copies would drift.
  //
  // The database filter is now a cheap, indexed SUPERSET (the same
  // `$ne: "Closed"` prefilter `GET /api/schemes` already uses) and the shared
  // gate decides. Keeping the query broad rather than exact is what makes the
  // JS gate authoritative instead of decorative.
  const query = { status: { $ne: "Closed" } };
  if (!includeUnknown) {
    query["eligibilityRules.eligibilityType"] = { $in: ["universal", "constrained"] };
  }
  const schemes = await Scheme.find(query).sort({ lastUpdatedAt: -1 });

  // ---- STAGE 1: eligibility gate ----
  // One assembly, shared with the chat assistant and the propagation pass.
  const eligible = buildCandidates(user, schemes, { allowUnknown: includeUnknown });

  const eligibleCount = eligible.length;

  // ---- STAGE 2: relevance ranking ----
  const ranked = rankCandidates(eligible, user, { intent });

  // ---- STAGE 3: truncate to what we'll actually recommend ----
  // We take a slightly wider slice than `limit` so the verifier has room
  // to veto a few without leaving the user short of results.
  const overscan = limit === 0 ? ranked.length : Math.min(ranked.length, Math.ceil(limit * 1.5));
  const shortlist = ranked.slice(0, overscan);

  // ---- STAGE 4: LLM verification of the shortlist ----
  const maxVerify = req.query.maxVerify !== undefined
    ? Math.max(0, Math.min(100, parseInt(req.query.maxVerify, 10) || 0))
    : Math.min(shortlist.length, limit === 0 ? 20 : Math.min(limit, 20));

  let verifiedCount = 0;
  const decided = [];
  for (const cand of shortlist) {
    let verifierResult = null;
    if (wantVerify && verifiedCount < maxVerify) {
      try {
        verifierResult = await verifyEligibility(user, cand.scheme);
      } catch (err) {
        // verifyEligibility catches network errors internally and returns
        // null; anything thrown out here is a real bug — log and fall
        // back to the rules verdict for this scheme.
        console.warn(`verifier threw on ${cand.scheme.schemeId}: ${err.message}`);
      }
      if (verifierResult) verifiedCount += 1;
    }
    const decision = decideRecommendation(cand.verdict, verifierResult);
    decided.push({ ...cand, verifierResult, decision });
  }

  // Build the response. By default we OMIT the verifier-vetoed ones so
  // the user only sees schemes both stages agree on. Callers can pass
  // ?showVetoed=true to inspect what the verifier caught.
  const showVetoed = req.query.showVetoed === "true";
  const surviving = decided.filter(
    (d) => d.decision.recommend || (showVetoed && d.decision.stage === "verifier-veto")
  );

  // Final truncation AFTER verification, so vetoed schemes don't eat a slot.
  const finalList = limit === 0 ? surviving : surviving.slice(0, limit);

  const results = finalList.map(
    ({ scheme, verdict, verifierResult, decision, relevance, relevanceBreakdown, documentReadiness }) => {
      const obj = scheme.toObject();
      obj.documentReadiness = documentReadiness;
      obj.matchExplanation = {
        stage: decision.stage,
        mode: verdict.mode,
        eligibilityType: verdict.eligibilityType,
        // `score` is the ELIGIBILITY score (how many rules were verified).
        // `relevance` is the RECOMMENDATION score (how useful to this user).
        // They answer different questions — see relevanceRanker.js.
        score: verdict.score,
        relevance,
        ...(explain ? { relevanceBreakdown } : {}),
        matched: verdict.matched,
        needsReview: scheme.eligibilityRules?.needsReview || false,
        ruleConfidence: scheme.eligibilityRules?.confidence ?? 0,
        needsMoreInfo: !!decision.needsMoreInfo,
        recommend: decision.recommend,
        disagreement: !!decision.disagreement,
        verifier: verifierResult
          ? {
              verified: verifierResult.verified,
              confidence: verifierResult.confidence,
              matchedCriteria: verifierResult.matchedCriteria,
              failedCriteria: verifierResult.failedCriteria,
              missingInformation: verifierResult.missingInformation,
              reasoning: verifierResult.reasoning,
              cached: !!verifierResult.cached,
            }
          : null,
      };
      return obj;
    }
  );

  // Funnel metadata so the client (and you) can see how the number was
  // reached at every stage — this is what makes "why 20 and not 157"
  // answerable without reading the code.
  res.set("X-Eligible-Count", String(eligibleCount));
  res.set("X-Returned-Count", String(results.length));
  res.set("X-Verified-Count", String(verifiedCount));

  // Back-compat: the response body stays a bare array (the frontend maps
  // over it directly). Set ?meta=true for the envelope with funnel counts.
  if (req.query.meta === "true") {
    return res.json({
      funnel: {
        totalActive: schemes.length,
        eligible: eligibleCount,
        shortlisted: shortlist.length,
        llmVerified: verifiedCount,
        vetoed: decided.filter((d) => d.decision.stage === "verifier-veto").length,
        returned: results.length,
      },
      intent: intent || null,
      results,
    });
  }
  res.json(results);
}));

// GET /api/users/:email/matches/stats -> quick diagnostic on why the
// matches count is what it is. Helps you (and the user) see how many
// schemes were even considered.
router.get("/users/:email/matches/stats", ...ownData, asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: String(req.params.email).toLowerCase() });
  if (!user) throw notFound("User not found");
  const Scheme = require("../models/Scheme");
  // PHASE X. This endpoint exists to explain why the matches count is what it
  // is, so it has to count the same universe /matches ranks. It used
  // `status: "Active"` exactly while that route now prefilters on
  // `$ne: "Closed"` and defers to the shared `isActive` gate — so a scheme with
  // a lowercase or blank status was recommended and simultaneously reported as
  // not active. A diagnostic that disagrees with the thing it diagnoses is
  // worse than no diagnostic.
  const ACTIVE = { status: { $ne: "Closed" } };
  const [total, active, structured, llm, deterministic, unparsed, universal, constrained, unknown, needsReview] = await Promise.all([
    Scheme.countDocuments(),
    Scheme.countDocuments(ACTIVE),
    Scheme.countDocuments({ ...ACTIVE, "eligibilityRules.source": "structured" }),
    Scheme.countDocuments({ ...ACTIVE, "eligibilityRules.source": "llm-extracted" }),
    Scheme.countDocuments({ ...ACTIVE, "eligibilityRules.source": "deterministic" }),
    Scheme.countDocuments({ ...ACTIVE, "eligibilityRules.source": "unparsed" }),
    Scheme.countDocuments({ ...ACTIVE, "eligibilityRules.eligibilityType": "universal" }),
    Scheme.countDocuments({ ...ACTIVE, "eligibilityRules.eligibilityType": "constrained" }),
    Scheme.countDocuments({ ...ACTIVE, "eligibilityRules.eligibilityType": "unknown" }),
    Scheme.countDocuments({ ...ACTIVE, "eligibilityRules.needsReview": true }),
  ]);
  res.json({
    total, active,
    bySource: { structured, llm, deterministic, unparsed },
    byEligibilityType: { universal, constrained, unknown },
    needsReview,
  });
}));

// GET /api/users/:email/why/:schemeId
// Explains eligibility for one specific scheme: matched rules, failed
// rules, and why the score is what it is. Handy for the "why did I get
// (or not get) this scheme?" audit view.
router.get("/users/:email/why/:schemeId", ...ownData, asyncHandler(async (req, res) => {
  const user = await User.findOne({ email: String(req.params.email).toLowerCase() });
  if (!user) throw notFound("User not found");

  const { evaluateEligibility } = require("../services/notifier");
  const Scheme = require("../models/Scheme");
  const scheme = await Scheme.findOne({ schemeId: req.params.schemeId });
  if (!scheme) throw notFound("Scheme not found");

  const verdict = evaluateEligibility(user, scheme);

  // Also run the LLM verifier on this one scheme when possible — the
  // /why view is exactly the place where a person wants to see the
  // full second-opinion, not just the rules verdict.
  let verifier = null;
  if (req.query.verify !== "false") {
    const { verifyEligibility } = require("../services/schemeVerifier");
    try {
      verifier = await verifyEligibility(user, scheme);
    } catch (err) { verifier = null; }
  }

  res.json({
    schemeId: scheme.schemeId,
    schemeName: scheme.name,
    ruleSource: scheme.eligibilityRules?.source || "unparsed",
    ruleConfidence: scheme.eligibilityRules?.confidence ?? 0,
    ...verdict,
    verifier,
  });
}));

module.exports = router;