/**
 * Offline behavioural verification for the Policy Change Agent.
 * No network, no DB, no LLM — classifyDeterministic only.
 *
 * Run: node scripts/verifyPolicyChangeAgent.js
 */
const {
  classifyDeterministic,
  classifyField,
  classifyDirection,
  normalizeProse,
  CHANGE_TYPES,
  SEVERITY,
  FIELD_MAP,
} = require("../src/agents/policyChangeAgent");

const { COMPARABLE_FIELDS, ELIGIBILITY_RULE_FIELDS } = require("../src/normalizer/normalizer");

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass++;
  } else {
    fail++;
    failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
  }
}

// ---------------------------------------------------------------------------
// 1. Field-map coverage: every field the comparator can emit must be mapped.
//    An unmapped field silently degrades to ADMINISTRATIVE/LOW and would never
//    notify anyone — so this is a correctness gate, not a style check.
// ---------------------------------------------------------------------------
const emittable = [
  ...COMPARABLE_FIELDS.filter((f) => f !== "eligibilityRules"),
  ...ELIGIBILITY_RULE_FIELDS.map((f) => `eligibilityRules.${f}`),
];
const unmapped = emittable.filter((f) => !FIELD_MAP[f]);
check("coverage: every comparator field is mapped", unmapped, []);

