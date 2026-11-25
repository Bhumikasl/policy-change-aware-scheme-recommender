const { generateStructured } = require("../services/llmClient");
const { EDUCATION_RANK } = require("../services/eligibilityLevels");
const logger = require("../utils/logger");

/**
 * AGENT 1 — POLICY CHANGE AGENT
 *
 * Question it answers: *what kind of change just happened, and does it matter?*
 *
 * Input : the field-level diff produced by services/comparator.js, plus the
 *         old and new eligibilityRules.
 * Output: a strict JSON verdict — changeType, severity, affectedAttributes,
 *         per-dimension impact flags, confidence, evidence.
 *
 * DESIGN RULE: deterministic first, LLM only for genuine ambiguity.
 *
 * A diff on `eligibilityRules.maxAnnualIncome` from 250000 to 300000 is an
 * ELIGIBILITY change of HIGH severity. That is a *fact about which field
 * moved*, not a matter of interpretation, and asking a language model to
 * restate it would be slower, costlier, non-deterministic and no more correct.
 * The LLM is reserved for the cases the field map genuinely cannot settle —
 * chiefly free-text `eligibility` prose, where "clarified wording" and
 * "silently narrowed who qualifies" look identical at the field level.
 *
 * Everything here is pure and synchronous except the optional LLM escalation,
 * so the whole classifier is unit-testable with no network.
 */

const CHANGE_TYPES = Object.freeze({
  ELIGIBILITY: "ELIGIBILITY",
  BENEFIT: "BENEFIT",
  DEADLINE: "DEADLINE",
  DOCUMENT: "DOCUMENT",
  STATUS: "STATUS",
  ADMINISTRATIVE: "ADMINISTRATIVE",
  COSMETIC: "COSMETIC",
  NEW_SCHEME: "NEW_SCHEME",
});

const SEVERITY = Object.freeze({ LOW: "LOW", MEDIUM: "MEDIUM", HIGH: "HIGH", CRITICAL: "CRITICAL" });
const SEVERITY_ORDER = [SEVERITY.LOW, SEVERITY.MEDIUM, SEVERITY.HIGH, SEVERITY.CRITICAL];
const maxSeverity = (a, b) =>
  SEVERITY_ORDER.indexOf(a) >= SEVERITY_ORDER.indexOf(b) ? a : b;

/**
 * The field map. Each entry states what a change to that field MEANS.
 *
 * `severity` here is the baseline; `escalate()` can raise it once the actual
 * direction of the change is known (e.g. a *tightened* income cap removes
 * people's entitlements and is worse than a loosened one).
 */
