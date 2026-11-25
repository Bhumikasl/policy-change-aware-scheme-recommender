/**
 * PHASE X — CROSS-SURFACE RECOMMENDATION AGREEMENT.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * Every prior phase verifies ONE mechanism in isolation:
 *
 *   Q  candidate selection      R  notification cost     S  staleness bound
 *   T  the ranker               U  the matcher           V  the change detector
 *   W  the serialization boundary
 *
 * The system, however, tells a user their recommendations through THREE
 * independent paths, and each one assembles its own candidate list before
 * handing it to the ranker:
 *
 *   1. `GET /users/:email/matches`   — the page
 *   2. `chatService`                 — the assistant
 *   3. `recommendationPropagation`   — the audit trail and the notifications
 *
 * Every component can be individually perfect while those three disagree, and
 * no phase from Q to W can see it. Q compares one pipeline against an oracle.
 * T proves the ranker is a function of its inputs — it never asks whether the
 * three callers hand it the SAME inputs. U proves the matcher is right. V
 * proves changes are detected. W proves the response does not over-share.
 *
 * A user told one ordering by the page, another by the assistant, and a third
 * by the email they received is being told the system is unreliable — and the
 * `RecommendationHistory` row, which this project treats as evidence, records
 * the third.
 *
 * ---------------------------------------------------------------------------
 * THE PROPERTY
 * ---------------------------------------------------------------------------
 *   X.1 SHAPE      every surface hands the ranker candidates carrying the same
 *                  fields. A missing field is not an error anywhere — it scores
 *                  zero — which is exactly why this failed silently.
 *
 *   X.2 MEMBERSHIP every surface selects the same set of schemes.
 *
 *   X.3 ORDER      every surface produces the same ranking over that set.
 *
 * ---------------------------------------------------------------------------
 * WHAT MAKES THIS MORE THAN "PRODUCTION vs PRODUCTION"
 * ---------------------------------------------------------------------------
 * Differential testing has a real oracle — the agreement relation itself — but
 * three surfaces that share one bug agree perfectly. So membership is ALSO
 * checked against an independent expectation:
 *
 *   `expectedMembership()` decides which schemes belong in a user's candidate
 *   set using `eligibilityReference.referenceEligibility` (the Phase U
 *   implementation, which does not import `services/matcher.js`) and a status
 *   rule restated from the documented behaviour rather than imported.
 *
 * The ranker is deliberately NOT reimplemented. Order agreement is a
 * consistency relation, not a value to be recomputed, and a second 300-line
 * scorer would drift for reasons that say nothing about correctness — Phase T
 * already owns the ranker's own properties. What Phase X adds is the question T
 * cannot ask: are its inputs the same everywhere?
 */

const { rankCandidates } = require("../services/relevanceRanker");
const {
  buildCandidates,
  isActive,
} = require("../services/recommendationPropagation");
const { referenceEligibility } = require("./eligibilityReference");
const { USERS, UNIVERSES } = require("./surfaceCorpus");

// ---------------------------------------------------------------------------
// The independent membership expectation
// ---------------------------------------------------------------------------

/**
 * Restated from the documented rule — "a closed scheme is not recommendable
 * regardless of what the rules say", and a blank status must not silently
 * revoke every scheme — rather than importing `isActive`. Importing it would
 * make the expectation agree with production by construction on the one gate
 * that has already drifted once.
 */
function referenceIsOpen(scheme) {
  const s = String(scheme?.status ?? "active").toLowerCase();
  return s === "active" || s === "";
}

/**
 * Which schemes SHOULD be in this user's candidate set, decided without the
 * production matcher and without the production status gate.
 */
function expectedMembership(user, universe, { allowUnknown = false } = {}) {
  return (universe || [])
    .filter((scheme) => referenceIsOpen(scheme))
    .filter((scheme) => referenceEligibility(user, scheme, { allowUnknown }).eligible)
    .map((scheme) => scheme.schemeId)
    .sort();
}

// ---------------------------------------------------------------------------
// The three surfaces, as they really assemble their candidates
// ---------------------------------------------------------------------------

