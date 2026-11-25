/**
 * Deterministic explanation templates.
 *
 * A change from maxAnnualIncome 250000 to 300000, for a user earning 280000,
 * has exactly one correct sentence. Asking a language model to produce it would
 * be slower, cost a quota call, vary between runs, and could get the numbers
 * wrong. These render it directly.
 *
 * Every value a template prints is passed in from stored data. Nothing here
 * computes an eligibility verdict or invents a threshold — the matcher decided,
 * the comparator recorded, and this only phrases the result.
 */

const { EDUCATION_RANK } = require("./eligibilityLevels");

/**
 * Indian money formatting. ₹250000 reads as "₹2.5 lakh" to the people this
 * system serves; "₹250,000" is the same number in a less legible dress.
 */
function rupees(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value >= 10000000) {
    const cr = value / 10000000;
    return `₹${cr % 1 === 0 ? cr : cr.toFixed(2).replace(/\.?0+$/, "")} crore`;
  }
  if (value >= 100000) {
    const lakh = value / 100000;
    return `₹${lakh % 1 === 0 ? lakh : lakh.toFixed(2).replace(/\.?0+$/, "")} lakh`;
  }
  return `₹${value.toLocaleString("en-IN")}`;
}

function formatDate(value) {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) return String(value ?? "");
  return new Date(ts).toLocaleDateString("en-IN", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

/**
 * Which profile attribute a matcher rule concerns, and how to phrase it.
 *
 * `label` is second-person because the sentence is addressed to the user.
 * `format` keeps ₹ values in lakh notation and leaves everything else alone.
 */
const RULE_TO_ATTRIBUTE = {
  annualIncome: {
    profileKey: "annualIncome",
    label: "your reported annual income",
    format: rupees,
    fieldPrefix: "eligibilityRules.maxAnnualIncome",
  },
  age: { profileKey: "age", label: "your age", format: (v) => `${v}` },
  education: { profileKey: "education", label: "your education level", format: (v) => `${v}` },
  marks: { profileKey: "marksPercentage", label: "your marks", format: (v) => `${v}%` },
  state: { profileKey: "state", label: "your state", format: (v) => `${v}` },
  gender: { profileKey: "gender", label: "your gender", format: (v) => `${v}` },
  occupation: { profileKey: "occupation", label: "your occupation", format: (v) => `${v}` },
  category: {
    profileKey: "categories",
    label: "your recorded categories",
    format: (v) => (Array.isArray(v) ? v.join(", ") : String(v ?? "")),
  },
};

/** Human phrasing for a changed scheme field. */
const FIELD_PHRASE = {
  "eligibilityRules.maxAnnualIncome": { noun: "annual income limit", fmt: rupees },
  "eligibilityRules.minAnnualIncome": { noun: "minimum annual income", fmt: rupees },
  "eligibilityRules.maxAge": { noun: "maximum age", fmt: (v) => `${v}` },
  "eligibilityRules.minAge": { noun: "minimum age", fmt: (v) => `${v}` },
  "eligibilityRules.minMarksPercentage": { noun: "minimum marks requirement", fmt: (v) => `${v}%` },
  "eligibilityRules.minEducationLevel": { noun: "minimum education requirement", fmt: (v) => `${v}` },
  "eligibilityRules.maxEducationLevel": { noun: "maximum education ceiling", fmt: (v) => `${v}` },
  "eligibilityRules.courses": { noun: "eligible courses/streams", fmt: (v) => (v || []).join(", ") },
  "eligibilityRules.disabilityRequired": { noun: "disability requirement", fmt: (v) => (v ? "required" : "none") },
  "eligibilityRules.minDisabilityPercentage": { noun: "minimum disability percentage", fmt: (v) => `${v}%` },
  "eligibilityRules.singleGirlChildRequired": { noun: "single girl child requirement", fmt: (v) => (v ? "required" : "none") },
  "eligibilityRules.states": { noun: "list of eligible states", fmt: (v) => (v || []).join(", ") },
  "eligibilityRules.occupations": { noun: "list of eligible occupations", fmt: (v) => (v || []).join(", ") },
  "eligibilityRules.applicantTypes": { noun: "eligible applicant entity types", fmt: (v) => (v || []).join(", ") },
  "eligibilityRules.genders": { noun: "gender eligibility", fmt: (v) => (v || []).join(", ") },
  "eligibilityRules.categories": { noun: "required categories", fmt: (v) => (v || []).join(", ") },
  "eligibilityRules.categoryGroups": { noun: "category requirements", fmt: (v) => JSON.stringify(v) },
  lastDate: { noun: "application deadline", fmt: formatDate },
  benefits: { noun: "benefits", fmt: (v) => String(v ?? "") },
  documents: { noun: "required documents", fmt: (v) => (v || []).join(", ") },
  status: { noun: "scheme status", fmt: (v) => String(v ?? "") },
};

/**
 * Describe one changed field: "The annual income limit increased from ₹2.5
 * lakh to ₹3 lakh."
 *
 * Returns null for a field with no phrasing, rather than emitting the raw
 * dotted path at a user.
 */
function describeChange({ field, oldValue, newValue }) {
  const phrase = FIELD_PHRASE[field];
  if (!phrase) return null;

  const from = phrase.fmt(oldValue);
  const to = phrase.fmt(newValue);
  if (from === null || to === null) return null;

  let verb = "changed";
  if (typeof oldValue === "number" && typeof newValue === "number") {
    verb = newValue > oldValue ? "increased" : "decreased";
  } else if (field === "eligibilityRules.minEducationLevel") {
    const o = EDUCATION_RANK[oldValue];
    const n = EDUCATION_RANK[newValue];
    if (o !== undefined && n !== undefined) verb = n > o ? "was raised" : "was lowered";
  } else if (field === "lastDate") {
    const o = Date.parse(oldValue);
    const n = Date.parse(newValue);
    if (!Number.isNaN(o) && !Number.isNaN(n)) verb = n > o ? "was extended" : "was brought forward";
  } else if (Array.isArray(oldValue) && Array.isArray(newValue)) {
    verb = newValue.length > oldValue.length ? "was widened" : "was narrowed";
  }

  const cap = phrase.noun.charAt(0).toUpperCase() + phrase.noun.slice(1);
  return {
    field,
    sentence: `The ${phrase.noun} ${verb} from ${from} to ${to}.`,
    label: cap,
    from,
    to,
  };
}

/**
 * The user attributes that are actually RELEVANT to this transition.
 *
 * Deliberately narrow. A user whose income moved them across a threshold does
 * not need their caste categories restated back to them in the explanation,
 * and printing attributes the change did not touch would be a privacy leak
 * dressed up as helpfulness.
 */
function relevantFactors({ rulesNowPassing = [], rulesNowFailing = [], profile = {} }) {
  const rules = [...new Set([...rulesNowPassing, ...rulesNowFailing])];
  const out = [];
  for (const rule of rules) {
    const meta = RULE_TO_ATTRIBUTE[rule];
    if (!meta) continue;
    const value = profile[meta.profileKey];
    if (value === null || value === undefined || value === "") continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out.push({
      rule,
      attribute: meta.profileKey,
      label: meta.label,
      value,
      display: meta.format(value),
    });
  }
  return out;
}

module.exports = {
  rupees,
  formatDate,
  describeChange,
  relevantFactors,
  RULE_TO_ATTRIBUTE,
  FIELD_PHRASE,
};