const FIELD_MAP = {
  // ---- eligibility-bearing structured rules ----
  "eligibilityRules.maxAnnualIncome": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "income", eligibility: true },
  "eligibilityRules.minAnnualIncome": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "income", eligibility: true },
  "eligibilityRules.minAge": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "age", eligibility: true },
  "eligibilityRules.maxAge": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "age", eligibility: true },
  "eligibilityRules.minMarksPercentage": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.MEDIUM, attr: "marks", eligibility: true },
  "eligibilityRules.minEducationLevel": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "education", eligibility: true },
  "eligibilityRules.maxEducationLevel": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "education", eligibility: true },
  "eligibilityRules.courses": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "course", eligibility: true },
  "eligibilityRules.disabilityRequired": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "disability", eligibility: true },
  "eligibilityRules.minDisabilityPercentage": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "disability", eligibility: true },
  "eligibilityRules.singleGirlChildRequired": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "singleGirlChild", eligibility: true },
  "eligibilityRules.genders": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "gender", eligibility: true },
  "eligibilityRules.categories": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "category", eligibility: true },
  "eligibilityRules.categoryGroups": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "category", eligibility: true },
  "eligibilityRules.occupations": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "occupation", eligibility: true },
  "eligibilityRules.applicantTypes": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "applicantType", eligibility: true },
  "eligibilityRules.states": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "state", eligibility: true },
  // PHASE V. The branch matcher.js takes before it reads any rule. Reclassifying
  // a scheme between unknown/constrained/universal can flip every user's verdict
  // with no threshold moving, so this is an ELIGIBILITY change like any other —
  // and HIGH baseline, escalated to CRITICAL by the NARROWED rule below when
  // people lose standing.
  "eligibilityRules.eligibilityType": { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.HIGH, attr: "eligibilityType", eligibility: true },

  // ---- other dimensions ----
  benefits: { type: CHANGE_TYPES.BENEFIT, severity: SEVERITY.MEDIUM, attr: "benefits", benefit: true },
  lastDate: { type: CHANGE_TYPES.DEADLINE, severity: SEVERITY.HIGH, attr: "deadline", deadline: true },
  documents: { type: CHANGE_TYPES.DOCUMENT, severity: SEVERITY.MEDIUM, attr: "documents", document: true },
  status: { type: CHANGE_TYPES.STATUS, severity: SEVERITY.CRITICAL, attr: "status", eligibility: true },
  applicationLink: { type: CHANGE_TYPES.ADMINISTRATIVE, severity: SEVERITY.LOW, attr: "applicationLink" },
  ministry: { type: CHANGE_TYPES.ADMINISTRATIVE, severity: SEVERITY.LOW, attr: "ministry" },
  state: { type: CHANGE_TYPES.ADMINISTRATIVE, severity: SEVERITY.LOW, attr: "state" },
  category: { type: CHANGE_TYPES.ADMINISTRATIVE, severity: SEVERITY.LOW, attr: "category" },
  tags: { type: CHANGE_TYPES.COSMETIC, severity: SEVERITY.LOW, attr: "tags" },
  name: { type: CHANGE_TYPES.COSMETIC, severity: SEVERITY.LOW, attr: "name" },

  // Free-text prose. Genuinely ambiguous — the LLM escalation target.
  description: { type: CHANGE_TYPES.COSMETIC, severity: SEVERITY.LOW, attr: "description", ambiguous: true },
  eligibility: { type: CHANGE_TYPES.ELIGIBILITY, severity: SEVERITY.MEDIUM, attr: "eligibilityText", eligibility: true, ambiguous: true },
};

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const arr = (v) => (Array.isArray(v) ? v : []);

/**
 * Compare whitespace/punctuation-insensitively so a reflowed paragraph or a
 * changed bullet character is recognised as cosmetic rather than substantive.
 */