/**
 * Each entry runs the REAL assembly that surface performs — not a description
 * of it. `buildCandidates` is the shared function all three now call; the
 * per-surface wrappers reproduce the arguments each one passes, because that is
 * where a divergence would reappear (one surface forgetting `allowUnknown`, or
 * ranking with a different option set).
 *
 * `matches` additionally narrows its Mongo query before the gate; that
 * prefilter is modelled here as the superset it is, so that a future change
 * making it narrower than `isActive` shows up as a membership disagreement.
 */
const SURFACES = Object.freeze([
  {
    key: "matches",
    label: "GET /users/:email/matches",
    /** The route reads Scheme.find({ status: { $ne: "Closed" }, ... }). */
    prefilter: (universe, { allowUnknown }) =>
      universe.filter(
        (s) =>
          s.status !== "Closed" &&
          (allowUnknown ||
            ["universal", "constrained"].includes(s.eligibilityRules?.eligibilityType))
      ),
    build: (user, universe, opts) => buildCandidates(user, universe, opts),
    rank: (candidates, user, { intent }) => rankCandidates(candidates, user, { intent }),
  },
  {
    key: "chat",
    label: "chatService (the assistant)",
    prefilter: (universe) => universe,
    build: (user, universe) => buildCandidates(user, universe),
    rank: (candidates, user) => rankCandidates(candidates, user),
  },
  {
    key: "propagation",
    label: "recommendationPropagation (history + notifications)",
    prefilter: (universe) => universe,
    build: (user, universe) => buildCandidates(user, universe),
    rank: (candidates, user, { intent }) => rankCandidates(candidates, user, { intent }),
  },
]);

/**
 * The fields `relevanceRanker` reads off a candidate.
 *
 * Listed from the ranker's documented candidate contract — `@param {Array}
 * candidates [{ scheme, verdict, documentReadiness }]` — not from whatever the
 * builder happens to produce. A shape check that read the builder's output
 * would call any consistent mistake correct.
 */
const RANKER_CANDIDATE_FIELDS = Object.freeze(["scheme", "verdict", "documentReadiness"]);

const shapeOf = (candidates) => {
  const present = new Set();
  for (const c of candidates) {
    for (const field of RANKER_CANDIDATE_FIELDS) {
      if (c[field] !== undefined && c[field] !== null) present.add(field);
    }
  }
  return [...present].sort();
};

const orderOf = (ranked) => ranked.map((c) => (c.scheme || c).schemeId);
const membershipOf = (candidates) => candidates.map((c) => c.scheme.schemeId).sort();

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

/**
 * Run one user over one universe through all three surfaces.
 *
 * `surfaces` is injectable — the seam the tests use to hand the harness a
 * deliberately divergent surface. Without it the disagreement branches can only
 * be exercised by breaking production, so a mutation that disables them would
 * survive on a branch nothing reaches. Phase W learned that the hard way
 * (W-M15).
 *
 * @returns {{shape, membership, order, expected, disagreements: Array}}
 */
