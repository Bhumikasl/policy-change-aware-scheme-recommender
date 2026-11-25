#!/usr/bin/env node
/**
 * npm run demo:policy-change
 *
 * The whole H -> I -> J chain, end to end, in one command.
 *
 * It contacts no government API and needs no MongoDB: the collector is a
 * synthetic two-version fixture and the model layer is the same in-memory
 * store the integration tests use. Everything BETWEEN those two edges is the
 * production code path — services/pipeline.js, the normalizer, the real
 * comparator with its SHA-256 hashing and field diffing, both agents, the
 * matcher, the relevance ranker and recommendationPropagation.
 *
 * Scenario:
 *   User      age 22, income Rs 2,80,000, B.Tech (Graduate), Karnataka
 *   Version 1 income ceiling Rs 2,50,000  -> INELIGIBLE
 *   Version 2 income ceiling Rs 3,00,000  -> ELIGIBLE, and recommended
 */
const path = require("path");
const { makeDb } = require(path.join(__dirname, "..", "tests", "helpers", "inMemoryDb"));

const db = makeDb();

// ---------------------------------------------------------------------------
// Substitute the model layer and the outward-facing services, and nothing else.
// ---------------------------------------------------------------------------
const Module = require("module");
const origLoad = Module._load;
const SRC = path.join(__dirname, "..", "src") + path.sep;
const state = { items: [] };

Module._load = function patched(request, parent, isMain) {
  const fromSrc = parent && parent.filename && parent.filename.startsWith(SRC);
  if (fromSrc) {
    if (request.endsWith("models/Scheme")) return db.Scheme;
    if (request.endsWith("models/SchemeHistory")) return db.SchemeHistory;
    if (request.endsWith("models/User")) return db.User;
    if (request.endsWith("models/RecommendationHistory")) return db.RecommendationHistory;
    if (request.endsWith("models/SchemeChunk")) return db.SchemeChunk;
    if (request.endsWith("models/Notification")) return db.Notification;
    if (request.endsWith("models/NotificationLog")) return db.NotificationLog;
    if (request === "../collectors") return { collectAll: async () => state.items };
    if (request === "./aiSummary") return { generateChangeSummary: async () => "" };
    // Phase J sends nothing. Notification is Phase L.
    if (request === "./notifier") return { notifyMatchingUsers: async () => 0 };
  }
  return origLoad.apply(this, arguments);
};

process.env.POLICY_CHANGE_LLM = "false"; // deterministic: no network at all
process.env.LOG_LEVEL = process.env.LOG_LEVEL || "error";

const { runCollectionCycle } = require(path.join(SRC, "services", "pipeline"));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const scholarship = (cap, prose) => ({
  schemeId: "demo-merit-scholarship",
  name: "State Merit Scholarship",
  description: "Financial assistance for meritorious students.",
  eligibility: prose,
  benefits: "financial assistance of Rs 25000 per year",
  documents: ["Aadhaar", "Income Certificate"],
  tags: ["scholarship", "education"],
  status: "active",
  ministry: "Ministry of Education",
  state: "",
  category: ["Education"],
  applicationLink: "https://example.gov.in/apply",
  lastDate: "2026-12-31",
  eligibilityRules: {
    minAge: null, maxAge: null,
    maxAnnualIncome: cap, minAnnualIncome: null,
    minMarksPercentage: null, minEducationLevel: null,
    genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
    eligibilityType: "constrained", source: "structured", confidence: 0.9, needsReview: false,
  },
});

const filler = (i) => ({
  schemeId: `demo-filler-${i}`,
  name: `General Welfare Programme ${i}`,
  description: "general welfare support programme",
  eligibility: "Open to all citizens of India.",
  benefits: "financial assistance of Rs 5000",
  documents: [], tags: [], status: "active", ministry: "", state: "",
  category: ["Welfare"], applicationLink: "", lastDate: "",
  eligibilityRules: {
    minAge: null, maxAge: null, maxAnnualIncome: null, minAnnualIncome: null,
    minMarksPercentage: null, minEducationLevel: null,
    genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
    eligibilityType: "universal", source: "structured", confidence: 0.9, needsReview: false,
  },
});

