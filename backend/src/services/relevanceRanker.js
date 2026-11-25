/**
 * Relevance ranking — the missing stage between "eligible" and "recommended".
 *
 * THE PROBLEM THIS SOLVES
 *
 * The eligibility gate answers "CAN this person apply?". For a broad profile
 * (Female + Student + OBC + BPL + Graduate + a state) that can legitimately
 * be 150-650 schemes. All of them are *eligible*. Almost none of them are
 * what the user actually wants to see first.
 *
 * Eligibility is a FILTER. Relevance is a RANKING. They are different
 * questions and the old `score` (count of matched rules) conflated them:
 * it measured "how many of the scheme's constraints did we verify" — which
 * rewards schemes that happen to specify many fields, not schemes that fit
 * this user well.
 *
 * WHAT THIS SCORES INSTEAD
 *
 *   1. SPECIFICITY  — a scheme that targets exactly this user's niche beats
 *      a scheme open to everyone. "Karnataka SC widow farmers" is a stronger
 *      signal for a Karnataka SC widow farmer than "all Indian citizens".
 *      We approximate targeting strength by how many constraints the scheme
 *      declares (more constraints = narrower audience = higher intent match
 *      WHEN the user satisfies them).
 *
 *   2. LEXICAL OVERLAP (BM25-lite) — how much of the user's profile
 *      vocabulary appears in the scheme's name/description/eligibility text.
 *      A "Student" gets scholarship/education/fellowship schemes ranked above
 *      a generic savings account they also happen to qualify for. Uses IDF
 *      weighting so common words ("scheme", "India", "government") don't
 *      dominate — computed once per corpus, cached.
 *
 *   3. INTENT MATCH — optional free-text intent from the user ("I want
 *      scholarships for B.Tech"). Terms from the intent are weighted 2x
 *      because an explicit ask beats an inferred one.
 *
 *   4. BENEFIT CONCRETENESS — a scheme with a stated rupee amount or a
 *      named benefit is more actionable than one whose benefit is a
 *      certificate/medal. Small bonus; awards rank below cash/loan/
 *      scholarship schemes for a typical welfare-seeking user.
 *
 *   5. DOCUMENT READINESS — if the user already holds most of the required
 *      documents, they can act on it today. Small bonus.
 *
 *   6. FRESHNESS / DEADLINE — a scheme with an upcoming deadline is more
 *      urgent; a stale one ranks slightly lower.
 *
 * Deliberately NOT used: the LLM. Ranking thousands of schemes with an LLM
 * is exactly the anti-pattern the reviewer flagged. The LLM verifies a small
 * top-K AFTER this ranking narrows the field.
 *
 * No external dependencies — BM25 IDF is computed from the candidate set
 * itself, so this works offline and adds ~2ms for a few hundred candidates.
 */

