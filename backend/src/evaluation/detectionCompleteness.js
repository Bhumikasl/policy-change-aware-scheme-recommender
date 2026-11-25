/**
 * PHASE V — CHANGE-DETECTION COMPLETENESS.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS MEASURES
 * ---------------------------------------------------------------------------
 * The project's headline claim has two halves: *detect* government policy
 * drift, and *propagate* it. Phases Q through U measure the second half in
 * detail. This measures the first.
 *
 * The property under test is one-directional and safety-critical:
 *
 *     if a change flips at least one user's recommended state,
 *     then reconcile() MUST report it as a change,
 *     the change agent MUST classify it as user-affecting, and
 *     the impact agent MUST select a provably complete candidate set.
 *
 * The converse is NOT required. Detecting a change that flips nobody costs a
 * wasted cycle; Phase R measured exactly that case (`no-material-change`:
 * legacy 104 notifications, targeted 0). Missing one that flips somebody is a
 * person left holding an invalidated recommendation.
 *
 * ---------------------------------------------------------------------------
 * WHERE THE MUTATION SET COMES FROM — THE WHOLE METHODOLOGICAL POINT
 * ---------------------------------------------------------------------------
 * The Phase V brief's rule 7 forbids computing ground truth with the production
 * algorithm. For a detector, the tempting version of that mistake is subtle and
 * already present in this repository: `tests/policyChangeAgent.test.js` gates
 * field-map coverage with
 *
 *     emittable = COMPARABLE_FIELDS + ELIGIBILITY_RULE_FIELDS
 *
 * — the detector's OWN list of fields it compares. That test is worth having,
 * but it can only ever ask "is every field we compare also classified?" It
 * cannot ask "is every field that matters compared?", because a field missing
 * from the list is missing from both sides of the check. It passed for the
 * entire life of the project while a decision-critical field went uncompared.
 *
 * So the field universe here is derived from **the normalized document itself**
 * — every key the normalizer actually writes — and never from COMPARABLE_FIELDS
 * or ELIGIBILITY_RULE_FIELDS. The gap between "fields the document carries" and
 * "fields the detector compares" is the blind spot, and it is only visible from
 * outside the detector.
 *
 * A consequence worth stating: a future field added to the normalizer but not
 * to the comparator is caught automatically, with no edit to this file.
 *
 * ---------------------------------------------------------------------------
 * THE DETECTION PATH IS THE REAL ONE
 * ---------------------------------------------------------------------------
 * `detectChange` below is `reconcile()` with the database removed: the same
 * `normalize`, the same contentHash gate, the same `diffFields`. Only the
 * Mongo read/write plumbing is absent, and `tests/detectionCompleteness.test.js`
 * asserts structurally that reconcile still routes through both gates in the
 * same order, so the two cannot drift apart silently.
 */

const { normalize } = require("../normalizer/normalizer");
const { diffFields } = require("../services/comparator");
const { classifyDeterministic } = require("../agents/policyChangeAgent");
const { buildImpactQuery } = require("../agents/policyImpactAgent");
const { evaluateEligibility } = require("../services/matcher");
const { referenceEligibility } = require("./eligibilityReference");
const { enumeratePopulation, assessMateriality, schemeIsOpen } = require("./detectionOracle");

// ---------------------------------------------------------------------------
// Base schemes — the shapes a mutation is applied to.
// ---------------------------------------------------------------------------

const rules = (over = {}) => ({
  minAge: null,
  maxAge: null,
  maxAnnualIncome: null,
  minAnnualIncome: null,
  minMarksPercentage: null,
  minEducationLevel: null,
  genders: [],
  categories: [],
  categoryGroups: [],
  occupations: [],
  states: [],
  source: "structured",
  eligibilityType: "constrained",
  confidence: 0.9,
  needsReview: false,
  extractedAt: null,
  ...over,
});

const scheme = (id, over = {}) => ({
  schemeId: id,
  name: "Vidya Scholarship",
  description: "Financial assistance for students.",
  eligibility: "Students resident in the state.",
  benefits: "Rs 20000 per year",
  documents: ["Aadhaar Card"],
  lastDate: "2026-12-31",
  applicationLink: "https://example.gov.in/apply",
  ministry: "Education",
  state: "Kerala",
  category: ["Education"],
  tags: ["Student"],
  status: "Active",
  sourceUrl: "https://example.gov.in/scheme",
  ...over,
  eligibilityRules: rules(over.eligibilityRules || {}),
});

