const UserModel = require("../models/User");
const SchemeModel = require("../models/Scheme");
const RecommendationHistoryModel = require("../models/RecommendationHistory");
const { answerQuestion, detectIntent, degradedCodesFor, INTENTS } = require("../agents/conversationalAgent");
const { rankCandidates } = require("../services/relevanceRanker");
// The status gate, imported rather than reimplemented (see loadRecommendationContext).
// PHASE X. `buildCandidates` owns the status gate along with the rest of the
// candidate shape, so `isActive` is no longer imported separately here — one
// import, one assembly, no second copy of either rule.
const { buildCandidates } = require("../services/recommendationPropagation");
const logger = require("../utils/logger");

/**
 * CHAT SERVICE — assembles the VERIFIED data the conversational agent answers
 * from, and enforces that all of it belongs to the caller.
 *
 * ---------------------------------------------------------------------------
 * WHY THE DATA GATHERING LIVES HERE AND NOT IN THE AGENT
 * ---------------------------------------------------------------------------
 * The agent takes `user` and `data` as arguments. That is deliberate: it makes
 * the agent a pure function of what it is handed, so its tests can hand it a
 * verdict and prove the LLM cannot override it without a database in the loop.
 *
 * The consequence is that SOMETHING has to decide which user's data to fetch —
 * and that decision is the entire authorization surface of this feature. It is
 * concentrated here, in one function, reading one variable.
 *
 * ---------------------------------------------------------------------------
 * THE USER ID RULE
 * ---------------------------------------------------------------------------
 * `userId` is a PARAMETER of this function and the route passes `req.user.sub`
 * — the subject of the verified JWT. Nothing in the request body is ever read
 * as an identity. There is no `userId`, `email` or `as` field in the accepted
 * payload, so there is no field to tamper with: a caller asking "am I eligible"
 * gets their own profile because that is the only profile this code can load.
 *
 * The same rule applies to every secondary fetch. Recommendation history is
 * queried with `{ userId }` in the filter, not filtered after the fact, so
 * another user's rows are not read and then discarded — they are never read.
 */

/** How many past turns the agent may see. Bounded on purpose (N.6). */
const MAX_CONTEXT_TURNS = 6;
/** Longest question accepted. A prompt is not a file upload. */
const MAX_MESSAGE_CHARS = 1000;
/** Top-K used when answering "which schemes are recommended for me". */
const RECOMMENDATION_TOP_K = Number(process.env.RECOMMENDATION_TOP_K) || 5;

/**
 * Turn the client's conversation array into the bounded context the agent
 * reads.
 *
 * Only two fields survive: the last intent and the last scheme id. The message
 * TEXT of previous turns is deliberately not carried — it is unnecessary for
 * resolving "why?", and a transcript echoed back through the API is a second
 * place personal details could leak from.
 */
function buildContext(history = []) {
  const turns = Array.isArray(history) ? history.slice(-MAX_CONTEXT_TURNS) : [];
  let lastIntent = null;
  let lastSchemeId = null;
  for (const turn of turns) {
    if (turn && typeof turn === "object") {
      if (typeof turn.intent === "string" && INTENTS[turn.intent]) lastIntent = turn.intent;
      if (typeof turn.schemeId === "string" && turn.schemeId) lastSchemeId = turn.schemeId;
    }
  }
  return { lastIntent, lastSchemeId };
}

/**
 * Load the scheme the question is about.
 *
 * Schemes are public information — there is no per-user authorization on them.
 * The lookup is by schemeId only, and returns null rather than throwing so an
 * unknown id becomes an insufficient-evidence answer instead of a 500.
 */
async function loadScheme(schemeId, model) {
  if (!schemeId) return null;
  const doc = await model.findOne({ schemeId: String(schemeId) }).lean();
  return doc || null;
}

/**
 * The caller's OWN recommendation history for one scheme.
 *
 * `userId` is in the filter, so this cannot return another user's rows. The
 * schemeId narrows it further; without one, the caller's most recent changes
 * across all schemes are returned, which is what "which schemes changed
 * recently" needs.
 */
