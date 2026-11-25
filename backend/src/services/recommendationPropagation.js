const RecommendationHistoryModel = require("../models/RecommendationHistory");
const SchemeModel = require("../models/Scheme");
const UserModel = require("../models/User");
const { evaluateEligibility, getDocumentReadiness } = require("./matcher");
const { rankCandidates } = require("./relevanceRanker");
const { TRANSITIONS } = require("../agents/policyImpactAgent");
const { explainTransition } = require("../agents/explanationAgent");
const logger = require("../utils/logger");

// From the shared vocabulary, NOT from the model. Reading them off the model
// meant substituting the model layer (as any integration test must) silently
// made them undefined, and propagation then threw from Object.values() with an
// error that named nothing useful.
const {
  ELIGIBILITY_TRANSITIONS,
  RECOMMENDATION_TRANSITIONS,
  RECOMMENDATION_STATUS,
} = require("../constants/recommendationTransitions");

/**
 * RECOMMENDATION PROPAGATION — Phase J.
 *
 * Turns "this scheme changed and these users are affected" into "this user's
 * recommendation list changed in this specific way, and here is the row that
 * proves it".
 *
 * ---------------------------------------------------------------------------
 * WHY THIS IS NOT JUST "RE-CHECK ELIGIBILITY"
 * ---------------------------------------------------------------------------
 * Eligibility is a property of one user and one scheme. A recommendation is a
 * property of one user and the WHOLE SCHEME UNIVERSE, because it carries a
 * position in a list. Those come apart in both directions:
 *
 *   - A user can become newly eligible for a scheme that still does not make
 *     their top K, because ten other schemes are more relevant to them. Telling
 *     them "you have a new recommendation" would be wrong; nothing they see
 *     changed.
 *
 *   - A user's eligibility can be untouched while the scheme moves from rank 3
 *     to rank 9 — because the change made it less relevant (a benefit was cut),
 *     not because they stopped qualifying. That IS a recommendation change and
 *     an eligibility check alone would miss it entirely.
 *
 * So this service compares recommendation STATE, not eligibility. For each
 * affected user it reconstructs their ranked list twice — once against the
 * scheme universe as it was, once as it is — and diffs the two.
 *
 * ---------------------------------------------------------------------------
 * THE COST, STATED HONESTLY
 * ---------------------------------------------------------------------------
 * Rank is inherently relative, so producing a previousRank means ranking that
 * user against every scheme they are eligible for. There is no shortcut: a
 * position in a list cannot be derived from one scheme in isolation.
 *
 * What this service does NOT do is re-rank every user. It ranks only the users
 * the Policy Impact Agent identified, which is the whole point of Phase I. The
 * scheme universe is loaded once per run, not once per user.
 *
 * Complexity is O(affectedUsers x schemes), against O(allUsers x schemes) for a
 * naive rebuild.
 */

const DEFAULT_TOP_K = Number(process.env.RECOMMENDATION_TOP_K) || 10;

const isActive = (status) => {
  const s = String(status ?? "active").toLowerCase();
  return s === "active" || s === "";
};

/** Mongoose doc or plain object, indifferently. */
const toPlain = (d) => (d && typeof d.toObject === "function" ? d.toObject() : d || {});

/**
 * Compute one user's ranked recommendation list over a given scheme universe.
 *
 * Deliberately reuses matcher.evaluateEligibility and relevanceRanker
 * .rankCandidates — the SAME functions the live /recommendations endpoint uses.
 * A second implementation here would drift, and a drifted copy produces history
 * rows describing a list the user was never shown.
 *
 * @returns {{ranked: Array, byScheme: Map<string, {rank:number, relevance:number}>}}
 */