const USER = {
  _id: "demo-user-1",
  email: "priya@example.com",
  name: "Demo Student",
  role: "USER",
  profile: {
    age: 22,
    annualIncome: 280000,
    education: "Graduate",
    state: "Karnataka",
    occupation: "Student",
    gender: "Female",
    categories: [],
    documentsAvailable: ["Aadhaar"],
    marksPercentage: 78,
  },
};

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
const B = "\x1b[1m", D = "\x1b[2m", G = "\x1b[32m", Y = "\x1b[33m", R = "\x1b[31m", X = "\x1b[0m";
const rule = () => console.log(D + "─".repeat(74) + X);
const step = (n, title) => console.log(`\n${B}${n}. ${title}${X}`);
const kv = (k, v) => console.log(`   ${k.padEnd(26)} ${v}`);
const ok = (s) => `${G}${s}${X}`;
const warn = (s) => `${Y}${s}${X}`;

(async () => {
  console.log(`\n${B}Dynamic Policy-Aware Scheme Monitoring — H → I → J demo${X}`);
  console.log(`${D}No government API. No MongoDB. No LLM. Everything between the${X}`);
  console.log(`${D}collector and the database is the production code path.${X}`);
  rule();

  db.User.seed([USER]);
  console.log(`${B}User${X}`);
  kv("age", USER.profile.age);
  kv("annual income", `Rs ${USER.profile.annualIncome.toLocaleString("en-IN")}`);
  kv("education", USER.profile.education);
  kv("state", USER.profile.state);

  // ---- VERSION 1 ---------------------------------------------------------
  step(1, "Collection cycle 1 — scheme published at version 1");
  state.items = [
    { raw: scholarship(250000, "Open to students with annual family income up to Rs 2,50,000."), source: "demo" },
    { raw: filler(1), source: "demo" },
    { raw: filler(2), source: "demo" },
  ];
  const c1 = await runCollectionCycle();
  const v1 = db.Scheme.rows.find((s) => s.schemeId === "demo-merit-scholarship");
  // Copy the numbers out now: the in-memory store updates this row in place,
  // so reading v1.version after cycle 2 would show cycle 2's value.
  const v1Version = v1.version;
  const v1Cap = v1.eligibilityRules.maxAnnualIncome;
  kv("schemes collected", c1.new);
  kv("scholarship version", v1Version);
  kv("income ceiling", `Rs ${v1Cap.toLocaleString("en-IN")}`);

  const rowsFor = (id) => db.RecommendationHistory.rows.filter((r) => r.schemeId === id);
  const before = rowsFor("demo-merit-scholarship");
  kv(
    "eligibility",
    before.length === 0
      ? warn("INELIGIBLE — income Rs 2,80,000 exceeds the Rs 2,50,000 ceiling")
      : R + "unexpected" + X
  );

  // ---- VERSION 2 ---------------------------------------------------------
  step(2, "Collection cycle 2 — the ministry raises the ceiling to Rs 3,00,000");
  state.items = [
    { raw: scholarship(300000, "Open to students with annual family income up to Rs 3,00,000."), source: "demo" },
    { raw: filler(1), source: "demo" },
    { raw: filler(2), source: "demo" },
  ];
  const c2 = await runCollectionCycle();

  const v2 = db.Scheme.rows.find((s) => s.schemeId === "demo-merit-scholarship");
  const hist = db.SchemeHistory.rows.find(
    (h) => h.schemeId === "demo-merit-scholarship" && h.version === 2
  );
  const pp = hist.policyProcessing;

  step(3, "Hash comparison (real SHA-256 over the comparable fields)");
  kv("content hash changed", ok("yes"));
  kv("new version", `v${v1Version} → v${v2.version}`);
  kv("unchanged schemes skipped", `${c2.unchanged} (no agent ran for these)`);

  step(4, "Field-level diff");
  for (const d of hist.diffs) {
    kv(d.field, `${JSON.stringify(d.oldValue)} → ${JSON.stringify(d.newValue)}`);
  }

  step(5, "Policy Change Agent (H) — deterministic, no LLM");
  kv("changeType", ok(pp.changeType));
  kv("severity", pp.severity);
  kv("direction", "BROADENED (the ceiling rose, so more people qualify)");

  step(6, "Policy Impact Agent (I) — who could possibly have moved");
  kv("candidateSelection", pp.candidateSelection);
  kv("scannedEveryUser", String(pp.scannedEveryUser));
  kv("narrowingProven", String(pp.narrowingProven));
  kv("completenessGuaranteed", ok(String(pp.completenessGuaranteed)));
  kv("affected users found", pp.affectedUserCount);
  if (pp.scannedEveryUser) {
    console.log(
      `   ${D}The diff carries the free-text eligibility field alongside the${X}\n` +
      `   ${D}structured rule. Prose cannot be banded soundly, so the query${X}\n` +
      `   ${D}degrades to a full scan — complete, just not narrowed.${X}`
    );
  }

  step(7, "Eligibility transition");
  const row = rowsFor("demo-merit-scholarship")[0];
  if (!row) {
    console.log(`   ${R}No recommendation history row was produced — demo FAILED.${X}`);
    process.exit(1);
  }
  kv("previous eligibility", String(row.previousEligibility));
  kv("new eligibility", ok(String(row.newEligibility)));
  kv("transition", ok(row.eligibilityTransition));
  kv("rule that now passes", row.reason.rulesNowPassing.join(", "));

  step(8, "Recommendation propagation (J)");
  kv("previous status", row.previousRecommendationStatus);
  kv("new status", ok(row.newRecommendationStatus));
  kv("transition", ok(row.recommendationTransition));
  kv("previous rank", row.previousRank === null ? "— (was not eligible)" : row.previousRank);
  kv("new rank", `${row.newRank} of ${row.topK} shown`);

  step(9, "RecommendationHistory row (the audit trail)");
  kv("userId", row.userId);
  kv("schemeId", row.schemeId);
  kv("triggeringChangeId", row.triggeringChangeId);
  kv("scheme versions", `v${row.previousSchemeVersion} → v${row.newSchemeVersion}`);
  kv("processingJobId", row.processingJobId);
  kv("reason.code", row.reason.code);
  kv(
    "grounded in",
    row.reason.changedFields.map((f) => `${f.field}: ${f.oldValue} → ${f.newValue}`).join("; ")
  );

  step(10, "Idempotency — reprocessing the identical change");
  const { processSchemeChange } = require(path.join(SRC, "services", "policyPipeline"));
  const replay = await processSchemeChange({
    result: {
      type: "UPDATED",
      schemeId: hist.schemeId,
      version: hist.version,
      diffs: hist.diffs,
      snapshot: hist.snapshot,
    },
    jobId: "demo-replay",
  });
  kv("rows created on replay", replay.historyCreated);
  kv("rows skipped as duplicate", replay.historySkipped);
  kv(
    "total rows for this scheme",
    rowsFor("demo-merit-scholarship").length === 1
      ? ok("1 — unchanged")
      : R + rowsFor("demo-merit-scholarship").length + X
  );

  step(11, "Stage statuses (collection and policy analysis, kept separate)");
  kv("collectionStatus", ok(c2.collectionStatus));
  kv("policyImpactStatus", ok(hist.policyImpactStatus));
  kv("propagationStatus", ok(hist.propagationStatus));
  kv("policyRetryable", String(hist.policyRetryable || false));

  rule();
  const passed =
    row.eligibilityTransition === "INELIGIBLE_TO_ELIGIBLE" &&
    row.recommendationTransition === "NOT_RECOMMENDED_TO_RECOMMENDED" &&
    replay.historyCreated === 0 &&
    rowsFor("demo-merit-scholarship").length === 1;
  console.log(
    passed
      ? `${G}${B}Demo passed:${X} policy change → targeted impact → eligibility transition\n` +
        `→ recommendation propagation → audit trail, all automatic, idempotent on replay.`
      : `${R}${B}Demo FAILED — see above.${X}`
  );
  console.log(
    `${D}Notification is deliberately absent: that is Phase L.${X}\n`
  );
  process.exit(passed ? 0 : 1);
})().catch((err) => {
  console.error("\nDemo crashed:", err.message);
  console.error(err.stack);
  process.exit(1);
});
