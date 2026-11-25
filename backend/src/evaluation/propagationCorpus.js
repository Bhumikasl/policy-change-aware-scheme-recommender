/**
 * PHASE Q — the labelled corpus for the propagation-soundness experiment.
 *
 * ---------------------------------------------------------------------------
 * WHAT IS BEING MEASURED
 * ---------------------------------------------------------------------------
 * The project's central claim is that a government policy change is detected
 * and then propagated to exactly the users it affects. The propagation step is
 * only affordable because the Impact Agent does NOT re-score every user: it
 * derives a narrow candidate band from the diff and scans only that band.
 *
 * That optimisation carries the project's most serious failure mode, stated in
 * the architecture from the beginning:
 *
 *     A too-wide query is slow. A too-narrow query silently fails to tell
 *     someone they lost a benefit.
 *
 * Nothing in H-P measures whether the band is actually sound. The unit tests
 * assert the contract fields (`narrowingProven`, `completenessGuaranteed`); the
 * only published efficiency figure, 79.3%, is synthetic and structured-only and
 * measures NARROWING, not correctness. Phase Q measures correctness.
 *
 * ---------------------------------------------------------------------------
 * HOW A CASE IS LABELLED
 * ---------------------------------------------------------------------------
 * NOT by hand. A hand-written "expected affected users" list would be a second
 * implementation of the eligibility rules, it would drift, and every
 * disagreement would be ambiguous — is the pipeline wrong, or is the label?
 *
 * Ground truth is computed instead, by running the SAME Impact Agent over the
 * SAME population with the candidate filter removed. Every part of the
 * computation is shared except the one variable under test. See
 * propagationOracle.js.
 *
 * ---------------------------------------------------------------------------
 * THIS CORPUS IS SYNTHETIC
 * ---------------------------------------------------------------------------
 * The users are generated, not real, and the policy changes are constructed to
 * span the shapes the agent bands differently. Any figure computed from it is
 * a property of the ALGORITHM under a spread of change shapes. It is not a
 * measurement of Indian government policy, of a real user base, or of how often
 * these change shapes occur in practice. Every report this corpus feeds is
 * labelled SYNTHETIC for that reason.
 */

const STATES = ["Karnataka", "Kerala", "Tamil Nadu", "Maharashtra", "Bihar", "Assam"];
const OCCUPATIONS = ["Student", "Farmer", "Self-Employed", "Unemployed", "Salaried"];
// The CANONICAL ladder tokens from services/eligibilityLevels.js. Using
// near-miss spellings ("12th", "Postgraduate") makes every education rule fail
// closed and quietly turns the education cases into something else — which is
// exactly what the first run of this corpus did, and what the candidate-
// selection drift check caught.
const EDUCATION = ["10th Standard", "12th Standard", "Diploma", "Graduate", "Post Graduate"];
const GENDERS = ["Female", "Male"];
const CATEGORY_POOL = [[], ["SC"], ["ST"], ["OBC"], ["General"], ["SC", "BPL"], ["OBC", "BPL"]];

/**
 * A deterministic population.
 *
 * Deterministic because a run whose result moves between invocations cannot be
 * quoted, compared across a code change, or reproduced by a reader. The
 * generator is a plain integer walk rather than Math.random for exactly that
 * reason — no seed to record and no library to trust.
 *
 * The spread matters more than the size: incomes and ages are spaced so that
 * every band boundary the corpus exercises has users on both sides of it AND
 * users exactly on it. Off-by-one at a boundary is the most likely way a band
 * loses somebody, so the population is built to catch it.
 */
function makeUsers(count = 240) {
  const users = [];
  for (let i = 0; i < count; i++) {
    // Incomes step through 0..600000 so the 200000/250000/300000 caps used by
    // the cases all fall inside the population, boundaries included.
    const annualIncome = (i % 61) * 10000;
    const age = 16 + (i % 45); // 16..60, spanning every age band used below
    users.push({
      _id: `q-user-${String(i).padStart(4, "0")}`,
      email: `q${i}@example.invalid`,
      name: `Corpus User ${i}`,
      role: "USER",
      profile: {
        age,
        annualIncome,
        education: EDUCATION[i % EDUCATION.length],
        state: STATES[i % STATES.length],
        occupation: OCCUPATIONS[i % OCCUPATIONS.length],
        gender: GENDERS[i % GENDERS.length],
        categories: CATEGORY_POOL[i % CATEGORY_POOL.length],
        marksPercentage: 40 + (i % 61),
        documentsAvailable: i % 3 === 0 ? ["Aadhaar"] : ["Aadhaar", "Income Certificate"],
      },
    });
  }
  return users;
}

