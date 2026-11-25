const crypto = require("crypto");

/**
 * Authoritative list of fields compared for change detection
 */
const COMPARABLE_FIELDS = [
  "name",
  "description",
  "eligibility",
  "eligibilityRules",
  "benefits",
  "documents",
  "lastDate",
  "applicationLink",
  "ministry",
  "state",
  "category",
  "tags",
  "status",
];

/**
 * Authoritative list of rule fields under Scheme.eligibilityRules compared for change detection
 */
const ELIGIBILITY_RULE_FIELDS = [
  "minAge",
  "maxAge",
  "minAnnualIncome",
  "maxAnnualIncome",
  "minMarksPercentage",
  "minEducationLevel",
  "maxEducationLevel",
  "courses",
  "disabilityRequired",
  "minDisabilityPercentage",
  "singleGirlChildRequired",
  "genders",
  "categories",
  "categoryGroups",
  "occupations",
  "applicantTypes",
  "states",
  "eligibilityType",
];

function computeContentHash(doc) {
  const comparable = {};
  for (const field of COMPARABLE_FIELDS) {
    if (field === "eligibilityRules") {
      const rules = {};
      for (const f of ELIGIBILITY_RULE_FIELDS) {
        rules[f] = doc.eligibilityRules?.[f] ?? null;
      }
      comparable.eligibilityRules = rules;
    } else {
      comparable[field] = doc[field] ?? null;
    }
  }
  return crypto.createHash("sha256").update(JSON.stringify(comparable)).digest("hex");
}

/**
 * Normalizes an eligibilityRules object ensuring all fields
 * are properly typed and sanitised.
 */
function normalizeEligibilityRules(rules = {}) {
  const normalized = {
    minAge: Number.isFinite(rules?.minAge) ? rules.minAge : null,
    maxAge: Number.isFinite(rules?.maxAge) ? rules.maxAge : null,
    minAnnualIncome: Number.isFinite(rules?.minAnnualIncome) ? rules.minAnnualIncome : null,
    maxAnnualIncome: Number.isFinite(rules?.maxAnnualIncome) ? rules.maxAnnualIncome : null,
    minMarksPercentage: Number.isFinite(rules?.minMarksPercentage) ? rules.minMarksPercentage : null,
    minEducationLevel: typeof rules?.minEducationLevel === "string" && rules.minEducationLevel.trim()
      ? rules.minEducationLevel.trim()
      : null,
    maxEducationLevel: typeof rules?.maxEducationLevel === "string" && rules.maxEducationLevel.trim()
      ? rules.maxEducationLevel.trim()
      : null,
    courses: Array.isArray(rules?.courses)
      ? [...new Set(rules.courses.map((c) => String(c).trim()).filter(Boolean))]
      : [],
    disabilityRequired: typeof rules?.disabilityRequired === "boolean" ? rules.disabilityRequired : null,
    minDisabilityPercentage: Number.isFinite(rules?.minDisabilityPercentage) ? rules.minDisabilityPercentage : null,
    singleGirlChildRequired: typeof rules?.singleGirlChildRequired === "boolean" ? rules.singleGirlChildRequired : null,
    genders: Array.isArray(rules?.genders)
      ? [...new Set(rules.genders.map((g) => String(g).trim()).filter(Boolean))]
      : [],
    categories: Array.isArray(rules?.categories)
      ? [...new Set(rules.categories.map((c) => String(c).trim()).filter(Boolean))]
      : [],
    categoryGroups: Array.isArray(rules?.categoryGroups)
      ? [...new Set(rules.categoryGroups.map((cg) => Array.isArray(cg) ? cg.map(String) : [String(cg)]))]
      : [],
    occupations: Array.isArray(rules?.occupations)
      ? [...new Set(rules.occupations.map((o) => String(o).trim()).filter(Boolean))]
      : [],
    applicantTypes: Array.isArray(rules?.applicantTypes)
      ? [...new Set(rules.applicantTypes.map((t) => String(t).trim().toUpperCase()).filter(Boolean))]
      : [],
    states: Array.isArray(rules?.states)
      ? [...new Set(rules.states.map((s) => String(s).trim()).filter(Boolean))]
      : [],
    source: rules?.source || "deterministic",
    eligibilityType: typeof rules?.eligibilityType === "string" && rules.eligibilityType.trim()
      ? rules.eligibilityType.trim()
      : "unknown",
    confidence: Number.isFinite(rules?.confidence) ? rules.confidence : 0,
    needsReview: Boolean(rules?.needsReview),
    extractedAt: rules?.extractedAt ? new Date(rules.extractedAt) : null,
  };

  return normalized;
}

/**
 * Turns a raw scheme payload into a fully normalized Scheme object.
 */
function normalize(raw = {}, source = "unknown") {
  const normRules = normalizeEligibilityRules(raw.eligibilityRules || {});
  const stateVal = String(raw.state || "All India").trim();
  if (stateVal !== "All India" && normRules.states.length === 0) {
    normRules.states = [stateVal];
  }
  const doc = {
    schemeId: String(raw.schemeId || ""),
    name: String(raw.name || "").trim(),
    description: String(raw.description || "").trim(),
    eligibility: String(raw.eligibility || "").trim(),
    eligibilityRules: normRules,
    benefits: String(raw.benefits || "").trim(),
    documents: Array.isArray(raw.documents) ? raw.documents.filter(Boolean) : [],
    lastDate: String(raw.lastDate || "").trim(),
    applicationLink: String(raw.applicationLink || "").trim(),
    ministry: String(raw.ministry || "").trim(),
    state: stateVal,
    category: Array.isArray(raw.category) ? raw.category.filter(Boolean) : [],
    tags: Array.isArray(raw.tags) ? raw.tags.filter(Boolean) : [],
    status: String(raw.status || "Active").trim(),
    source: String(raw.source || source || "").trim(),
    sourceUrl: String(raw.sourceUrl || "").trim(),
  };
  doc.contentHash = computeContentHash(doc);
  return doc;
}

module.exports = {
  COMPARABLE_FIELDS,
  ELIGIBILITY_RULE_FIELDS,
  computeContentHash,
  normalizeEligibilityRules,
  normalize,
};