function compareSurfaces(
  user,
  universe,
  { allowUnknown = false, intent = "", surfaces: surfaceList = SURFACES } = {}
) {
  const perSurface = {};
  for (const surface of surfaceList) {
    const visible = surface.prefilter(universe, { allowUnknown });
    const candidates = surface.build(user, visible, { allowUnknown });
    const ranked = surface.rank(candidates, user, { intent });
    perSurface[surface.key] = {
      label: surface.label,
      shape: shapeOf(candidates),
      membership: membershipOf(candidates),
      order: orderOf(ranked),
    };
  }

  const keys = surfaceList.map((s) => s.key);
  const base = perSurface[keys[0]];
  const disagreements = [];

  for (const key of keys.slice(1)) {
    const other = perSurface[key];
    if (JSON.stringify(base.shape) !== JSON.stringify(other.shape)) {
      disagreements.push({
        property: "SHAPE",
        surfaces: [keys[0], key],
        detail: `${base.shape.join("+")} vs ${other.shape.join("+")}`,
      });
    }
    if (JSON.stringify(base.membership) !== JSON.stringify(other.membership)) {
      disagreements.push({
        property: "MEMBERSHIP",
        surfaces: [keys[0], key],
        detail: `${base.membership.join(",")} vs ${other.membership.join(",")}`,
      });
    }
    if (JSON.stringify(base.order) !== JSON.stringify(other.order)) {
      disagreements.push({
        property: "ORDER",
        surfaces: [keys[0], key],
        detail: `${base.order.join(" > ")}   vs   ${other.order.join(" > ")}`,
      });
    }
  }

  // The independent checks. Agreement between three copies of one mistake is
  // still a mistake — and since Phase X made all three surfaces share one
  // builder, a defect IN that builder now breaks them identically and they go
  // on agreeing. Differential testing alone would report AGREE for exactly the
  // bug this phase was created to fix.
  //
  // SHAPE is therefore also checked against the ranker's documented candidate
  // contract, and membership against a reference that shares no code with the
  // production matcher or the production status gate.
  for (const key of keys) {
    // An empty candidate set has no shape to check. Reporting one would make
    // every user who qualifies for nothing look like a contract violation.
    if (perSurface[key].membership.length === 0) continue;
    const missing = RANKER_CANDIDATE_FIELDS.filter((f) => !perSurface[key].shape.includes(f));
    if (missing.length > 0) {
      disagreements.push({
        property: "SHAPE_VS_CONTRACT",
        surfaces: [key, "relevanceRanker's documented candidate contract"],
        detail: `does not populate ${missing.join(", ")}`,
      });
    }
  }

  const expected = expectedMembership(user, universe, { allowUnknown });
  for (const key of keys) {
    if (JSON.stringify(perSurface[key].membership) !== JSON.stringify(expected)) {
      disagreements.push({
        property: "MEMBERSHIP_VS_REFERENCE",
        surfaces: [key, "independent reference"],
        detail: `${perSurface[key].membership.join(",")} vs ${expected.join(",")}`,
      });
    }
  }

  return { perSurface, expected, disagreements };
}

/**
 * Run every user against every universe.
 *
 * `readinessDecisive` is the evidence-strength figure. AGREE over a corpus in
 * which no candidate field ever decides an ordering would be vacuous — the
 * dropped field scores zero rather than throwing, so it only becomes visible
 * where it is the deciding term. Every other corpus in this project happens
 * not to contain such a case, which is why the surfaces disagreed while 957
 * tests passed.
 */
function runSurfaceAgreement({ users = USERS, universes = UNIVERSES, surfaces = SURFACES } = {}) {
  const cases = [];
  const disagreements = [];
  let readinessDecisive = 0;

  for (const { label: userLabel, user } of users) {
    for (const universe of universes) {
      const result = compareSurfaces(user, universe.schemes, { surfaces });

      // Does the readiness term actually separate anything here? Recomputed by
      // ranking the same candidates with the field stripped and seeing whether
      // the order moves — a direct measurement, not an assumption about the
      // corpus.
      const candidates = buildCandidates(user, universe.schemes);
      const withField = orderOf(rankCandidates(candidates, user));
      const withoutField = orderOf(
        rankCandidates(candidates.map(({ documentReadiness, ...rest }) => rest), user)
      );
      const decisive = JSON.stringify(withField) !== JSON.stringify(withoutField);
      if (decisive) readinessDecisive++;

      for (const d of result.disagreements) {
        disagreements.push({ user: userLabel, universe: universe.label, ...d });
      }
      cases.push({
        user: userLabel,
        universe: universe.label,
        candidates: candidates.length,
        readinessDecisive: decisive,
        agreed: result.disagreements.length === 0,
        perSurface: result.perSurface,
        expected: result.expected,
      });
    }
  }

  return {
    status: disagreements.length === 0 ? "AGREE" : "DISAGREE",
    surfaces: surfaces.length,
    users: users.length,
    universes: universes.length,
    comparisons: cases.length,
    readinessDecisive,
    disagreements,
    cases,
  };
}

module.exports = {
  runSurfaceAgreement,
  compareSurfaces,
  expectedMembership,
  referenceIsOpen,
  shapeOf,
  orderOf,
  membershipOf,
  SURFACES,
  RANKER_CANDIDATE_FIELDS,
  USERS,
  UNIVERSES,
  isActive,
};