async function loadHistoryRows({ userId, schemeId, model, limit = 3 }) {
  const filter = { userId };
  if (schemeId) filter.schemeId = String(schemeId);
  const cursor = model.find(filter).sort({ createdAt: -1 }).limit(limit);
  const rows = typeof cursor.lean === "function" ? await cursor.lean() : await cursor;
  return rows || [];
}

/**
 * Turn the ranker's numeric breakdown into verified statements.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * N.4 requires ranking reasons and forbids the LLM from inventing one. The
 * ranker emits `relevanceBreakdown` — numbers, not sentences — so something has
 * to render them, and it must be this layer rather than the model.
 *
 * Every sentence below describes what its component ACTUALLY measures, read
 * off `scoreCandidate`. A component that contributed nothing produces no
 * sentence: an empty list stays empty rather than being padded with a
 * plausible-sounding reason, because a padded reason is exactly the invention
 * the rule forbids — it would just be invented here instead of by the model.
 */
function describeRankingSignals(breakdown = {}, documentReadiness = null) {
  const out = [];
  if (breakdown.specificity > 0) {
    out.push(
      `you satisfy ${breakdown.specificity} specific eligibility condition${
        breakdown.specificity === 1 ? "" : "s"
      } of this scheme`
    );
  }
  if (documentReadiness && documentReadiness.required > 0 && documentReadiness.have > 0) {
    out.push(
      `you already have ${documentReadiness.have} of ${documentReadiness.required} required documents on file`
    );
  }
  if (breakdown.deadline > 0) out.push("the application deadline is approaching");
  if (breakdown.benefit > 0) out.push("the scheme states a concrete benefit amount");
  if (breakdown.lexical > 0) out.push("the scheme text matches details from your profile");
  if (breakdown.universalPenalty < 0) {
    // A downweight, reported as honestly as an upweight. Hiding it would make
    // the ranking look more personalised than it is.
    out.push("this scheme is open to everyone, so it carries less personal signal");
  }
  return out;
}

/**
 * The caller's recommendation state for one scheme, recomputed from the
 * CURRENT scheme universe by the same ranker the recommendations endpoint
 * uses.
 *
 * Recomputed rather than read from a cache because a rank is only meaningful
 * relative to the universe it was computed in. Serving a stored rank from last
 * week's universe would be a number that looks current and is not.
 *
 * ---------------------------------------------------------------------------
 * THE CANDIDATE SHAPE MUST MATCH THE OTHER TWO CALL SITES
 * ---------------------------------------------------------------------------
 * `GET /recommendations` and `recommendationPropagation` both build
 * `{scheme, verdict, documentReadiness}` and both drop inactive schemes. If
 * this built a different shape, chat would quote a rank the rest of the
 * application does not agree with — "you are ranked 3" next to a UI showing 5,
 * with no way for the user to tell which is right.
 */
async function loadRecommendationContext({ user, schemeId, schemeModel }) {
  if (!schemeId) return null;
  const all = await schemeModel.find({}).lean();
  // PHASE X. Built by recommendationPropagation.buildCandidates — the same
  // call the propagation pass and GET /matches make. This function used to
  // assemble the list itself, correctly; the propagation copy omitted
  // `documentReadiness` and ranked a different order into the audit trail.
  // Three hand-assembled copies of one shape is what produced that, so there
  // is now one.
  const eligible = buildCandidates(user, all);
  const ranked = rankCandidates(eligible, user);
  const index = ranked.findIndex((r) => (r.scheme || r).schemeId === String(schemeId));
  if (index === -1) {
    // Not in the eligible set at all. Saying so is a verified fact; inventing
    // a rank for it would not be.
    const scheme = (all || []).find((s) => s.schemeId === String(schemeId));
    if (!scheme) return null;
    return {
      schemeId: String(schemeId),
      schemeName: scheme.name || "",
      rank: null,
      relevance: null,
      topK: RECOMMENDATION_TOP_K,
      eligible: false,
      rankingReasons: [],
    };
  }

  const hit = ranked[index];
  const scheme = hit.scheme || hit;
  return {
    schemeId: String(schemeId),
    schemeName: scheme.name || "",
    rank: index + 1,
    // N.4 asks for the relevance score alongside the rank.
    relevance: typeof hit.relevance === "number" ? hit.relevance : null,
    topK: RECOMMENDATION_TOP_K,
    eligible: true,
    // Rendered from the ranker's own computed breakdown — never invented, and
    // never padded when a component contributed nothing.
    rankingReasons: describeRankingSignals(hit.relevanceBreakdown, hit.documentReadiness).slice(0, 5),
  };
}

