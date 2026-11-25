/**
 * Transition vocabularies, shared by the RecommendationHistory model and the
 * propagation service.
 *
 * These used to be exported from the model, and the service read them with
 * `const { ... } = require("../models/RecommendationHistory")`. That coupled a
 * pure classification vocabulary to a database handle: substitute the model
 * layer — which any integration test must — and the enums silently become
 * undefined, so `Object.values(...)` throws from deep inside propagation with
 * an error that says nothing about the real cause.
 *
 * A vocabulary is not a database concern. It lives here, and both sides import
 * it.
 */

/** How the user's ELIGIBILITY moved. Four cases, exhaustive. */
const ELIGIBILITY_TRANSITIONS = Object.freeze({
  INELIGIBLE_TO_ELIGIBLE: "INELIGIBLE_TO_ELIGIBLE",
  ELIGIBLE_TO_INELIGIBLE: "ELIGIBLE_TO_INELIGIBLE",
  ELIGIBLE_TO_ELIGIBLE: "ELIGIBLE_TO_ELIGIBLE",
  INELIGIBLE_TO_INELIGIBLE: "INELIGIBLE_TO_INELIGIBLE",
});

/**
 * How the user's RECOMMENDATION moved. Distinct from eligibility: a user can
 * stay eligible while the scheme drops out of their top K because a different
 * scheme became more relevant, and can become eligible without the scheme ever
 * surfacing in their top K.
 *
 * RANK_INCREASED / RANK_DECREASED are about the POSITION IN THE LIST, and the
 * direction is the one a person means, not the one the integer does:
 *
 *   RANK_INCREASED — the scheme moved UP the list and is now more prominent.
 *                    The rank NUMBER went DOWN (e.g. 5 -> 2).
 *   RANK_DECREASED — the scheme moved DOWN the list.
 *                    The rank NUMBER went UP (e.g. 2 -> 5).
 *
 * Stated here because it is the single easiest thing in this codebase to get
 * backwards, and backwards it would tell a user a scheme became more relevant
 * at the moment it became less so.
 */
const RECOMMENDATION_TRANSITIONS = Object.freeze({
  NOT_RECOMMENDED_TO_RECOMMENDED: "NOT_RECOMMENDED_TO_RECOMMENDED",
  RECOMMENDED_TO_NOT_RECOMMENDED: "RECOMMENDED_TO_NOT_RECOMMENDED",
  RANK_INCREASED: "RANK_INCREASED",
  RANK_DECREASED: "RANK_DECREASED",
  NO_CHANGE: "NO_CHANGE",
});

const RECOMMENDATION_STATUS = Object.freeze({
  RECOMMENDED: "RECOMMENDED",
  NOT_RECOMMENDED: "NOT_RECOMMENDED",
});

module.exports = {
  ELIGIBILITY_TRANSITIONS,
  RECOMMENDATION_TRANSITIONS,
  RECOMMENDATION_STATUS,
};