// ---------------------------------------------------------------------------
// 2. The brief's worked example.
//    "Income: 250000 -> 300000 should classify as: changeType = ELIGIBILITY,
//     severity = HIGH, affectedAttributes = ['income'], userImpactExpected = true"
// ---------------------------------------------------------------------------
const incomeRaise = classifyDeterministic([
  { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
]);
check("brief example: changeType", incomeRaise.changeType, CHANGE_TYPES.ELIGIBILITY);
check("brief example: severity", incomeRaise.severity, SEVERITY.HIGH);
check("brief example: affectedAttributes", incomeRaise.affectedAttributes, ["income"]);
check("brief example: userImpactExpected", incomeRaise.userImpactExpected, true);
check("brief example: direction", incomeRaise.fieldChanges[0].direction, "BROADENED");
check("brief example: method is deterministic", incomeRaise.method, "deterministic");

// ---------------------------------------------------------------------------
// 3. TEST 8 from the brief: "no change -> zero downstream propagation".
// ---------------------------------------------------------------------------
const noChange = classifyDeterministic([]);
check("no change: changeType", noChange.changeType, CHANGE_TYPES.COSMETIC);
check("no change: userImpactExpected", noChange.userImpactExpected, false);
check("no change: eligibilityImpact", noChange.eligibilityImpact, false);
check("no change: affectedAttributes", noChange.affectedAttributes, []);

// ---------------------------------------------------------------------------
// 4. TEST 5 from the brief: "description only -> no recommendation change".
//    Substantive prose edit: the deterministic layer must NOT claim an
//    eligibility impact on a description change on its own.
// ---------------------------------------------------------------------------
const descOnly = classifyDeterministic([
  {
    field: "description",
    oldValue: "A scholarship for meritorious students.",
    newValue: "A scholarship programme supporting meritorious students across India.",
  },
]);
check("description only: userImpactExpected", descOnly.userImpactExpected, false);
check("description only: eligibilityImpact", descOnly.eligibilityImpact, false);
check("description only: flagged ambiguous for LLM", descOnly.fieldChanges[0].ambiguous, true);

// Whitespace-only reflow of the SAME description must be recognised as cosmetic
// and must NOT be escalated to the LLM at all.
const descReflow = classifyDeterministic([
  {
    field: "description",
    oldValue: "A scholarship  for   meritorious students.",
    newValue: "A scholarship for meritorious students",
  },
]);
check("description reflow: changeType", descReflow.fieldChanges[0].changeType, CHANGE_TYPES.COSMETIC);
check("description reflow: not ambiguous (no LLM call)", descReflow.fieldChanges[0].ambiguous, false);
check("description reflow: userImpactExpected", descReflow.userImpactExpected, false);

// ---------------------------------------------------------------------------
// 5. Narrowing escalates to CRITICAL — someone loses an entitlement they had.
// ---------------------------------------------------------------------------
const incomeCut = classifyDeterministic([
  { field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000 },
]);
check("income cut: direction", incomeCut.fieldChanges[0].direction, "NARROWED");
check("income cut: severity escalated", incomeCut.severity, SEVERITY.CRITICAL);

// ---------------------------------------------------------------------------
// 6. Direction semantics, field by field.
// ---------------------------------------------------------------------------
const dir = (f, o, n) => classifyDirection(f, o, n);

check("maxAge raised", dir("eligibilityRules.maxAge", 35, 40), "BROADENED");
check("maxAge lowered", dir("eligibilityRules.maxAge", 40, 35), "NARROWED");
check("maxAge cap appeared", dir("eligibilityRules.maxAge", null, 40), "NARROWED");
check("maxAge cap removed", dir("eligibilityRules.maxAge", 40, null), "BROADENED");

check("minAge raised", dir("eligibilityRules.minAge", 18, 21), "NARROWED");
check("minAge lowered", dir("eligibilityRules.minAge", 21, 18), "BROADENED");
check("minMarks raised", dir("eligibilityRules.minMarksPercentage", 60, 75), "NARROWED");

// Allow-list: [] means unrestricted, so [] -> ["SC"] shuts everyone else out
// even though the array grew.
check("states [] -> [Bihar]", dir("eligibilityRules.states", [], ["Bihar"]), "NARROWED");
check("states [Bihar] -> []", dir("eligibilityRules.states", ["Bihar"], []), "BROADENED");
check("states [Bihar] -> [Bihar,UP]", dir("eligibilityRules.states", ["Bihar"], ["Bihar", "UP"]), "BROADENED");
check("occupations [Student] -> []", dir("eligibilityRules.occupations", ["Student"], []), "BROADENED");

// categories is AND-of-singletons in matcher.js, so growing it NARROWS.
check("categories [] -> [SC]", dir("eligibilityRules.categories", [], ["SC"]), "NARROWED");
check("categories [SC] -> []", dir("eligibilityRules.categories", ["SC"], []), "BROADENED");
check("categories [SC] -> [SC,PwD]", dir("eligibilityRules.categories", ["SC"], ["SC", "PwD"]), "NARROWED");
check("categories [SC,PwD] -> [SC]", dir("eligibilityRules.categories", ["SC", "PwD"], ["SC"]), "BROADENED");

// categoryGroups is AND-of-OR: more groups narrows, wider groups broadens.
check("groups [[SC]] -> [[SC],[PwD]]", dir("eligibilityRules.categoryGroups", [["SC"]], [["SC"], ["PwD"]]), "NARROWED");
check("groups [[SC],[PwD]] -> [[SC]]", dir("eligibilityRules.categoryGroups", [["SC"], ["PwD"]], [["SC"]]), "BROADENED");
check("groups [[SC]] -> [[SC,ST]]", dir("eligibilityRules.categoryGroups", [["SC"]], [["SC", "ST"]]), "BROADENED");
check("groups [[SC,ST]] -> [[SC]]", dir("eligibilityRules.categoryGroups", [["SC", "ST"]], [["SC"]]), "NARROWED");
check("groups [] -> [[SC]]", dir("eligibilityRules.categoryGroups", [], [["SC"]]), "NARROWED");

// Education ladder.
check("education Graduate -> Post Graduate", dir("eligibilityRules.minEducationLevel", "Graduate", "Post Graduate"), "NARROWED");
check("education Graduate -> 12th Standard", dir("eligibilityRules.minEducationLevel", "Graduate", "12th Standard"), "BROADENED");
check("education null -> Graduate", dir("eligibilityRules.minEducationLevel", null, "Graduate"), "NARROWED");
check("education Graduate -> null", dir("eligibilityRules.minEducationLevel", "Graduate", null), "BROADENED");

// Documents: more paperwork is a higher bar.
check("documents grew", dir("documents", ["Aadhaar"], ["Aadhaar", "Income Certificate"]), "NARROWED");
check("documents shrank", dir("documents", ["Aadhaar", "Income Certificate"], ["Aadhaar"]), "BROADENED");

// Deadline.
check("deadline pushed back", dir("lastDate", "2026-03-31", "2026-06-30"), "BROADENED");
check("deadline pulled forward", dir("lastDate", "2026-06-30", "2026-03-31"), "NARROWED");

// Status.
check("status active -> closed", dir("status", "active", "closed"), "NARROWED");
check("status closed -> active", dir("status", "closed", "active"), "BROADENED");

// ---------------------------------------------------------------------------
// 7. Status closure is CRITICAL and dominates the headline type.
// ---------------------------------------------------------------------------
const closed = classifyDeterministic([
  { field: "status", oldValue: "active", newValue: "closed" },
  { field: "ministry", oldValue: "MoE", newValue: "Ministry of Education" },
]);
check("closure: changeType", closed.changeType, CHANGE_TYPES.STATUS);
check("closure: severity", closed.severity, SEVERITY.CRITICAL);
check("closure: userImpactExpected", closed.userImpactExpected, true);

// ---------------------------------------------------------------------------
// 8. Administrative-only change must NOT wake anyone up.
// ---------------------------------------------------------------------------
const admin = classifyDeterministic([
  { field: "ministry", oldValue: "MoE", newValue: "Ministry of Education" },
  { field: "applicationLink", oldValue: "http://a.gov.in", newValue: "https://a.gov.in" },
]);
check("admin only: changeType", admin.changeType, CHANGE_TYPES.ADMINISTRATIVE);
check("admin only: severity", admin.severity, SEVERITY.LOW);
check("admin only: userImpactExpected", admin.userImpactExpected, false);
check("admin only: eligibilityImpact", admin.eligibilityImpact, false);

// Tags/name alone are cosmetic and must not propagate.
const cosmetic = classifyDeterministic([
  { field: "tags", oldValue: ["a"], newValue: ["a", "b"] },
  { field: "name", oldValue: "PM Yojana", newValue: "PM Yojana Scheme" },
]);
check("cosmetic only: changeType", cosmetic.changeType, CHANGE_TYPES.COSMETIC);
check("cosmetic only: userImpactExpected", cosmetic.userImpactExpected, false);
check("cosmetic only: affectedAttributes empty", cosmetic.affectedAttributes, []);

// ---------------------------------------------------------------------------
// 9. New scheme.
// ---------------------------------------------------------------------------
const fresh = classifyDeterministic([], { isNew: true });
check("new scheme: changeType", fresh.changeType, CHANGE_TYPES.NEW_SCHEME);
check("new scheme: userImpactExpected", fresh.userImpactExpected, true);
check("new scheme: eligibilityImpact", fresh.eligibilityImpact, true);

// ---------------------------------------------------------------------------
// 10. Multi-field diff: severity is the max, attributes are the union,
//     confidence is the minimum (weakest link).
// ---------------------------------------------------------------------------
const multi = classifyDeterministic([
  { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
  { field: "benefits", oldValue: "Rs 10000", newValue: "Rs 12000" },
  { field: "documents", oldValue: ["Aadhaar"], newValue: ["Aadhaar", "Bank Passbook"] },
  { field: "tags", oldValue: [], newValue: ["new"] },
]);
check("multi: changeType is the worst dimension", multi.changeType, CHANGE_TYPES.ELIGIBILITY);
check("multi: severity is the max", multi.severity, SEVERITY.HIGH);
check("multi: benefitImpact", multi.benefitImpact, true);
check("multi: documentImpact", multi.documentImpact, true);
check(
  "multi: attributes are the union minus cosmetic",
  multi.affectedAttributes.sort(),
  ["benefits", "documents", "income"]
);
check("multi: confidence is the minimum", multi.confidence, 0.95);

// ---------------------------------------------------------------------------
// 11. Unmapped field degrades safely and admits low confidence.
// ---------------------------------------------------------------------------
const unknownField = classifyField({ field: "somethingNew", oldValue: 1, newValue: 2 });
check("unmapped field: changeType", unknownField.changeType, CHANGE_TYPES.ADMINISTRATIVE);
check("unmapped field: low confidence", unknownField.confidence, 0.4);
check("unmapped field: no eligibility claim", unknownField.eligibilityImpact, false);

// ---------------------------------------------------------------------------
// 12. normalizeProse.
// ---------------------------------------------------------------------------
check(
  "normalizeProse: punctuation + case + whitespace",
  normalizeProse("  The  Scheme, for STUDENTS.  "),
  "the scheme for students"
);
check(
  "normalizeProse: substantive difference survives",
  normalizeProse("income below 2 lakh") === normalizeProse("income below 3 lakh"),
  false
);

// ---------------------------------------------------------------------------
console.log(`\nPolicy Change Agent — ${pass} passed, ${fail} failed\n`);
if (failures.length) {
  failures.forEach((f) => console.log("  FAIL " + f));
  process.exit(1);
}