/**
 * The public API response.
 *
 * N.8 asks for internal debugging fields to be kept off the wire. What is
 * dropped and why:
 *
 *   - `metrics`  latency and chunk counts. Useful for the research evaluation,
 *                and also a timing side-channel; kept server-side in the log.
 *   - `degraded` names the provider and the error text. Operational detail a
 *                citizen cannot act on, and error strings are where internal
 *                hostnames and quota details leak from. Reduced to a single
 *                boolean so the UI can still show a soft warning.
 *   - `intentConfidence`, `matchedBy`  expose the routing regexes.
 *
 * Source excerpts ARE returned: they are public scheme text, and a grounded
 * answer the reader cannot check is not much better than an ungrounded one.
 */
function toPublicResponse(agentOut) {
  return {
    answer: agentOut.answer,
    intent: agentOut.intent,
    confidence: agentOut.confidence,
    grounded: agentOut.grounded,
    sources: (agentOut.sources || []).map((s) => ({
      schemeId: s.schemeId,
      schemeVersion: s.schemeVersion,
      field: s.field,
      excerpt: s.excerpt,
    })),
    schemeIds: agentOut.schemeIds || [],
    schemeVersions: agentOut.schemeVersions || [],
    eligibilityDecision: agentOut.eligibilityDecision
      ? {
          schemeId: agentOut.eligibilityDecision.schemeId,
          schemeName: agentOut.eligibilityDecision.schemeName,
          schemeVersion: agentOut.eligibilityDecision.schemeVersion,
          eligible: agentOut.eligibilityDecision.eligible,
          satisfied: agentOut.eligibilityDecision.satisfied,
          unsatisfied: agentOut.eligibilityDecision.unsatisfied,
          // Named on the wire so the UI can label the verdict as the rules
          // engine's rather than the model's — the separation is the point,
          // and a user who cannot see it does not benefit from it.
          source: agentOut.eligibilityDecision.source,
        }
      : null,
    recommendationContext: agentOut.recommendationContext || null,
    // A hint, not a diagnosis.
    degraded: (agentOut.degraded || []).length > 0,
    // WHICH thing degraded, as closed-vocabulary codes. Never the messages:
    // those are interpolated from provider errors and are exactly what the
    // rule above exists to keep off the wire. See DEGRADED in
    // agents/conversationalAgent.js.
    //
    // Without this the UI had only the boolean and rendered every degradation
    // as "some services were unavailable" — false whenever the cause was
    // local-hash embeddings, which is the DEFAULT configuration.
    degradedReasons: degradedCodesFor(agentOut.degraded || []),
  };
}

/**
 * Answer one chat message for ONE authenticated user.
 *
 * @param {Object} opts
 * @param {string} opts.userId    from the verified JWT. NEVER from the body.
 * @param {string} opts.message
 * @param {string} [opts.schemeId]
 * @param {Array}  [opts.history] previous turns: [{intent, schemeId}]
 * @param {string} [opts.language]
 */