/**
 * Four shapes, chosen so that no single one can hide a defect by being
 * insensitive to it.
 *
 * `constrained-bare` earns its place specifically: a constrained scheme with
 * no rules matches nobody, while the same scheme marked universal matches
 * everybody. It is the shape on which an eligibilityType change is maximally
 * material, and without it a detector that ignored the field could agree with
 * the oracle for the wrong reason — the failure mode Phase U's U-M4 mutant
 * exposed inside Phase U itself.
 */
const BASE_SCHEMES = Object.freeze([
  {
    label: "constrained-multi",
    source: "myScheme",
    raw: scheme("vidya-constrained", {
      eligibilityRules: {
        states: ["Kerala"],
        maxAnnualIncome: 200000,
        minMarksPercentage: 60,
        eligibilityType: "constrained",
      },
    }),
  },
  {
    label: "constrained-bare",
    source: "myScheme",
    raw: scheme("vidya-bare", { state: "All India", eligibilityRules: { eligibilityType: "constrained", states: [] } }),
  },
  {
    label: "universal-open",
    source: "myScheme",
    raw: scheme("vidya-universal", { state: "All India", eligibilityRules: { eligibilityType: "universal", states: [] } }),
  },
  {
    label: "unknown-unparsed",
    source: "myScheme",
    raw: scheme("vidya-unknown", {
      eligibilityRules: { eligibilityType: "unknown", source: "unparsed", states: ["Kerala"] },
    }),
  },
]);

// ---------------------------------------------------------------------------
// The field universe, and the values each field is perturbed through.
// ---------------------------------------------------------------------------

/**
 * Keys the normalizer writes that are NOT scheme content, with the reason each
 * is out of scope. Stated explicitly rather than filtered silently: an
 * exclusion nobody can see is indistinguishable from an oversight, which is the
 * exact class of defect this phase exists to find.
 */
const EXCLUDED_FROM_UNIVERSE = Object.freeze({
  schemeId: "identity, not content — a different schemeId is a different scheme, not a changed one",
  contentHash: "the detector's own output, not an input the source can change",
  eligibilityRules: "expanded into its sub-fields below rather than perturbed as one object",
});

/**
 * Candidate values per field. Every field in the universe must appear here —
 * `fieldUniverse()` throws otherwise, so a normalizer field added without a
 * domain fails loudly instead of being silently skipped.
 *
 * These are plausible source values, chosen without reference to whether the
 * detector compares the field. Boundary-adjacent numbers pair with the oracle's
 * profile axes so that a threshold move can actually flip somebody.
 */
const VALUE_DOMAINS = Object.freeze({
  // ---- top level ----
  name: ["Vidya Scholarship", "Vidya Scholarship (Revised 2026)"],
  description: ["Financial assistance for students.", "Financial assistance for students and apprentices."],
  eligibility: ["Students resident in the state.", "Students and apprentices resident in the state."],
  benefits: ["Rs 20000 per year", "Rs 30000 per year"],
  documents: [[], ["Aadhaar Card"], ["Aadhaar Card", "Income Certificate"]],
  lastDate: ["", "2026-12-31", "2027-06-30"],
  applicationLink: ["https://example.gov.in/apply", "https://example.gov.in/apply-v2"],
  ministry: ["Education", "Human Resource Development"],
  state: ["Kerala", "All India"],
  category: [[], ["Education"], ["Education", "Scholarship"]],
  tags: [[], ["Student"], ["Student", "Youth"]],
  status: ["Active", "Closed"],
  source: ["myScheme", "PIB"],
  sourceUrl: ["https://example.gov.in/scheme", "https://example.gov.in/scheme-v2"],

  // ---- eligibilityRules ----
  "eligibilityRules.minAge": [null, 18, 21],
  "eligibilityRules.maxAge": [null, 60, 65],
  "eligibilityRules.maxAnnualIncome": [null, 200000, 300000],
  "eligibilityRules.minAnnualIncome": [null, 50000],
  "eligibilityRules.minMarksPercentage": [null, 60, 75],
  "eligibilityRules.minEducationLevel": [null, "10th Standard", "Graduate"],
  "eligibilityRules.maxEducationLevel": [null, "12th Standard", "Graduate"],
  "eligibilityRules.courses": [[], ["Computer Science"], ["Agriculture"]],
  "eligibilityRules.disabilityRequired": [null, true, false],
  "eligibilityRules.minDisabilityPercentage": [null, 40],
  "eligibilityRules.singleGirlChildRequired": [null, true, false],
  "eligibilityRules.genders": [[], ["Female"], ["Male"]],
  "eligibilityRules.categories": [[], ["SC"], ["SC", "BPL"]],
  "eligibilityRules.categoryGroups": [[], [["SC", "ST"]], [["SC", "ST"], ["BPL"]]],
  "eligibilityRules.occupations": [[], ["Student"], ["Farmer"]],
  "eligibilityRules.applicantTypes": [[], ["INSTITUTION"], ["STUDENT", "INDIVIDUAL"]],
  "eligibilityRules.states": [[], ["Kerala"], ["Kerala", "Tamil Nadu"]],
  "eligibilityRules.source": ["structured", "llm-extracted", "deterministic", "unparsed"],
  "eligibilityRules.eligibilityType": ["constrained", "universal", "unknown"],
  "eligibilityRules.confidence": [0, 0.5, 0.9],
  "eligibilityRules.needsReview": [false, true],
  "eligibilityRules.extractedAt": [null, "2026-01-01T00:00:00.000Z"],
});