/**
 * PHASE X — THE ONE PLACE A RECOMMENDATION CANDIDATE IS BUILT.
 *
 * Three surfaces rank a user's recommendations: `GET /users/:email/matches`,
 * the chat assistant, and this propagation pass. Each used to assemble its own
 * candidate list, and the comments in two of them said the shapes had to match
 * — which is a hope, not a mechanism. They did not match: this function omitted
 * `documentReadiness`, so `relevanceRanker`'s readiness term (0 .. 1.5) was
 * silently zeroed here and only here. The audit trail and the rank-change
 * notifications were computed from a different ordering than the page and the
 * assistant showed.
 *
 * `chatService` carries a comment recording the same bug being found and fixed
 * *there*: "Omitting it silently zeroed that term and produced a different
 * ordering from the live endpoint." Fixing one copy is what left the other two
 * to drift, so the assembly now lives here once and every surface calls it.
 *
 * Returns `{scheme, verdict, documentReadiness}`, the shape `rankCandidates`
 * documents. `scheme` is passed through exactly as supplied — a Mongoose
 * document stays a document — because `GET /matches` calls `.toObject()` on it
 * afterwards.
 */
function buildCandidates(user, universe, { allowUnknown = false } = {}) {
  const candidates = [];
  for (const scheme of universe || []) {
    // A closed scheme is not recommendable regardless of what the rules say.
    // matcher.js does not look at status, so this layer must.
    if (!isActive(scheme.status)) continue;
    // Enforce strict mode ALWAYS unless allowUnknown is explicitly requested.
    // Relaxing strict mode silently passes constraints as no-constraints.
    const strictMode = allowUnknown ? false : true;
    const verdict = evaluateEligibility(user, scheme, { allowUnknown, strict: strictMode });
    
    // As per requirement:
    // ELIGIBLE → display
    // NEEDS_MORE_INFORMATION → do not display as an eligible match (unless allowUnknown is true)
    // NOT_ELIGIBLE → do not display
    if (verdict.status === "NOT_ELIGIBLE") continue;
    if (verdict.status === "NEEDS_MORE_INFORMATION" && !allowUnknown) continue;
    candidates.push({
      scheme,
      verdict,
      // The ranker's readiness term reads this. Its absence is not an error
      // anywhere — it just quietly scores 0, which is why this went unnoticed.
      documentReadiness: getDocumentReadiness(user, scheme),
    });
  }
  return candidates;
}

function computeRecommendationState(user, universe, { intent = "", topK = DEFAULT_TOP_K } = {}) {
  const eligible = buildCandidates(user, universe).map((c) => ({
    ...c,
    // History rows and transition classification compare plain snapshots.
    scheme: toPlain(c.scheme),
  }));

  const ranked = rankCandidates(eligible, user, { intent });
  const byScheme = new Map();
  ranked.forEach((c, i) => {
    byScheme.set(c.scheme.schemeId, {
      rank: i + 1, // 1-based: rank 1 is the top recommendation
      relevance: c.relevance,
      inTopK: topK > 0 ? i < topK : true,
    });
  });
  return { ranked, byScheme };
}

/** Four exhaustive eligibility transitions. */
function classifyEligibilityTransition(was, is) {
  if (!was && is) return ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE;
  if (was && !is) return ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_INELIGIBLE;
  if (was && is) return ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_ELIGIBLE;
  return ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_INELIGIBLE;
}

/**
 * How the user's recommendation moved.
 *
 * "Recommended" means "inside the top K of this user's eligible list", which is
 * what the user actually sees — not merely "eligible". A scheme at rank 40 of
 * 60 eligible schemes is not a recommendation in any useful sense.
 *
 * @param {{rank:number|null, inTopK:boolean}|null} before
 * @param {{rank:number|null, inTopK:boolean}|null} after
 */
function classifyRecommendationTransition(before, after) {
  const wasRec = !!before?.inTopK;
  const isRec = !!after?.inTopK;

  if (!wasRec && isRec) return RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED;
  if (wasRec && !isRec) return RECOMMENDATION_TRANSITIONS.RECOMMENDED_TO_NOT_RECOMMENDED;

  if (wasRec && isRec) {
    // Both in the top K: did the position move?
    //
    // Rank 1 is the best position, so a SMALLER number is a BETTER placement.
    // "RANK_INCREASED" therefore means the rank number went DOWN. Reading this
    // the other way round would report a demotion as a promotion.
    if (after.rank < before.rank) return RECOMMENDATION_TRANSITIONS.RANK_INCREASED;
    if (after.rank > before.rank) return RECOMMENDATION_TRANSITIONS.RANK_DECREASED;
  }
  return RECOMMENDATION_TRANSITIONS.NO_CHANGE;
}