// Words that carry no discriminating signal in an Indian scheme corpus.
const STOPWORDS = new Set([
  "the", "a", "an", "of", "for", "to", "in", "and", "or", "is", "are", "be",
  "this", "that", "with", "by", "on", "at", "as", "from", "will", "shall",
  "scheme", "schemes", "government", "govt", "india", "indian", "applicant",
  "beneficiary", "under", "provided", "provide", "should", "must", "may",
  "any", "all", "not", "no", "per", "year", "years", "rs", "inr",
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9\s/-]/g, " ")
    .split(/[\s/-]+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/**
 * Expand a user profile into the vocabulary of things they'd plausibly
 * search for. This is the "intent inference" step: a Student doesn't just
 * match the literal word "student", they match scholarship / fellowship /
 * education / tuition / stipend.
 */
const OCCUPATION_EXPANSIONS = {
  student: ["scholarship", "education", "fellowship", "tuition", "stipend", "study", "academic", "college", "school", "merit"],
  farmer: ["agriculture", "crop", "kisan", "irrigation", "seed", "fertilizer", "farming", "cultivation", "livestock"],
  entrepreneur: ["startup", "business", "enterprise", "loan", "credit", "venture", "msme", "industry"],
  "self-employed": ["loan", "credit", "business", "enterprise", "skill", "msme"],
  unemployed: ["employment", "skill", "training", "allowance", "job", "placement"],
  homemaker: ["women", "mahila", "self-help", "shg", "income"],
  retired: ["pension", "senior", "elderly", "annuity"],
  "salaried employee": ["insurance", "savings", "pension", "housing", "provident"],
  "artisan / weaver": ["handloom", "handicraft", "artisan", "weaver", "craft"],
  fisherman: ["fisheries", "fishing", "boat", "aquaculture", "marine"],
  // Construction workers have dedicated BOCW welfare schemes.
  "construction worker": ["bocw", "construction", "labour", "worker", "welfare", "housing", "provident", "building"],
};

const CATEGORY_EXPANSIONS = {
  sc: ["scheduled", "caste", "dalit", "social", "welfare", "empowerment"],
  st: ["scheduled", "tribe", "tribal", "adivasi", "welfare"],
  obc: ["backward", "class", "welfare", "empowerment"],
  bpl: ["poverty", "poor", "subsidy", "ration", "welfare", "assistance"],
  ews: ["economically", "weaker", "poor", "subsidy", "assistance"],
  // Frontend compound label — same expansions as "bpl" and "ews" combined.
  "bpl / economically weaker": ["poverty", "poor", "subsidy", "ration", "welfare", "assistance", "economically", "weaker"],
  minority: ["minority", "welfare", "empowerment"],
  woman: ["women", "mahila", "girl", "female", "empowerment", "maternity"],
  widow: ["widow", "pension", "assistance", "destitute"],
  "person with disability": ["disability", "divyang", "handicapped", "assistive", "rehabilitation"],
  "senior citizen": ["senior", "elderly", "pension", "old", "age"],
  "ex-servicemen": ["ex-servicemen", "veteran", "defence", "army"],
  // Categories offered on the frontend form but previously missing from expansions.
  "migrant worker": ["migrant", "labour", "worker", "welfare", "assistance"],
  "single parent": ["single", "parent", "widow", "assistance", "welfare"],
};

const EDUCATION_EXPANSIONS = {
  "10th standard": ["matric", "secondary", "school"],
  "12th standard": ["intermediate", "higher", "secondary", "pre-matric", "post-matric"],
  diploma: ["diploma", "polytechnic", "technical", "vocational"],
  graduate: ["degree", "graduate", "college", "university", "bachelor", "undergraduate"],
  "post graduate": ["postgraduate", "masters", "research", "phd", "doctoral"],
  doctorate: ["phd", "doctoral", "research", "fellowship", "postdoc"],
};

/**
 * Build the weighted query vector from a user's profile + optional free-text
 * intent. Returns a Map of term -> weight.
 *
 *   Direct profile facts  weight 1.0   (state, gender, occupation, …)
 *   Expansions            weight 0.6   (INFERRED — "Student" implies
 *                                       "scholarship". A guess, not a fact.)
 *   Explicit intent terms weight 2.5   (the user TOLD us what they want)
 *
 * STATED INTENT SUPPRESSES INFERRED INTENT.
 *
 * The expansions exist to guess what a user probably wants when they
 * haven't said. The moment they DO say ("I need a business loan"), those
 * guesses become noise that fights the stated ask — a Student who wants a
 * loan would still get scholarships ranked top because "student → scholarship,
 * education, tuition, stipend" contributes 10 inferred terms against the
 * handful in their sentence.
 *
 * So when an intent is supplied we damp the expansion weight hard
 * (INFERRED_WEIGHT_WITH_INTENT). Direct profile facts keep full weight —
 * a Karnataka user asking for a loan still wants KARNATAKA loans — but the
 * inferred topical vocabulary steps aside for what they actually said.
 */
const INFERRED_WEIGHT = 0.6;
const INFERRED_WEIGHT_WITH_INTENT = 0.15;
const STATED_INTENT_WEIGHT = 2.5;

function buildUserQuery(user, intent = "") {
  const p = user?.profile || {};
  const q = new Map();
  const add = (term, w) => {
    if (!term) return;
    const t = String(term).toLowerCase().trim();
    if (t.length < 3 || STOPWORDS.has(t)) return;
    q.set(t, Math.max(q.get(t) || 0, w));
  };
  const addAll = (arr, w) => (arr || []).forEach((x) => add(x, w));

  const intentTerms = tokenize(intent);
  const hasIntent = intentTerms.length > 0;
  const inferredWeight = hasIntent ? INFERRED_WEIGHT_WITH_INTENT : INFERRED_WEIGHT;

  // --- direct facts: always full weight, they're stated attributes ---
  add(p.state, 1.0);
  tokenize(p.state).forEach((t) => add(t, 1.0));
  add(p.gender, 1.0);
  add(p.occupation, 1.0);
  tokenize(p.occupation).forEach((t) => add(t, 1.0));
  add(p.education, 1.0);
  tokenize(p.education).forEach((t) => add(t, 1.0));
  add(p.course, 1.0);
  tokenize(p.course).forEach((t) => add(t, 1.0));
  (p.categories || []).forEach((c) => {
    add(c, 1.0);
    tokenize(c).forEach((t) => add(t, 1.0));
  });

  // --- expansions: inferred, damped when the user stated an intent ---
  const occ = (p.occupation || "").toLowerCase();
  addAll(OCCUPATION_EXPANSIONS[occ], inferredWeight);
  for (const c of p.categories || []) {
    const cLower = String(c).toLowerCase();
    addAll(CATEGORY_EXPANSIONS[cLower], inferredWeight);
    // Also expand through aliases: "BPL / Economically Weaker" → also apply
    // "bpl" and "ews" expansions so the full vocabulary is covered.
    if (cLower === "bpl / economically weaker") {
      addAll(CATEGORY_EXPANSIONS["bpl"], inferredWeight);
      addAll(CATEGORY_EXPANSIONS["ews"], inferredWeight);
    }
  }
  addAll(EDUCATION_EXPANSIONS[(p.education || "").toLowerCase()], inferredWeight);
  if ((p.gender || "").toLowerCase() === "female") {
    addAll(CATEGORY_EXPANSIONS.woman, inferredWeight);
  }

  // --- explicit user intent: highest weight, applied last so it wins
  //     the Math.max even against a same-term direct fact ---
  for (const t of intentTerms) add(t, STATED_INTENT_WEIGHT);

  return q;
}

/**
 * Build the searchable document text for a scheme, weighting the fields by
 * how much signal they carry. Name and tags are the strongest indicators of
 * what a scheme IS; eligibility text describes who it's for.
 */
function schemeDocTerms(scheme) {
  const terms = new Map();
  const bump = (text, w) => {
    for (const t of tokenize(text)) terms.set(t, (terms.get(t) || 0) + w);
  };
  bump(scheme.name, 3.0);
  bump((scheme.tags || []).join(" "), 2.5);
  // [].concat handles both shapes: the model declares category as [String],
  // but a lean() POJO or a fixture can carry a bare string, and .join would
  // throw on that. Defensive because propagation feeds this lean documents.
  bump([].concat(scheme.category || []).join(" "), 2.0);
  bump(scheme.description, 1.0);
  bump(scheme.eligibility, 1.0);
  bump(scheme.benefits, 0.5);
  return terms;
}

/**
 * IDF over the candidate set: a term appearing in every scheme carries no
 * discriminating power. Cached per (corpus size + first/last schemeId) so
 * repeated /matches calls for the same corpus don't recompute.
 */
let idfCache = { key: null, idf: null };
function computeIdf(candidates) {
  const key = `${candidates.length}:${candidates[0]?.schemeId}:${candidates[candidates.length - 1]?.schemeId}`;
  if (idfCache.key === key) return idfCache.idf;

  const df = new Map();
  for (const c of candidates) {
    const seen = new Set(schemeDocTerms(c.scheme || c).keys());
    for (const t of seen) df.set(t, (df.get(t) || 0) + 1);
  }
  const N = candidates.length || 1;
  const idf = new Map();
  for (const [t, d] of df) {
    // Standard BM25 IDF with the +0.5 smoothing that keeps it positive.
    idf.set(t, Math.log(1 + (N - d + 0.5) / (d + 0.5)));
  }
  idfCache = { key, idf };
  return idf;
}

/**
 * How narrowly does this scheme target? A scheme declaring 4 constraints is
 * aimed at a much smaller audience than one declaring 1. When the user
 * SATISFIES those constraints, the narrow scheme is a stronger recommendation.
 */
function specificityScore(rules) {
  if (!rules) return 0;
  let n = 0;
  if (rules.minAge != null || rules.maxAge != null) n += 1;
  if (rules.minAnnualIncome != null || rules.maxAnnualIncome != null) n += 1;
  if (rules.minMarksPercentage != null) n += 1;
  if (rules.minEducationLevel) n += 1;
  if ((rules.genders || []).length) n += 1;
  if ((rules.categoryGroups || []).length || (rules.categories || []).length) n += 1;
  if ((rules.occupations || []).length) n += 1;
  if ((rules.states || []).length) n += 1;
  return n;
}

// A scheme that pays money is more actionable than one that gives a medal.
const CONCRETE_BENEFIT_RE = /₹|rs\.?\s*\d|lakh|crore|per\s+month|per\s+annum|stipend|scholarship|subsidy|loan|pension|allowance|reimburse/i;
const AWARD_ONLY_RE = /\b(award|medal|certificate|memento|trophy|citation|honour|honor|recognition)\b/i;

function benefitScore(scheme) {
  const text = `${scheme.benefits || ""} ${scheme.name || ""}`;
  let s = 0;
  if (CONCRETE_BENEFIT_RE.test(text)) s += 1.0;
  // Awards/medals are legitimate schemes but rarely what a welfare-seeking
  // user is looking for — demote unless they also carry cash.
  if (AWARD_ONLY_RE.test(scheme.name || "") && !CONCRETE_BENEFIT_RE.test(scheme.benefits || "")) {
    s -= 1.5;
  }
  return s;
}

function deadlineScore(scheme) {
  if (!scheme.lastDate) return 0;
  const d = new Date(scheme.lastDate);
  if (Number.isNaN(d.getTime())) return 0;
  const daysLeft = (d.getTime() - Date.now()) / 86400000;
  if (daysLeft < 0) return -2;          // already closed
  if (daysLeft < 30) return 1.0;        // urgent — surface it
  if (daysLeft < 90) return 0.5;
  return 0;
}

/**
 * Score one eligible candidate for relevance to this user.
 *
 * @param {Object} candidate  { scheme, verdict } from the eligibility gate
 * @param {Map} userQuery     term -> weight, from buildUserQuery
 * @param {Map} idf           term -> idf, from computeIdf
 * @param {Object} user
 * @returns {Object} { relevance, breakdown }
 */
function scoreCandidate(candidate, userQuery, idf, user) {
  const scheme = candidate.scheme;
  const verdict = candidate.verdict;
  const rules = scheme.eligibilityRules || {};

  // ---- 1. lexical overlap (BM25-lite) ----
  const docTerms = schemeDocTerms(scheme);
  const docLen = [...docTerms.values()].reduce((a, b) => a + b, 0) || 1;
  let lexical = 0;
  for (const [term, qWeight] of userQuery) {
    const tf = docTerms.get(term);
    if (!tf) continue;
    const termIdf = idf.get(term) ?? 1;
    // BM25 saturation: k1=1.2 so a 10th occurrence adds far less than the 2nd.
    const saturated = (tf * 2.2) / (tf + 1.2 * (0.25 + 0.75 * (docLen / 400)));
    lexical += qWeight * termIdf * saturated;
  }
  // Normalize into a comparable band. Empirically lexical lands 0-15.
  lexical = Math.min(lexical, 15);

  // ---- 2. specificity: narrow scheme the user satisfies ----
  const specificity = specificityScore(rules);
  const positives = (verdict?.positiveMatches || []).length;
  // Only reward specificity that the user ACTUALLY satisfied. A scheme with
  // 5 constraints where the user matched 1 (and 4 were "no constraint")
  // isn't narrow-and-fitting, it's broad.
  const satisfiedSpecificity = Math.min(positives, specificity);

  // ---- 3. universal penalty ----
  // Universal schemes are eligible for everyone, so they carry the least
  // personalization signal. Keep them, rank them below targeted matches.
  const universalPenalty = rules.eligibilityType === "universal" ? -2.0 : 0;

  // ---- 4. benefit concreteness ----
  const benefit = benefitScore(scheme);

  // ---- 5. document readiness ----
  const dr = candidate.documentReadiness;
  let docs = 0;
  if (dr && dr.required > 0) {
    docs = (dr.have / dr.required) * 1.5;  // 0 .. 1.5
  }

  // ---- 6. deadline urgency ----
  const deadline = deadlineScore(scheme);

  // ---- 7. rule confidence ----
  // A match derived from low-confidence extraction is less trustworthy.
  const confidence = (rules.confidence ?? 0.3) * 2.0;  // 0 .. ~1.8

  const relevance =
    lexical * 1.0 +
    satisfiedSpecificity * 1.5 +
    universalPenalty +
    benefit +
    docs +
    deadline +
    confidence;

  return {
    relevance: Math.round(relevance * 100) / 100,
    breakdown: {
      lexical: Math.round(lexical * 100) / 100,
      specificity: satisfiedSpecificity,
      universalPenalty,
      benefit,
      documents: Math.round(docs * 100) / 100,
      deadline,
      confidence: Math.round(confidence * 100) / 100,
    },
  };
}

/**
 * Rank an eligible candidate set by relevance to this user.
 *
 * @param {Array} candidates  [{ scheme, verdict, documentReadiness }]
 * @param {Object} user
 * @param {Object} opts
 * @param {string} [opts.intent]  free-text "what are you looking for"
 * @returns {Array} same shape plus { relevance, relevanceBreakdown }, sorted desc
 */
function rankCandidates(candidates, user, { intent = "" } = {}) {
  if (!candidates.length) return [];
  const userQuery = buildUserQuery(user, intent);
  const idf = computeIdf(candidates);

  const scored = candidates.map((c) => {
    const { relevance, breakdown } = scoreCandidate(c, userQuery, idf, user);
    return { ...c, relevance, relevanceBreakdown: breakdown };
  });

  scored.sort((a, b) => {
    if (b.relevance !== a.relevance) return b.relevance - a.relevance;
    // Tie-break on the eligibility score (more verified rules wins).
    const byScore = (b.verdict?.score || 0) - (a.verdict?.score || 0);
    if (byScore !== 0) return byScore;

    // PHASE T — the FINAL tie-break, and it is not cosmetic.
    //
    // With only the two keys above, two schemes tying on both fell through to
    // whatever order the array arrived in. `Array.prototype.sort` is stable, so
    // that order is the CALLER's order — which comes from an unsorted
    // `Scheme.find()`. MongoDB gives no stability guarantee for an unsorted
    // query, so the same two schemes could come back a,b on one cycle and b,a
    // on the next.
    //
    // The consequence was not a cosmetic reshuffle. A swap moves a scheme from
    // rank 1 to rank 2, `classifyRecommendationTransition` reads that as
    // RANK_DECREASED, the Notification Agent returns shouldNotify: true, and
    // the user is emailed "<Scheme> moved down your recommendations" — for a
    // change that never happened. It also writes a RecommendationHistory row
    // asserting a movement, which puts a false entry in the audit trail the
    // whole project treats as evidence.
    //
    // `schemeId` is unique, stable across cycles, and never null, so appending
    // it makes the comparator a TOTAL order: the result now depends only on the
    // SET of candidates, never on the order they were handed in. It cannot
    // affect any pair whose relevance or eligibility score differ, so no
    // existing ranking moves.
    return String(a.scheme?.schemeId || "").localeCompare(String(b.scheme?.schemeId || ""));
  });

  return scored;
}

function _clearIdfCache() { idfCache = { key: null, idf: null }; }

module.exports = {
  rankCandidates,
  buildUserQuery,
  schemeDocTerms,
  specificityScore,
  benefitScore,
  tokenize,
  _clearIdfCache,
};