const baseRules = (over = {}) => ({
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
  eligibilityType: "constrained",
  source: "structured",
  confidence: 0.9,
  needsReview: false,
  ...over,
});

const scheme = (over = {}) => ({
  schemeId: "q-scheme",
  name: "Corpus Scheme",
  description: "A scheme used only by the Phase Q propagation experiment.",
  benefits: "financial assistance of Rs 25000 per year",
  documents: ["Aadhaar"],
  status: "active",
  ministry: "Ministry of Testing",
  state: "",
  category: ["Education"],
  version: 2,
  ...over,
});

/**
 * The change shapes.
 *
 * Chosen to span how `deriveCandidateFilter` treats a diff, NOT to flatter the
 * result: cases that force a full scan and cases where narrowing is refused
 * are included deliberately, because a corpus of only the easy shapes would
 * report a soundness figure that means nothing.
 *
 * `expectedSelection` records what the agent SHOULD choose. It is an assertion
 * about the agent's own contract, checked by the harness — it is not used to
 * decide who was affected, which is always computed by the oracle.
 */
const CASES = [
  {
    id: "income-cap-raised",
    label: "Income ceiling raised 2.0L -> 3.0L",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ maxAnnualIncome: 200000 }),
    newRules: baseRules({ maxAnnualIncome: 300000 }),
  },
  {
    id: "income-cap-lowered",
    label: "Income ceiling lowered 3.0L -> 2.0L",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ maxAnnualIncome: 300000 }),
    newRules: baseRules({ maxAnnualIncome: 200000 }),
  },
  {
    id: "income-cap-introduced",
    label: "Income ceiling introduced where there was none",
    // No prior boundary exists, so no band can be proven sound. The agent must
    // fall back to a full scan; a band here would be the exact silent-miss bug.
    expectedSelection: "full-scan",
    // An age ceiling is carried, UNCHANGED, on both sides. Without it the
    // "before" rules were empty while still declaring `constrained`, so
    // matcher.js found no positive match and every user was ineligible
    // beforehand — turning "a cap is introduced and some people lose out" into
    // "everyone becomes newly eligible", which is the opposite change.
    // It is identical on both sides, so it produces no diff and the candidate
    // selection is still driven only by the introduced income cap.
    oldRules: baseRules({ maxAnnualIncome: null, maxAge: 60 }),
    newRules: baseRules({ maxAnnualIncome: 250000, maxAge: 60 }),
  },
  {
    id: "age-ceiling-raised",
    label: "Age ceiling raised 25 -> 35",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ maxAge: 25 }),
    newRules: baseRules({ maxAge: 35 }),
  },
  {
    id: "age-floor-raised",
    label: "Minimum age raised 18 -> 21",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ minAge: 18 }),
    newRules: baseRules({ minAge: 21 }),
  },
  {
    id: "state-list-extended",
    label: "Two states added to the eligible list",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ states: ["Karnataka", "Kerala"] }),
    newRules: baseRules({ states: ["Karnataka", "Kerala", "Bihar", "Assam"] }),
  },
  {
    id: "state-list-reduced",
    label: "One state removed from the eligible list",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ states: ["Karnataka", "Kerala", "Bihar"] }),
    newRules: baseRules({ states: ["Karnataka", "Kerala"] }),
  },
  {
    id: "gender-restriction-lifted",
    label: "Gender restriction removed, income ceiling retained",
    // Becoming unrestricted has no symmetric difference to band on, so the
    // agent must widen to a full scan.
    //
    // The income ceiling is retained on BOTH sides deliberately. An earlier
    // version of this case lifted the ONLY constraint, leaving a rules object
    // with nothing in it while still declaring `eligibilityType: "constrained"`
    // — and `matcher.js` requires a constrained scheme to produce at least one
    // POSITIVE match, so every user became ineligible and the case silently
    // measured the opposite of what it claimed to. A real extractor would label
    // a scheme with no constraints `universal`; a constrained scheme always has
    // something left to satisfy.
    expectedSelection: "full-scan",
    oldRules: baseRules({ genders: ["Female"], maxAnnualIncome: 300000 }),
    newRules: baseRules({ genders: [], maxAnnualIncome: 300000 }),
  },
  {
    id: "occupation-swapped",
    label: "Occupation list swapped",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ occupations: ["Student", "Farmer"] }),
    newRules: baseRules({ occupations: ["Student", "Salaried"] }),
  },
  {
    id: "education-floor-raised",
    label: "Minimum education raised 12th Standard -> Graduate",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ minEducationLevel: "12th Standard" }),
    newRules: baseRules({ minEducationLevel: "Graduate" }),
  },
  {
    id: "education-unknown-rung",
    label: "Minimum education names a level outside the known ladder",
    // The fail-safe. An unmappable rung cannot be banded soundly, so the agent
    // must widen to a full scan rather than guess a range. Included because a
    // corpus of only the well-formed shapes would never exercise it.
    expectedSelection: "full-scan",
    oldRules: baseRules({ minEducationLevel: "12th Standard" }),
    newRules: baseRules({ minEducationLevel: "Senior Secondary" }),
  },
  {
    id: "category-restructured",
    label: "Category groups restructured",
    // AND-of-OR groups: a user holding a category present in BOTH lists can
    // still flip, so there is no sound narrow query. Full scan is correct.
    expectedSelection: "full-scan",
    oldRules: baseRules({ categories: ["SC", "ST"] }),
    newRules: baseRules({ categoryGroups: [["SC", "ST"], ["BPL"]] }),
  },
  {
    id: "income-and-age-together",
    label: "Income ceiling AND age ceiling both moved",
    expectedSelection: "targeted-union",
    oldRules: baseRules({ maxAnnualIncome: 200000, maxAge: 25 }),
    newRules: baseRules({ maxAnnualIncome: 300000, maxAge: 35 }),
  },
  {
    id: "marks-floor-lowered",
    label: "Minimum marks lowered 60 -> 50",
    expectedSelection: "targeted-band",
    oldRules: baseRules({ minMarksPercentage: 60 }),
    newRules: baseRules({ minMarksPercentage: 50 }),
  },
  {
    id: "scheme-closed",
    label: "Scheme closed while its rules stayed identical",
    // Everyone eligible must be told they lost it. The rules did not move, so
    // the diff carries only `status` and no band can be derived from it.
    expectedSelection: "full-scan",
    oldRules: baseRules({ maxAnnualIncome: 300000 }),
    newRules: baseRules({ maxAnnualIncome: 300000 }),
    oldStatus: "active",
    newStatus: "closed",
  },
  {
    id: "no-material-change",
    label: "Ministry renamed; no rule moved",
    // The cheap path. Nobody should be scanned at all.
    expectedSelection: "none",
    oldRules: baseRules({ maxAnnualIncome: 250000 }),
    newRules: baseRules({ maxAnnualIncome: 250000 }),
  },
];