const statusOf = (state) =>
  state?.inTopK ? RECOMMENDATION_STATUS.RECOMMENDED : RECOMMENDATION_STATUS.NOT_RECOMMENDED;

/**
 * A structured, grounded statement of cause.
 *
 * Every field here is copied from observed data — the diff, the matcher's own
 * rule verdicts. Nothing is generated. The Explanation Agent (Phase K) turns
 * this into a sentence; it does not get to invent the facts.
 */
function buildReason({ eligibilityTransition, recommendationTransition, impact, diffs, changeVerdict }) {
  const changedFields = (diffs || []).map((d) => ({
    field: d.field,
    oldValue: d.oldValue,
    newValue: d.newValue,
  }));

  let code = "UNKNOWN";
  let summary = "";

  if (eligibilityTransition === ELIGIBILITY_TRANSITIONS.INELIGIBLE_TO_ELIGIBLE) {
    code = "BECAME_ELIGIBLE";
    summary = `Now eligible: ${(impact.rulesNowPassing || []).join(", ") || "eligibility rules changed"}`;
  } else if (eligibilityTransition === ELIGIBILITY_TRANSITIONS.ELIGIBLE_TO_INELIGIBLE) {
    code = "LOST_ELIGIBILITY";
    summary = `No longer eligible: ${(impact.rulesNowFailing || []).join(", ") || "eligibility rules changed"}`;
  } else if (recommendationTransition === RECOMMENDATION_TRANSITIONS.NOT_RECOMMENDED_TO_RECOMMENDED) {
    code = "ENTERED_TOP_K";
    summary = "Entered your top recommendations";
  } else if (recommendationTransition === RECOMMENDATION_TRANSITIONS.RECOMMENDED_TO_NOT_RECOMMENDED) {
    code = "LEFT_TOP_K";
    summary = "Left your top recommendations";
  } else if (recommendationTransition === RECOMMENDATION_TRANSITIONS.RANK_INCREASED) {
    code = "RANK_IMPROVED";
    summary = "Moved up in your recommendations";
  } else if (recommendationTransition === RECOMMENDATION_TRANSITIONS.RANK_DECREASED) {
    code = "RANK_WORSENED";
    summary = "Moved down in your recommendations";
  } else if (changeVerdict?.deadlineImpact) {
    // Still eligible, same position, but a term of the scheme moved. Deadline
    // first: it is the one that can expire on the user.
    code = "DEADLINE_CHANGED";
    summary = "The application deadline for a scheme you qualify for changed";
  } else if (changeVerdict?.benefitImpact) {
    code = "BENEFIT_CHANGED";
    summary = "The benefit of a scheme you qualify for changed";
  } else if (changeVerdict?.documentImpact) {
    code = "DOCUMENTS_CHANGED";
    summary = "The documents required for a scheme you qualify for changed";
  }

  return {
    code,
    summary,
    changedFields,
    rulesNowPassing: impact.rulesNowPassing || [],
    rulesNowFailing: impact.rulesNowFailing || [],
  };
}

/**
 * Propagate one policy change into affected users' recommendations.
 *
 * @param {Object}   opts
 * @param {Object}   opts.scheme         the scheme AFTER the change
 * @param {Object}   opts.oldSnapshot    the full normalized scheme BEFORE (SchemeHistory.snapshot)
 * @param {boolean}  [opts.isNew]        true when the scheme did not exist before
 * @param {Array}    opts.diffs          comparator output
 * @param {Object}   opts.changeVerdict  policyChangeAgent output
 * @param {Object}   opts.impact         policyImpactAgent output
 * @param {string}   opts.triggeringChangeId  idempotency key (SchemeHistory _id)
 * @param {string}   [opts.processingJobId]
 * @param {string}   [opts.eventId]
 * @param {number}   [opts.topK]
 * @param {string}   [opts.intent]       stated user intent, if the caller has one
 * @param {Object}   [opts.deps]         injectable models/emitter for tests
 */