function normalizeProse(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/[\s ]+/g, " ")
    .replace(/[.,;:!?'"()\[\]{}\-–—*_#>]/g, "")
    .trim();
}

/**
 * Direction of a single field change, used to refine severity and to explain
 * the change to a human later.
 *
 * BROADENED — strictly more people qualify (cap raised, floor lowered,
 *             an option added to an allow-list).
 * NARROWED  — strictly fewer qualify. Worse: it can *remove* an entitlement
 *             someone already had, so it escalates to CRITICAL.
 */
function classifyDirection(field, oldValue, newValue) {
  const meta = FIELD_MAP[field];
  if (!meta) return "CHANGED";

  // Upper bounds: raising the ceiling lets more people in.
  if (field === "eligibilityRules.maxAnnualIncome" || field === "eligibilityRules.maxAge") {
    const o = num(oldValue);
    const n = num(newValue);
    if (o === null && n !== null) return "NARROWED"; // a cap appeared
    if (o !== null && n === null) return "BROADENED"; // a cap was removed
    if (o !== null && n !== null) return n > o ? "BROADENED" : n < o ? "NARROWED" : "CHANGED";
  }

  // Lower bounds: raising the floor shuts people out.
  if (
    field === "eligibilityRules.minAnnualIncome" ||
    field === "eligibilityRules.minAge" ||
    field === "eligibilityRules.minMarksPercentage"
  ) {
    const o = num(oldValue);
    const n = num(newValue);
    if (o === null && n !== null) return "NARROWED";
    if (o !== null && n === null) return "BROADENED";
    if (o !== null && n !== null) return n < o ? "BROADENED" : n > o ? "NARROWED" : "CHANGED";
  }

  // Education is an ordered ladder (Below 10th ... Doctorate), so a change to
  // the required rung has a direction: demanding more schooling shuts people
  // out. Unknown strings stay CHANGED rather than being guessed at.
  if (field === "eligibilityRules.minEducationLevel") {
    const o = oldValue ? EDUCATION_RANK[oldValue] : null;
    const n = newValue ? EDUCATION_RANK[newValue] : null;
    const oMissing = !oldValue;
    const nMissing = !newValue;
    if (oMissing && !nMissing && n !== undefined) return "NARROWED"; // a floor appeared
    if (!oMissing && nMissing) return "BROADENED"; // a floor was removed
    if (o !== undefined && n !== undefined && o !== null && n !== null) {
      return n > o ? "NARROWED" : n < o ? "BROADENED" : "CHANGED";
    }
    return "CHANGED";
  }

  // PHASE V. The three eligibility types form a permissiveness LATTICE, and the
  // ordering is provable rather than a judgement call. Reading matcher.js:
  //
  //   unknown      eligible = false                                (nobody)
  //   constrained  eligible = no failures AND at least one pass
  //   universal    eligible = no failures
  //
  // Constrained-eligible implies universal-eligible, because the constrained
  // condition is the universal condition plus an extra requirement. So the set
  // of eligible users grows strictly along unknown < constrained < universal,
  // for every scheme and every user. `tests/detectionCompleteness.test.js`
  // asserts that containment by exhaustive enumeration rather than trusting
  // this comment.
  //
  // Direction therefore falls straight out of the ranks: moving up broadens,
  // moving down narrows — and a narrowing here escalates to CRITICAL, because
  // a scheme reclassified downward revokes standing from people who had it.
  if (field === "eligibilityRules.eligibilityType") {
    const PERMISSIVENESS = { unknown: 0, constrained: 1, universal: 2 };
    const o = PERMISSIVENESS[String(oldValue)];
    const n = PERMISSIVENESS[String(newValue)];
    // An unrecognised type is not guessed at. Staying CHANGED keeps the HIGH
    // baseline severity and the eligibility flag, so the change is still
    // propagated — it just is not described with a direction we cannot prove.
    if (o === undefined || n === undefined) return "CHANGED";
    return n > o ? "BROADENED" : n < o ? "NARROWED" : "CHANGED";
  }

  // A deadline pulled forward gives applicants less time; pushed back, more.
  // Not an eligibility field, so this refines the explanation rather than the
  // severity.
  if (field === "lastDate") {
    const o = Date.parse(oldValue);
    const n = Date.parse(newValue);
    if (Number.isNaN(o) && !Number.isNaN(n)) return "NARROWED"; // a deadline appeared
    if (!Number.isNaN(o) && Number.isNaN(n)) return "BROADENED"; // deadline removed
    if (!Number.isNaN(o) && !Number.isNaN(n)) {
      return n > o ? "BROADENED" : n < o ? "NARROWED" : "CHANGED";
    }
    return "CHANGED";
  }

  // OR allow-lists: the user's single value must appear in the list, so a
  // longer list admits more people. An empty list means "unrestricted", which
  // is why [] -> non-empty is a narrowing even though the array grew.
  if (
    ["eligibilityRules.genders", "eligibilityRules.occupations", "eligibilityRules.states"].includes(
      field
    )
  ) {
    const o = arr(oldValue);
    const n = arr(newValue);
    if (o.length === 0 && n.length > 0) return "NARROWED";
    if (o.length > 0 && n.length === 0) return "BROADENED";
    return n.length > o.length ? "BROADENED" : n.length < o.length ? "NARROWED" : "CHANGED";
  }

  // Categories are NOT an OR list. matcher.js treats a flat `categories` array
  // as AND-of-singletons — a scheme listing ["SC","PwD"] requires the user to
  // hold both — so adding an entry here *narrows*, the opposite of the lists
  // above. Getting this backwards would tell a user they gained eligibility at
  // the moment they lost it.
  if (field === "eligibilityRules.categories") {
    const o = arr(oldValue);
    const n = arr(newValue);
    if (o.length === 0 && n.length > 0) return "NARROWED";
    if (o.length > 0 && n.length === 0) return "BROADENED";
    return n.length > o.length ? "NARROWED" : n.length < o.length ? "BROADENED" : "CHANGED";
  }

  // categoryGroups is AND-of-OR: each inner array is an OR-group and every
  // group must be satisfied. More groups = more requirements = narrower; wider
  // groups at the same group count = more ways to satisfy each = broader. When
  // both move at once the net direction is not decidable from shape alone.
  if (field === "eligibilityRules.categoryGroups") {
    const o = arr(oldValue);
    const n = arr(newValue);
    if (o.length === 0 && n.length > 0) return "NARROWED";
    if (o.length > 0 && n.length === 0) return "BROADENED";
    if (n.length > o.length) return "NARROWED";
    if (n.length < o.length) return "BROADENED";
    const width = (g) => arr(g).reduce((s, grp) => s + arr(grp).length, 0);
    const ow = width(o);
    const nw = width(n);
    return nw > ow ? "BROADENED" : nw < ow ? "NARROWED" : "CHANGED";
  }

  // More required documents = a higher bar to actually claim the benefit.
  if (field === "documents") {
    const o = arr(oldValue);
    const n = arr(newValue);
    return n.length > o.length ? "NARROWED" : n.length < o.length ? "BROADENED" : "CHANGED";
  }

  if (field === "status") {
    const wasActive = String(oldValue).toLowerCase() === "active";
    const isActive = String(newValue).toLowerCase() === "active";
    if (wasActive && !isActive) return "NARROWED";
    if (!wasActive && isActive) return "BROADENED";
  }

  return "CHANGED";
}

/** Classify exactly one diff entry. Pure. */
function classifyField(diff) {
  const { field, oldValue, newValue } = diff;
  const meta = FIELD_MAP[field];

  if (!meta) {
    return {
      field,
      changeType: CHANGE_TYPES.ADMINISTRATIVE,
      severity: SEVERITY.LOW,
      attribute: field,
      direction: "CHANGED",
      eligibilityImpact: false,
      benefitImpact: false,
      deadlineImpact: false,
      documentImpact: false,
      ambiguous: false,
      confidence: 0.4, // unmapped field — we genuinely do not know
      evidence: `Unmapped field "${field}" changed`,
    };
  }

  // Prose that only differs by whitespace/punctuation is truly cosmetic.
  if (meta.ambiguous && normalizeProse(oldValue) === normalizeProse(newValue)) {
    return {
      field,
      changeType: CHANGE_TYPES.COSMETIC,
      severity: SEVERITY.LOW,
      attribute: meta.attr,
      direction: "UNCHANGED",
      eligibilityImpact: false,
      benefitImpact: false,
      deadlineImpact: false,
      documentImpact: false,
      ambiguous: false,
      confidence: 0.95,
      evidence: `"${field}" differs only in whitespace/punctuation`,
    };
  }

  const direction = classifyDirection(field, oldValue, newValue);
  let severity = meta.severity;
  // Losing an entitlement is worse than gaining one: a person who was
  // eligible yesterday and is not today must be told.
  if (direction === "NARROWED" && meta.eligibility) severity = maxSeverity(severity, SEVERITY.CRITICAL);

  return {
    field,
    changeType: meta.type,
    severity,
    attribute: meta.attr,
    direction,
    eligibilityImpact: !!meta.eligibility,
    benefitImpact: !!meta.benefit,
    deadlineImpact: !!meta.deadline,
    documentImpact: !!meta.document,
    ambiguous: !!meta.ambiguous,
    // Structured numeric/array fields are read with certainty; prose is not.
    confidence: meta.ambiguous ? 0.55 : 0.95,
    evidence: `${field}: ${JSON.stringify(oldValue)} -> ${JSON.stringify(newValue)}`,
  };
}

/** Deterministic whole-diff classification. No network. */
function classifyDeterministic(diffs, { isNew = false } = {}) {
  if (isNew) {
    return {
      changeType: CHANGE_TYPES.NEW_SCHEME,
      severity: SEVERITY.MEDIUM,
      affectedAttributes: [],
      fieldChanges: [],
      eligibilityImpact: true, // a new scheme can make people newly eligible
      benefitImpact: false,
      deadlineImpact: false,
      documentImpact: false,
      userImpactExpected: true,
      confidence: 1,
      method: "deterministic",
      evidence: ["Scheme observed for the first time"],
    };
  }

  const list = Array.isArray(diffs) ? diffs : [];
  if (list.length === 0) {
    return {
      changeType: CHANGE_TYPES.COSMETIC,
      severity: SEVERITY.LOW,
      affectedAttributes: [],
      fieldChanges: [],
      eligibilityImpact: false,
      benefitImpact: false,
      deadlineImpact: false,
      documentImpact: false,
      userImpactExpected: false,
      confidence: 1,
      method: "deterministic",
      evidence: ["No comparable field changed"],
    };
  }

  const fieldChanges = list.map(classifyField);

  const eligibilityImpact = fieldChanges.some((c) => c.eligibilityImpact && c.changeType !== CHANGE_TYPES.COSMETIC);
  const benefitImpact = fieldChanges.some((c) => c.benefitImpact);
  const deadlineImpact = fieldChanges.some((c) => c.deadlineImpact);
  const documentImpact = fieldChanges.some((c) => c.documentImpact);

  const severity = fieldChanges.reduce((acc, c) => maxSeverity(acc, c.severity), SEVERITY.LOW);

  // Headline type = the most consequential dimension touched.
  const PRIORITY = [
    CHANGE_TYPES.STATUS, CHANGE_TYPES.ELIGIBILITY, CHANGE_TYPES.DEADLINE,
    CHANGE_TYPES.BENEFIT, CHANGE_TYPES.DOCUMENT, CHANGE_TYPES.ADMINISTRATIVE,
    CHANGE_TYPES.COSMETIC,
  ];
  const changeType =
    PRIORITY.find((t) => fieldChanges.some((c) => c.changeType === t)) || CHANGE_TYPES.COSMETIC;

  const affectedAttributes = [
    ...new Set(fieldChanges.filter((c) => c.changeType !== CHANGE_TYPES.COSMETIC).map((c) => c.attribute)),
  ];

  return {
    changeType,
    severity,
    affectedAttributes,
    fieldChanges,
    eligibilityImpact,
    benefitImpact,
    deadlineImpact,
    documentImpact,
    // Only an eligibility/benefit/deadline/document change can plausibly alter
    // what a user should see. Renaming a ministry cannot.
    userImpactExpected: eligibilityImpact || benefitImpact || deadlineImpact || documentImpact,
    confidence: Math.min(...fieldChanges.map((c) => c.confidence)),
    method: "deterministic",
    evidence: fieldChanges.map((c) => c.evidence),
  };
}

// ---------------------------------------------------------------------------
// LLM escalation — only for prose the field map cannot settle.
// ---------------------------------------------------------------------------

const LLM_SCHEMA = {
  type: "object",
  properties: {
    changeType: { type: "string", enum: Object.values(CHANGE_TYPES) },
    severity: { type: "string", enum: Object.values(SEVERITY) },
    eligibilityImpact: { type: "boolean" },
    userImpactExpected: { type: "boolean" },
    affectedAttributes: { type: "array", items: { type: "string" } },
    confidence: { type: "number" },
    reasoning: { type: "string" },
  },
  required: ["changeType", "severity", "eligibilityImpact", "userImpactExpected", "confidence"],
};

const LLM_SYSTEM = `You classify changes to Indian government welfare scheme documents.

You are given the OLD and NEW text of one field of a scheme. Decide whether the
change alters WHO QUALIFIES or WHAT THEY GET, or whether it is only editorial.

- COSMETIC: rewording, reformatting, typo fixes, reordering, added examples that
  introduce no new requirement. eligibilityImpact=false, userImpactExpected=false.
- ELIGIBILITY: any change to who can apply — thresholds, categories, occupations,
  residency, education, added or removed conditions.
- BENEFIT: what the beneficiary receives changes.
- DEADLINE / DOCUMENT / STATUS: as named.

Severity: CRITICAL if people lose eligibility they previously had; HIGH if
eligibility or deadline changes; MEDIUM if benefits/documents change; LOW if
editorial.

Be conservative: if the text merely restates the same rule in different words,
that is COSMETIC. Only assert eligibilityImpact when a requirement actually
changed. confidence: 0.9 when clear, 0.5 when partial, 0.2 when guessing.`;

/**
 * Classify a diff, escalating ambiguous prose changes to the LLM.
 *
 * The LLM may only refine the classification of ambiguous fields; it can never
 * downgrade a structured-field verdict. If it is unavailable, the deterministic
 * verdict stands unchanged — LLM failure is never fatal.
 */
async function classifyChange(diffs, { isNew = false, useLlm = true, schemeName = "" } = {}) {
  const base = classifyDeterministic(diffs, { isNew });

  const ambiguous = (base.fieldChanges || []).filter((c) => c.ambiguous);
  const llmEnabled = useLlm && process.env.POLICY_CHANGE_LLM !== "false";
  if (!llmEnabled || ambiguous.length === 0) return base;

  const refinements = [];
  for (const change of ambiguous) {
    const diff = (diffs || []).find((d) => d.field === change.field);
    if (!diff) continue;
    try {
      const parsed = await generateStructured(
        LLM_SYSTEM,
        JSON.stringify({
          schemeName,
          field: diff.field,
          oldText: String(diff.oldValue ?? "").slice(0, 4000),
          newText: String(diff.newValue ?? "").slice(0, 4000),
        }),
        LLM_SCHEMA,
        { temperature: 0 }
      );
      if (parsed && typeof parsed === "object") refinements.push({ field: change.field, parsed });
    } catch (err) {
      logger.warn("PolicyChangeAgent: LLM refinement failed, keeping deterministic verdict", {
        field: change.field,
        error: err.message,
      });
    }
  }

  if (refinements.length === 0) return base;

  const out = { ...base, method: "deterministic+llm", llmRefinements: refinements };
  for (const { field, parsed } of refinements) {
    const idx = out.fieldChanges.findIndex((c) => c.field === field);
    if (idx === -1) continue;
    const fc = { ...out.fieldChanges[idx] };

    if (Object.values(CHANGE_TYPES).includes(parsed.changeType)) fc.changeType = parsed.changeType;
    if (Object.values(SEVERITY).includes(parsed.severity)) fc.severity = parsed.severity;
    if (typeof parsed.eligibilityImpact === "boolean") fc.eligibilityImpact = parsed.eligibilityImpact;
    if (typeof parsed.confidence === "number") fc.confidence = Math.max(0, Math.min(1, parsed.confidence));
    if (typeof parsed.reasoning === "string" && parsed.reasoning) {
      fc.evidence = `${fc.evidence} | LLM: ${parsed.reasoning.slice(0, 300)}`;
    }
    out.fieldChanges[idx] = fc;
  }

  // Recompute the rollup from the refined field verdicts.
  out.eligibilityImpact = out.fieldChanges.some((c) => c.eligibilityImpact && c.changeType !== CHANGE_TYPES.COSMETIC);
  out.benefitImpact = out.fieldChanges.some((c) => c.benefitImpact);
  out.deadlineImpact = out.fieldChanges.some((c) => c.deadlineImpact);
  out.documentImpact = out.fieldChanges.some((c) => c.documentImpact);
  out.severity = out.fieldChanges.reduce((acc, c) => maxSeverity(acc, c.severity), SEVERITY.LOW);
  out.userImpactExpected =
    out.eligibilityImpact || out.benefitImpact || out.deadlineImpact || out.documentImpact;
  out.affectedAttributes = [
    ...new Set(out.fieldChanges.filter((c) => c.changeType !== CHANGE_TYPES.COSMETIC).map((c) => c.attribute)),
  ];
  out.confidence = Math.min(...out.fieldChanges.map((c) => c.confidence));
  return out;
}

module.exports = {
  classifyChange,
  classifyDeterministic,
  classifyField,
  classifyDirection,
  normalizeProse,
  CHANGE_TYPES,
  SEVERITY,
  SEVERITY_ORDER,
  FIELD_MAP,
};