/**
 * Every field the normalized document carries, as dotted paths.
 *
 * Derived from the document, NOT from COMPARABLE_FIELDS. See the header.
 */
function fieldUniverse(normalized) {
  const paths = [];
  for (const key of Object.keys(normalized)) {
    if (key in EXCLUDED_FROM_UNIVERSE) continue;
    paths.push(key);
  }
  for (const key of Object.keys(normalized.eligibilityRules || {})) {
    paths.push(`eligibilityRules.${key}`);
  }
  const undomained = paths.filter((p) => !(p in VALUE_DOMAINS));
  if (undomained.length > 0) {
    throw new Error(
      `PHASE V: no perturbation domain for ${undomained.join(", ")}. ` +
        `A field the normalizer writes must be exercised or explicitly excluded — ` +
        `add it to VALUE_DOMAINS or to EXCLUDED_FROM_UNIVERSE with a reason.`
    );
  }
  return paths;
}

const deepEqual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Read a dotted path off a raw scheme. */
function readPath(raw, path) {
  const [head, tail] = path.split(".");
  return tail ? raw[head]?.[tail] : raw[head];
}

/** A raw scheme with one dotted path replaced. Never mutates the input. */
function withPath(raw, path, value) {
  const [head, tail] = path.split(".");
  if (!tail) return { ...raw, [head]: value };
  return { ...raw, [head]: { ...raw[head], [tail]: value } };
}

// ---------------------------------------------------------------------------
// The detection path — reconcile() minus the database.
// ---------------------------------------------------------------------------

/**
 * The two gates `reconcile()` applies, in the same order:
 *
 *   1. identical contentHash            -> NO_CHANGE (returns before diffing)
 *   2. hash differs but no field diffs  -> NO_CHANGE (hash rewritten, no version)
 *   3. otherwise                        -> UPDATED
 *
 * Both no-change routes are reported separately, because they fail for
 * different reasons and a fix for one does not fix the other: gate 1 means the
 * field is outside the hash, gate 2 means it is outside the diff.
 */
function detectChange(before, after) {
  if (before.contentHash === after.contentHash) {
    return { detected: false, route: "hash-identical", diffs: [] };
  }
  const diffs = diffFields(before, after);
  if (diffs.length === 0) {
    return { detected: false, route: "hash-differs-no-field-diff", diffs: [] };
  }
  return { detected: true, route: "updated", diffs };
}

// ---------------------------------------------------------------------------
// Does the impact agent's query actually reach the people who moved?
// ---------------------------------------------------------------------------