async function propagateChange({
  scheme,
  oldSnapshot = null,
  isNew = false,
  diffs = [],
  changeVerdict = null,
  impact,
  triggeringChangeId,
  processingJobId = "",
  eventId = "",
  topK = DEFAULT_TOP_K,
  intent = "",
  deps = {},
} = {}) {
  const started = Date.now();
  const {
    historyModel = RecommendationHistoryModel,
    schemeModel = SchemeModel,
    userModel = UserModel,
    emitEvent = null,
    explain = process.env.EXPLANATIONS === "false" ? null : explainTransition,
  } = deps;

  const result = {
    schemeId: scheme?.schemeId,
    triggeringChangeId,
    processingJobId,
    usersConsidered: 0,
    recordsWritten: 0,
    duplicatesSkipped: 0,
    // Tracked apart from `errors` on purpose: a missing explanation is not a
    // failed propagation.
    explanationsWritten: 0,
    explanationsFailed: 0,
    errors: [],
    transitions: emptyTransitionCounts(),
    records: [],
    events: [],
    durationMs: 0,
  };

  if (!triggeringChangeId) {
    throw new Error("propagateChange requires a triggeringChangeId — it is the idempotency key");
  }

  const affected = impact?.impacts || [];
  if (affected.length === 0) {
    // The Impact Agent found nobody. That is a complete answer, not a failure,
    // and it must cost nothing downstream.
    result.durationMs = Date.now() - started;
    logger.info("Propagation: no affected users", { schemeId: result.schemeId, triggeringChangeId });
    return result;
  }

  // ---- build the two scheme universes, ONCE for the whole run --------------
  // A rank is a position among all of a user's eligible schemes, so both
  // universes are needed in full. Loading them per user would be the same work
  // multiplied by the number of affected users.
  let universeAfter;
  try {
    universeAfter = (await schemeModel.find({}).lean()).map(toPlain);
  } catch (err) {
    // Without the universe there is no rank to compute, so this is fatal for
    // the run — but it is reported, not swallowed.
    logger.error("Propagation: could not load scheme universe", { error: err.message });
    result.errors.push({ stage: "loadSchemes", error: err.message });
    result.durationMs = Date.now() - started;
    return result;
  }

  const changedId = scheme?.schemeId;
  // The "before" universe is identical except for the changed scheme. Every
  // OTHER scheme is untouched, which is what makes the two rankings comparable.
  //
  // A brand-new scheme needs the stronger treatment: it must be ABSENT from the
  // before-universe, not merely older. Leaving it in — which is what happens if
  // you only swap in an oldSnapshot that does not exist — makes the user look
  // like they were always eligible for a scheme that did not exist yesterday,
  // and no new scheme could ever produce a NOT_RECOMMENDED_TO_RECOMMENDED row.
  //
  // Gated on the explicit isNew flag rather than on `oldSnapshot == null`: a
  // missing snapshot can also mean a history row we failed to read, and
  // dropping the scheme in that case would manufacture a phantom transition.
  const universeBefore = isNew
    ? universeAfter.filter((s) => s.schemeId !== changedId)
    : universeAfter.map((s) =>
        s.schemeId === changedId && oldSnapshot ? { ...toPlain(oldSnapshot), schemeId: changedId } : s
      );

  for (const item of affected) {
    result.usersConsidered++;
    try {
      // The impact list carries ids; load the full profile for ranking.
      // Accept either a Mongoose Query (chain .lean()) or a plain promise, so
      // the service does not depend on which shape the model returns.
      const user = item.user || (await resolveUser(userModel, item.userId));
      if (!user) {
        result.errors.push({ stage: "loadUser", userId: String(item.userId), error: "user not found" });
        continue;
      }

      const before = computeRecommendationState(user, universeBefore, { intent, topK });
      const after = computeRecommendationState(user, universeAfter, { intent, topK });

      const b = before.byScheme.get(changedId) || null;
      const a = after.byScheme.get(changedId) || null;

      const previousEligibility = !!b;
      const newEligibility = !!a;
      const eligibilityTransition = classifyEligibilityTransition(previousEligibility, newEligibility);
      const recommendationTransition = classifyRecommendationTransition(b, a);

      // ---- should this user get a row at all? --------------------------
      //
      // Two things can justify one, and they are not the same thing:
      //
      //   (a) The recommendation MOVED — gained, lost, or changed position.
      //
      //   (b) The user stayed eligible and stayed put, but what they GET
      //       changed: the benefit, the deadline, or the documents they must
      //       produce. Their list looks identical, yet a scheme they hold is
      //       now materially different. Dropping this would leave a gap in the
      //       audit trail exactly where "the deadline moved up" belongs.
      //
      // Anything else is a non-event. A history table that records non-events
      // is not an audit trail, it is noise, and every row here is a candidate
      // notification later.
      const recommendationMoved =
        recommendationTransition !== RECOMMENDATION_TRANSITIONS.NO_CHANGE;
      const materialToHolder =
        newEligibility &&
        !!changeVerdict &&
        (changeVerdict.benefitImpact ||
          changeVerdict.deadlineImpact ||
          changeVerdict.documentImpact);

      if (!recommendationMoved && !materialToHolder) {
        result.transitions.NO_MOVEMENT++;
        continue;
      }

      const doc = {
        userId: item.userId,
        userEmail: item.email || user.email || "",
        schemeId: changedId,
        schemeName: scheme?.name || "",
        triggeringChangeId,
        processingJobId,
        eventId,
        previousSchemeVersion: oldSnapshot?.version ?? (scheme?.version != null ? scheme.version - 1 : null),
        newSchemeVersion: scheme?.version ?? null,
        previousEligibility,
        newEligibility,
        eligibilityTransition,
        previousRecommendationStatus: statusOf(b),
        newRecommendationStatus: statusOf(a),
        recommendationTransition,
        previousRank: b?.rank ?? null,
        newRank: a?.rank ?? null,
        previousRelevance: b?.relevance ?? null,
        newRelevance: a?.relevance ?? null,
        topK,
        reason: buildReason({
          eligibilityTransition,
          recommendationTransition,
          impact: item,
          diffs,
          changeVerdict,
        }),
        affectedAttributes: changeVerdict?.affectedAttributes || item.affectedAttributes || [],
        changeType: changeVerdict?.changeType || "",
        severity: changeVerdict?.severity || item.severity || "",
        // Always present, so a row written with explanations disabled has the
        // same shape as one written with them on. The read API turns "" into
        // null, which is how the UI distinguishes "none" from "blank".
        explanation: "",
        explanationMeta: null,
        createdAt: new Date(),
      };

      // ---- PHASE K: explain the transition, before the row is written ----
      // Attached to the document rather than patched in afterwards, so a row
      // never exists in a half-explained state. Failure here is non-fatal:
      // the audit trail is the guarantee, the sentence is the courtesy.
      if (explain) {
        try {
          const explanation = await explain({
            record: doc,
            profile: user.profile || {},
            scheme,
          });
          if (explanation?.sufficientEvidence) {
            result.explanationsWritten++;
            doc.explanation = explanation.summary;
            doc.explanationMeta = {
              method: explanation.method,
              confidence: explanation.confidence,
              groundingSources: explanation.groundingSources,
              changedConditions: explanation.changedConditions,
              userRelevantFactors: explanation.userRelevantFactors,
            };
          } else {
            // Explicitly absent, not blank: the read API returns null and the
            // UI says no explanation is available.
            doc.explanation = "";
          }
        } catch (err) {
          // NOT result.errors. Anything pushed there marks the whole
          // propagation FAILED and retryable — but the audit row is correct
          // and already written; only the sentence is missing. Failing the
          // propagation would make a cosmetic outage look like data loss and
          // send the retry sweep re-running work that succeeded.
          result.explanationsFailed++;
          doc.explanation = "";
          logger.warn("Propagation: explanation failed, row kept without one", {
            userId: String(item.userId),
            schemeId: changedId,
            error: err.message,
          });
        }
      }

      const written = await writeOnce(historyModel, doc, result);
      if (!written) continue;

      result.recordsWritten++;
      result.transitions[eligibilityTransition] = (result.transitions[eligibilityTransition] || 0) + 1;
      result.transitions[recommendationTransition] =
        (result.transitions[recommendationTransition] || 0) + 1;
      result.records.push(doc);

      // Phase K/L consume this. Emitting is injectable and defaults to a no-op:
      // Phase J is the audit trail, and no notification is sent from here.
      const event = {
        type: "RecommendationChanged",
        userId: item.userId,
        schemeId: changedId,
        triggeringChangeId,
        processingJobId,
        eligibilityTransition,
        recommendationTransition,
        severity: doc.severity,
        createdAt: doc.createdAt,
      };
      result.events.push(event);
      if (typeof emitEvent === "function") {
        try {
          await emitEvent(event);
        } catch (err) {
          // A downstream consumer failing must not roll back an audit row that
          // is already correct and already written.
          result.errors.push({ stage: "emitEvent", userId: String(item.userId), error: err.message });
        }
      }
    } catch (err) {
      // One user's failure must not abandon the rest of the affected set.
      logger.warn("Propagation: user failed", { userId: String(item.userId), error: err.message });
      result.errors.push({ stage: "propagateUser", userId: String(item.userId), error: err.message });
    }
  }

  result.durationMs = Date.now() - started;
  logger.info("Propagation: complete", {
    schemeId: result.schemeId,
    triggeringChangeId,
    usersConsidered: result.usersConsidered,
    recordsWritten: result.recordsWritten,
    duplicatesSkipped: result.duplicatesSkipped,
    errors: result.errors.length,
  });
  return result;
}