async function handleChat({
  userId,
  message,
  schemeId = null,
  history = [],
  language = "en",
  deps = {},
} = {}) {
  const {
    userModel = UserModel,
    schemeModel = SchemeModel,
    historyModel = RecommendationHistoryModel,
    agent = answerQuestion,
    // The RAG chunk model. This service already takes every OTHER model by
    // injection; the chunk model was the one that escaped, because it is
    // reached indirectly — through the agent's default `retrieve` — rather
    // than being read here. A caller that substituted the three models above
    // still hit the real Mongoose SchemeChunk.
    //
    // Undefined in production, which is the real-model path.
    ragChunkModel = undefined,
  } = deps;

  const text = String(message || "").trim();
  if (!text) return { ok: false, error: "message is required" };
  if (text.length > MAX_MESSAGE_CHARS) {
    return { ok: false, error: `message must be ${MAX_MESSAGE_CHARS} characters or fewer` };
  }
  if (!userId) return { ok: false, error: "authentication required" };

  // The only user this request can ever see.
  const user = await userModel.findById(userId).lean();
  if (!user) return { ok: false, error: "user not found" };

  const context = buildContext(history);
  const { intent, matchedBy } = detectIntent(text, context);

  // A generic "what has changed recently" question must return changes
  // across ALL of the caller's schemes (see loadHistoryRows above), not
  // whichever scheme happened to be discussed in an earlier, unrelated
  // turn. Only a genuine follow-up ("why?" continuing the same topic —
  // matchedBy === "follow-up") legitimately inherits the previous
  // scheme id for a POLICY_CHANGE question. Every other intent keeps
  // the original "inherit from context" behaviour, since "why?" after
  // an eligibility/documents/deadline answer should stay on that scheme.
  const isFollowUp = matchedBy === "follow-up";
  let resolvedSchemeId;
  if (schemeId) {
    resolvedSchemeId = schemeId;
  } else if (intent === INTENTS.POLICY_CHANGE && !isFollowUp) {
    resolvedSchemeId = null;
  } else {
    resolvedSchemeId = context.lastSchemeId || null;
  }

  // Fetch only what this intent actually needs. Loading a user's whole change
  // history to answer "what documents do I need" would be both slow and a
  // wider blast radius than the question warrants.
  const data = {};
  try {
    if (resolvedSchemeId) data.scheme = await loadScheme(resolvedSchemeId, schemeModel);
    if (intent === INTENTS.POLICY_CHANGE) {
      data.historyRows = await loadHistoryRows({
        userId,
        schemeId: resolvedSchemeId,
        model: historyModel,
      });
    }
    if (intent === INTENTS.RECOMMENDATION) {
      data.recommendationContext = await loadRecommendationContext({
        user,
        schemeId: resolvedSchemeId,
        schemeModel,
      });
    }
  } catch (err) {
    // A data-gathering failure must not become a fabricated answer. The agent
    // will see empty `data`, find no verified facts, and refuse — which is the
    // correct outcome.
    logger.warn("Chat service: verified data lookup failed", {
      userId: String(userId).slice(0, 8),
      intent,
      error: err.message,
    });
  }

  const agentOut = await agent({
    message: text,
    user,
    context,
    explicitSchemeId: resolvedSchemeId,
    language,
    data,
    ragChunkModel,
  });

  // Full instrumentation stays server-side (research evaluation hooks) and
  // carries no message text and no profile values.
  logger.info("Chat: answered", {
    intent: agentOut.intent,
    grounded: agentOut.grounded,
    method: agentOut.method,
    retrievedChunks: agentOut.metrics?.retrievedChunks,
    retrievalMs: agentOut.metrics?.retrievalMs,
    llmMs: agentOut.metrics?.llmMs,
    totalMs: agentOut.metrics?.totalMs,
    degradedCount: (agentOut.degraded || []).length,
  });

  return {
    ok: true,
    response: toPublicResponse(agentOut),
    // Echoed so the client can send it back as the next turn's history without
    // storing anything server-side.
    turn: { intent: agentOut.intent, schemeId: resolvedSchemeId },
  };
}

module.exports = {
  handleChat,
  buildContext,
  toPublicResponse,
  loadRecommendationContext,
  describeRankingSignals,
  loadHistoryRows,
  loadScheme,
  MAX_CONTEXT_TURNS,
  MAX_MESSAGE_CHARS,
};