/**
 * A minimal evaluator for the query fragments `buildImpactQuery` produces, so
 * the candidate set can be checked against the users who really flipped.
 *
 * `completenessGuaranteed` alone is NOT enough. It is derived from the
 * selection MODE — targeted-band, full-scan and so on are all members of
 * COMPLETE_SELECTIONS — so a band that is genuinely too narrow still reports
 * complete. That flag records which mode was chosen; it cannot police whether
 * the mode was chosen correctly, and reading it as a soundness guarantee is
 * exactly the kind of self-referential check Phase V exists to replace.
 *
 * Mongo's missing-field semantics are reproduced deliberately: a comparison
 * operator does not match a document that lacks the field. A user with no age
 * is not in an age band — correctly, since under the matcher's strict flag they
 * fail an age rule before and after, so they cannot flip on it.
 *
 * Supports only the shapes the agent emits ($gt/$gte/$lt/$lte/$in, $or, {} and
 * the {_id:null} empty sentinel). An unrecognised shape throws rather than
 * quietly returning true, because a silent "yes, admitted" would turn this
 * check into the rubber stamp it is meant to replace.
 */
function candidateSetContains(filter, user) {
  if (filter === null || filter === undefined) return true; // scanAll
  const keys = Object.keys(filter);
  if (keys.length === 0) return true; // {} — full scan
  if (keys.length === 1 && keys[0] === "$or") {
    return filter.$or.some((f) => candidateSetContains(f, user));
  }
  return keys.every((key) => {
    if (key === "_id") return filter._id === user._id; // {_id:null} selects nobody
    if (!key.startsWith("profile.")) {
      throw new Error(`PHASE V: unrecognised candidate-filter path "${key}"`);
    }
    const value = user.profile?.[key.slice("profile.".length)];
    const cond = filter[key];
    if (cond === null || typeof cond !== "object") return value === cond;
    return Object.entries(cond).every(([op, operand]) => {
      if (op === "$in") {
        if (value === undefined || value === null) return false;
        return operand.some((v) => v === value);
      }
      if (value === undefined || value === null) return false;
      switch (op) {
        case "$gt": return value > operand;
        case "$gte": return value >= operand;
        case "$lt": return value < operand;
        case "$lte": return value <= operand;
        default:
          throw new Error(`PHASE V: unrecognised candidate-filter operator "${op}"`);
      }
    });
  });
}

// ---------------------------------------------------------------------------
// The experiment
// ---------------------------------------------------------------------------

const OUTCOME = Object.freeze({
  MISSED: "MISSED",
  MISCLASSIFIED: "MISCLASSIFIED",
  UNSOUND_BAND: "UNSOUND_BAND",
  INCOMPLETE_SELECTION: "INCOMPLETE_SELECTION",
  DETECTED_MATERIAL: "DETECTED_MATERIAL",
  DETECTED_IMMATERIAL: "DETECTED_IMMATERIAL",
  IGNORED_IMMATERIAL: "IGNORED_IMMATERIAL",
});

/** The four outcomes that are defects. Everything else is acceptable. */
const FAILING_OUTCOMES = Object.freeze([
  OUTCOME.MISSED,
  OUTCOME.MISCLASSIFIED,
  OUTCOME.UNSOUND_BAND,
  OUTCOME.INCOMPLETE_SELECTION,
]);

/**
 * The verdict for one mutation, as a pure function of the four facts.
 *
 * Extracted rather than left inline so it can be enumerated in the tests over
 * every combination of its inputs. An instrument whose own decision rule is
 * only ever exercised by the cases that happen to arise is exactly the position
 * Phase Q was in, and Phase U was created to get out of: the harness has to be
 * shown capable of reporting a failure, not assumed to be.
 *
 * Order matters. Detection is checked first because classification and
 * selection are both computed FROM the diffs, so neither exists when nothing
 * was detected — reporting MISCLASSIFIED for an undetected change would name
 * the wrong defect.
 */
function classifyOutcome({
  material,
  detected,
  userImpactExpected,
  completenessGuaranteed,
  usersOutsideCandidateSet = 0,
}) {
  if (material && !detected) return OUTCOME.MISSED;
  if (material && !userImpactExpected) return OUTCOME.MISCLASSIFIED;
  if (material && usersOutsideCandidateSet > 0) return OUTCOME.UNSOUND_BAND;
  if (material && !completenessGuaranteed) return OUTCOME.INCOMPLETE_SELECTION;
  if (material) return OUTCOME.DETECTED_MATERIAL;
  if (detected) return OUTCOME.DETECTED_IMMATERIAL;
  return OUTCOME.IGNORED_IMMATERIAL;
}

/**
 * Run the full field × value × base-scheme sweep.
 *
 * @param {Object}  [opts]
 * @param {Array}   [opts.population]  users; defaults to the enumerated oracle population
 * @param {Array}   [opts.bases]       base schemes; defaults to BASE_SCHEMES
 * @param {boolean} [opts.crossCheck]  also compare the independent oracle's verdicts
 *                                     against the production matcher (default true)
 */