/**
 * Write one history row, at most once per (user, scheme, change).
 *
 * Idempotency is enforced in two places on purpose. The pre-check avoids the
 * write on the common replay path; the duplicate-key catch is what actually
 * guarantees correctness, because two concurrent runs can both pass the
 * pre-check before either has inserted. Only the unique index settles that
 * race, so the catch is the real mechanism and the query is the optimisation.
 *
 * @returns {Promise<boolean>} true if a row was inserted
 */
async function writeOnce(historyModel, doc, result) {
  try {
    const existing = await historyModel.findOne({
      userId: doc.userId,
      schemeId: doc.schemeId,
      triggeringChangeId: doc.triggeringChangeId,
    });
    if (existing) {
      result.duplicatesSkipped++;
      return false;
    }
  } catch (err) {
    // A failed pre-check is not fatal: the unique index still protects us.
    logger.warn("Propagation: duplicate pre-check failed, relying on unique index", {
      error: err.message,
    });
  }

  try {
    await historyModel.create(doc);
    return true;
  } catch (err) {
    if (err && (err.code === 11000 || /duplicate key/i.test(String(err.message)))) {
      result.duplicatesSkipped++;
      return false;
    }
    result.errors.push({ stage: "writeHistory", userId: String(doc.userId), error: err.message });
    return false;
  }
}