/**
 * Build the diff list the pipeline would have produced for a case.
 *
 * The comparator produces these in production. Constructing them here keeps the
 * corpus independent of collector plumbing, and the SHAPE is the comparator's:
 * `{ field, oldValue, newValue }` with dotted `eligibilityRules.*` paths.
 */
function diffsFor(kase) {
  const diffs = [];
  const keys = new Set([...Object.keys(kase.oldRules), ...Object.keys(kase.newRules)]);
  for (const key of keys) {
    const oldValue = kase.oldRules[key];
    const newValue = kase.newRules[key];
    if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
    // Bookkeeping fields are not eligibility rules and never drive a band.
    if (["source", "confidence", "needsReview", "eligibilityType"].includes(key)) continue;
    diffs.push({ field: `eligibilityRules.${key}`, oldValue, newValue });
  }
  if (kase.oldStatus && kase.newStatus && kase.oldStatus !== kase.newStatus) {
    diffs.push({ field: "status", oldValue: kase.oldStatus, newValue: kase.newStatus });
  }
  return diffs;
}

/** Everything one case needs to be run, assembled in one place. */
function buildCase(kase) {
  return {
    ...kase,
    diffs: diffsFor(kase),
    schemeAfter: scheme({
      status: kase.newStatus || "active",
      eligibilityRules: kase.newRules,
    }),
    oldSchemeSnapshot: scheme({
      version: 1,
      status: kase.oldStatus || "active",
      eligibilityRules: kase.oldRules,
    }),
  };
}

const buildCorpus = () => CASES.map(buildCase);

module.exports = {
  makeUsers,
  buildCorpus,
  buildCase,
  diffsFor,
  baseRules,
  scheme,
  CASES,
  PROVENANCE: "SYNTHETIC",
};