function runDetectionCompleteness({ population, bases = BASE_SCHEMES, crossCheck = true } = {}) {
  const users = population || enumeratePopulation();
  const cases = [];
  const counts = Object.fromEntries(Object.values(OUTCOME).map((k) => [k, 0]));
  let oracleVsProductionCompared = 0;
  let oracleVsProductionDivergent = 0;

  for (const base of bases) {
    const before = normalize(base.raw, base.source);
    const universe = fieldUniverse(before);

    for (const field of universe) {
      const current = readPath(base.raw, field);
      for (const value of VALUE_DOMAINS[field]) {
        // A perturbation that does not change the source value is not a
        // change. Judged on the RAW value, so the detector's normalization has
        // no say in which cases exist.
        if (deepEqual(current, value)) continue;

        const afterRaw =
          field === "source" ? base.raw : withPath(base.raw, field, value);
        const afterSource = field === "source" ? value : base.source;
        const after = normalize(afterRaw, afterSource);

        const detection = detectChange(before, after);
        const materiality = assessMateriality(before, after, users);

        if (crossCheck) {
          for (const user of users) {
            for (const version of [before, after]) {
              const oracleSays = referenceEligibility(user, version).eligible;
              const productionSays = evaluateEligibility(user, version).eligible;
              oracleVsProductionCompared++;
              if (oracleSays !== productionSays) oracleVsProductionDivergent++;
            }
          }
        }

        let verdict = null;
        let selection = null;
        if (detection.detected) {
          verdict = classifyDeterministic(detection.diffs, { isNew: false });
          selection = buildImpactQuery(detection.diffs);
        }

        // Ground truth for the band: the users the oracle says actually moved.
        // Checked against the query the impact agent would really issue, so an
        // over-narrow band is caught by the people it drops rather than by the
        // label it gives itself.
        const outsiders = detection.detected
          ? materiality.flipped.filter((u) => !candidateSetContains(selection.filter, u))
          : [];

        const outcome = classifyOutcome({
          material: materiality.material,
          detected: detection.detected,
          userImpactExpected: !!verdict?.userImpactExpected,
          completenessGuaranteed: !!selection?.completenessGuaranteed,
          usersOutsideCandidateSet: outsiders.length,
        });
        counts[outcome]++;

        cases.push({
          base: base.label,
          field,
          from: current === undefined ? null : current,
          to: value,
          detected: detection.detected,
          route: detection.route,
          material: materiality.material,
          flips: materiality.flips,
          sampleFlip: materiality.sampleFlip,
          changeType: verdict?.changeType || null,
          severity: verdict?.severity || null,
          userImpactExpected: verdict ? verdict.userImpactExpected : null,
          candidateSelection: selection?.candidateSelection || null,
          completenessGuaranteed: selection ? selection.completenessGuaranteed : null,
          usersOutsideCandidateSet: outsiders.length,
          sampleOutsider: outsiders.length ? outsiders[0].profile : null,
          outcome,
        });
      }
    }
  }

  const failures = cases.filter((c) => FAILING_OUTCOMES.includes(c.outcome));

  return {
    status: failures.length === 0 ? "COMPLETE" : "INCOMPLETE",
    population: users.length,
    bases: bases.length,
    fieldsExercised: fieldUniverse(normalize(bases[0].raw, bases[0].source)).length,
    mutations: cases.length,
    counts,
    materialMutations: cases.filter((c) => c.material).length,
    failures,
    cases,
    crossCheck: crossCheck
      ? {
          compared: oracleVsProductionCompared,
          divergent: oracleVsProductionDivergent,
          status: oracleVsProductionDivergent === 0 ? "AGREE" : "DISAGREE",
        }
      : { status: "NOT RUN", compared: 0, divergent: 0 },
  };
}

module.exports = {
  runDetectionCompleteness,
  classifyOutcome,
  candidateSetContains,
  detectChange,
  fieldUniverse,
  withPath,
  readPath,
  BASE_SCHEMES,
  VALUE_DOMAINS,
  EXCLUDED_FROM_UNIVERSE,
  OUTCOME,
  FAILING_OUTCOMES,
  schemeIsOpen,
};