/** Mongoose Query or plain promise — either is fine. */
async function resolveUser(userModel, id) {
  const q = userModel.findById(id);
  const doc = q && typeof q.lean === "function" ? await q.lean() : await q;
  return doc || null;
}

function emptyTransitionCounts() {
  const counts = { NO_MOVEMENT: 0 };
  for (const v of Object.values(ELIGIBILITY_TRANSITIONS)) counts[v] = 0;
  for (const v of Object.values(RECOMMENDATION_TRANSITIONS)) counts[v] = 0;
  return counts;
}

module.exports = {
  propagateChange,
  computeRecommendationState,
  // PHASE X. The single candidate assembly every ranking surface must use.
  // Exported for the same reason `isActive` is, and for a stronger one: two
  // copies of the status rule would drift, and two copies of the candidate
  // shape DID.
  buildCandidates,
  // Exported so the chat service can apply the SAME status gate rather than
  // reimplementing it. matcher.js does not look at scheme status, so every
  // caller that ranks schemes must — and two copies of that rule would drift.
  isActive,
  classifyEligibilityTransition,
  classifyRecommendationTransition,
  buildReason,
  ELIGIBILITY_TRANSITIONS,
  RECOMMENDATION_TRANSITIONS,
  RECOMMENDATION_STATUS,
  DEFAULT_TOP_K,
};
