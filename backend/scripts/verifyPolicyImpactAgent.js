/**
 * Offline behavioural verification for the Policy Impact Agent.
 *
 * The important part is the SOUNDNESS SWEEP at the end: for every bandable
 * field, a synthetic population is evaluated two ways —
 *   (a) brute force: run the matcher on every user, before and after
 *   (b) targeted:    run the matcher only on users the derived query returns
 * — and the two transition sets must be identical. If the targeted query ever
 * misses a user the brute force caught, the optimisation is unsound and the
 * system would silently fail to tell someone they lost a benefit.
 *
 * No DB, no network. Run: node scripts/verifyPolicyImpactAgent.js
 */
const {
  assessImpact,
  buildImpactQuery,
  deriveCandidateFilter,
  classifyTransition,
  TRANSITIONS,
} = require("../src/agents/policyImpactAgent");
const { classifyDeterministic } = require("../src/agents/policyChangeAgent");
const { evaluateEligibility } = require("../src/services/matcher");

let pass = 0;
let fail = 0;
const failures = [];

function check(label, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) pass++;
  else {
    fail++;
    failures.push(`${label}\n    expected ${e}\n    actual   ${a}`);
  }
}
function ok(label, cond) {
  check(label, !!cond, true);
}

// ---------------------------------------------------------------------------
// A minimal in-memory stand-in for the Mongoose User model, supporting exactly
// the query operators the agent emits.
// ---------------------------------------------------------------------------
function getPath(obj, path) {
  return path.split(".").reduce((o, k) => (o == null ? undefined : o[k]), obj);
}

function matchesClause(doc, path, clause) {
  if (path === "$or") return clause.some((sub) => matchesFilter(doc, sub));
  const v = getPath(doc, path);
  if (clause === null) return v === null || v === undefined;
  if (typeof clause !== "object" || Array.isArray(clause)) return v === clause;
  for (const [op, operand] of Object.entries(clause)) {
    switch (op) {
      case "$gt": if (!(typeof v === "number" && v > operand)) return false; break;
      case "$gte": if (!(typeof v === "number" && v >= operand)) return false; break;
      case "$lt": if (!(typeof v === "number" && v < operand)) return false; break;
      case "$lte": if (!(typeof v === "number" && v <= operand)) return false; break;
      case "$in": if (!operand.includes(v)) return false; break;
      default: throw new Error("unsupported operator " + op);
    }
  }
  return true;
}

function matchesFilter(doc, filter) {
  return Object.entries(filter || {}).every(([k, c]) => matchesClause(doc, k, c));
}

function fakeUserModel(users) {
  return {
    find(filter) {
      const rows = users.filter((u) => matchesFilter(u, filter || {}));
      return {
        batchSize() { return this; },
        cursor() {
          let i = 0;
          return { next: async () => (i < rows.length ? rows[i++] : null) };
        },
      };
    },
    async countDocuments() { return users.length; },
  };
}

const baseRules = () => ({
  minAge: null, maxAge: null,
  minAnnualIncome: null, maxAnnualIncome: null,
  minMarksPercentage: null, minEducationLevel: null,
  genders: [], categories: [], categoryGroups: [], occupations: [], states: [],
  eligibilityType: "constrained",
});

const mkUser = (i, profile) => ({
  _id: `u${i}`,
  email: `u${i}@example.com`,
  profile: { categories: [], documentsAvailable: [], ...profile },
});

// ---------------------------------------------------------------------------
// 1. Band derivation.
// ---------------------------------------------------------------------------
const incomeBand = deriveCandidateFilter({
  field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000,
});
check("income band narrowing is proven", incomeBand.narrowingProven, true);
check("income band query", incomeBand.filter, { "profile.annualIncome": { $gt: 250000, $lte: 300000 } });

// The same band regardless of direction — a cut affects exactly the people a
// raise would have added.
const incomeCutBand = deriveCandidateFilter({
  field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000,
});
check("income cut yields the same band", incomeCutBand.filter, {
  "profile.annualIncome": { $gt: 250000, $lte: 300000 },
});

check(
  "minAge band is half-open at the top",
  deriveCandidateFilter({ field: "eligibilityRules.minAge", oldValue: 18, newValue: 21 }).filter,
  { "profile.age": { $gte: 18, $lt: 21 } }
);

check(
  "education band lists the rungs between",
  deriveCandidateFilter({
    field: "eligibilityRules.minEducationLevel", oldValue: "12th Standard", newValue: "Graduate",
  }).filter,
  { "profile.education": { $in: ["12th Standard", "Diploma"] } }
);

// A rule appearing cannot be banded: for a constrained scheme it can also give
// someone their first positive match and make them newly eligible.
ok(
  "a rule appearing forces a full scan",
  deriveCandidateFilter({ field: "eligibilityRules.maxAnnualIncome", oldValue: null, newValue: 300000 })
    .narrowingProven === false
);
ok(
  "a rule being removed forces a full scan",
  deriveCandidateFilter({ field: "eligibilityRules.maxAge", oldValue: 40, newValue: null })
    .narrowingProven === false
);

// Category rules are AND-of-OR plus a gender bridge — no sound narrow query.
ok(
  "category changes force a full scan",
  deriveCandidateFilter({ field: "eligibilityRules.categories", oldValue: ["SC"], newValue: ["SC", "PwD"] })
    .narrowingProven === false
);
ok(
  "categoryGroups changes force a full scan",
  deriveCandidateFilter({ field: "eligibilityRules.categoryGroups", oldValue: [["SC"]], newValue: [["SC"], ["PwD"]] })
    .narrowingProven === false
);

// State list: symmetric difference is sound while both sides are restrictive.
const stateBand = deriveCandidateFilter({
  field: "eligibilityRules.states", oldValue: ["Bihar"], newValue: ["Bihar", "Odisha"],
});
check("state band narrowing is proven", stateBand.narrowingProven, true);
ok("state band targets the added state", JSON.stringify(stateBand.filter).includes("Odisha"));
ok("state band excludes the unchanged state", !JSON.stringify(stateBand.filter).includes("Bihar"));

// ---------------------------------------------------------------------------
// 2. Query union.
// ---------------------------------------------------------------------------
const union = buildImpactQuery([
  { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
  { field: "eligibilityRules.maxAge", oldValue: 35, newValue: 40 },
]);
check("two bands union", union.candidateSelection, "targeted-union");
check("union narrowing is proven", union.narrowingProven, true);
check("union filter", union.filter, {
  $or: [
    { "profile.annualIncome": { $gt: 250000, $lte: 300000 } },
    { "profile.age": { $gt: 35, $lte: 40 } },
  ],
});

// One unbandable field degrades the whole query, honestly.
const degraded = buildImpactQuery([
  { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
  { field: "eligibilityRules.categories", oldValue: ["SC"], newValue: ["SC", "PwD"] },
]);
check("one unbandable field degrades to full scan", degraded.candidateSelection, "full-scan");
check("degraded query reports no proven narrowing", degraded.narrowingProven, false);
check("degraded query reports it scanned everyone", degraded.scannedEveryUser, true);
check("degraded query is still complete", degraded.completenessGuaranteed, true);
check("degraded query matches everyone", degraded.filter, {});

check("empty diff list selects nobody", buildImpactQuery([]).candidateSelection, "none");

// ---------------------------------------------------------------------------
// 3. Transition classification.
// ---------------------------------------------------------------------------
check(
  "false -> true is NEWLY_ELIGIBLE",
  classifyTransition({ eligible: false }, { eligible: true }),
  TRANSITIONS.NEWLY_ELIGIBLE
);
check(
  "true -> false is NO_LONGER_ELIGIBLE",
  classifyTransition({ eligible: true }, { eligible: false }),
  TRANSITIONS.NO_LONGER_ELIGIBLE
);
check(
  "still eligible with a benefit change is reported",
  classifyTransition({ eligible: true }, { eligible: true }, { changeVerdict: { benefitImpact: true } }),
  TRANSITIONS.STILL_ELIGIBLE_CHANGED
);
check(
  "still eligible with only an admin change is silent",
  classifyTransition({ eligible: true }, { eligible: true }, { changeVerdict: { benefitImpact: false } }),
  TRANSITIONS.UNCHANGED
);
check(
  "closure revokes an otherwise-eligible verdict",
  classifyTransition({ eligible: true }, { eligible: true }, { schemeClosed: true }),
  TRANSITIONS.NO_LONGER_ELIGIBLE
);

// ---------------------------------------------------------------------------
// 4. End-to-end: the spec's worked example.
//    "Income: 250000 -> 300000. Find users where 250000 < userIncome <= 300000.
//     Then re-evaluate those users."
// ---------------------------------------------------------------------------
(async () => {
  const users = [
    mkUser(1, { annualIncome: 200000, age: 25, state: "Bihar" }), // passed before and after
    mkUser(2, { annualIncome: 270000, age: 25, state: "Bihar" }), // the transition
    mkUser(3, { annualIncome: 400000, age: 25, state: "Bihar" }), // failed before and after
    mkUser(4, { annualIncome: 300000, age: 25, state: "Bihar" }), // exactly the new cap
    mkUser(5, { annualIncome: 250000, age: 25, state: "Bihar" }), // exactly the old cap
    mkUser(6, { annualIncome: null, age: 25, state: "Bihar" }),   // unknown income
  ];

  const oldRules = { ...baseRules(), maxAnnualIncome: 250000 };
  const scheme = {
    schemeId: "test-income", name: "Test", status: "active", documents: [],
    eligibilityRules: { ...baseRules(), maxAnnualIncome: 300000 },
  };
  const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 }];
  const verdict = classifyDeterministic(diffs);

  const r = await assessImpact({
    scheme, oldRules, diffs, changeVerdict: verdict, userModel: fakeUserModel(users),
  });

  check("worked example: candidateSelection", r.candidateSelection, "targeted-band");
check("worked example: did not scan everyone", r.scannedEveryUser, false);
check("worked example: narrowing proven", r.narrowingProven, true);
  check("worked example: candidates examined", r.candidatesExamined, 2); // 270k and 300k
  check("worked example: total users", r.totalUsers, 6);
  check("worked example: newly eligible count", r.counts.NEWLY_ELIGIBLE, 2);
  check("worked example: nobody lost eligibility", r.counts.NO_LONGER_ELIGIBLE, 0);
  check(
    "worked example: the right people",
    r.impacts.map((i) => i.email).sort(),
    ["u2@example.com", "u4@example.com"]
  );
  check("worked example: the moved rule is named", r.impacts[0].rulesNowPassing, ["annualIncome"]);
  ok("worked example: reports a scan reduction", r.scanReduction > 0.6);

  // ---- the reverse: a cut takes eligibility away ----
  const cutDiffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000 }];
  const cut = await assessImpact({
    scheme: { ...scheme, eligibilityRules: { ...baseRules(), maxAnnualIncome: 250000 } },
    oldRules: { ...baseRules(), maxAnnualIncome: 300000 },
    diffs: cutDiffs,
    changeVerdict: classifyDeterministic(cutDiffs),
    userModel: fakeUserModel(users),
  });
  check("income cut: nobody gains", cut.counts.NEWLY_ELIGIBLE, 0);
  check("income cut: two people lose", cut.counts.NO_LONGER_ELIGIBLE, 2);
  check("income cut: the rule that now fails", cut.impacts[0].rulesNowFailing, ["annualIncome"]);

  // ---- TEST 8: no change -> zero downstream work, zero DB reads ----
  let touched = false;
  const spyModel = {
    find() { touched = true; return { batchSize() { return this; }, cursor() { return { next: async () => null }; } }; },
    async countDocuments() { touched = true; return 0; },
  };
  const none = await assessImpact({
    scheme, oldRules, diffs: [], changeVerdict: classifyDeterministic([]), userModel: spyModel,
  });
  check("no change: candidateSelection", none.candidateSelection, "skipped");
  check("no change: no impacts", none.impacts.length, 0);
  ok("no change: the database is never touched", touched === false);

  // ---- TEST 5: description-only change -> no propagation, no scan ----
  let touched2 = false;
  const spyModel2 = {
    find() { touched2 = true; return { batchSize() { return this; }, cursor() { return { next: async () => null }; } }; },
    async countDocuments() { touched2 = true; return 0; },
  };
  const descDiffs = [{ field: "description", oldValue: "Old text.", newValue: "New, longer text." }];
  const desc = await assessImpact({
    scheme, oldRules: scheme.eligibilityRules, diffs: descDiffs,
    changeVerdict: classifyDeterministic(descDiffs), userModel: spyModel2,
  });
  check("description only: skipped", desc.candidateSelection, "skipped");
  ok("description only: the database is never touched", touched2 === false);

  // ---- scheme closure revokes for everyone still eligible ----
  const closeDiffs = [{ field: "status", oldValue: "active", newValue: "closed" }];
  const closed = await assessImpact({
    scheme: { ...scheme, status: "closed", eligibilityRules: { ...baseRules(), maxAnnualIncome: 250000 } },
    oldRules: { ...baseRules(), maxAnnualIncome: 250000 },
    oldSchemeSnapshot: { status: "active" },
    diffs: closeDiffs,
    changeVerdict: classifyDeterministic(closeDiffs),
    userModel: fakeUserModel(users),
  });
  check("closure: falls back to a full scan", closed.candidateSelection, "full-scan");
  check("closure: reports it scanned everyone", closed.scannedEveryUser, true);
check("closure: reports no proven narrowing", closed.narrowingProven, false);
  check("closure: revokes for the two who qualified", closed.counts.NO_LONGER_ELIGIBLE, 2);
  check("closure: nobody becomes eligible", closed.counts.NEWLY_ELIGIBLE, 0);

  // -------------------------------------------------------------------------
  // 5. SOUNDNESS SWEEP — targeted must equal brute force, every time.
  // -------------------------------------------------------------------------
  const EDU = ["Below 10th", "10th Standard", "12th Standard", "Diploma", "Graduate", "Post Graduate", "Doctorate"];
  const STATES = ["Bihar", "Odisha", "Kerala", "Punjab"];
  const GENDERS = ["Male", "Female"];
  const OCCS = ["Student", "Farmer", "Entrepreneur"];

  // A deterministic pseudo-random population — no Math.random, so a failure
  // here is reproducible.
  let seed = 42;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 2147483648;
  };
  const pick = (a) => a[Math.floor(rnd() * a.length)];

  const population = [];
  for (let i = 0; i < 600; i++) {
    population.push(
      mkUser(i, {
        age: rnd() < 0.05 ? null : 15 + Math.floor(rnd() * 60),
        annualIncome: rnd() < 0.05 ? null : Math.floor(rnd() * 600000),
        marksPercentage: rnd() < 0.1 ? null : Math.floor(rnd() * 100),
        education: rnd() < 0.05 ? "" : pick(EDU),
        state: rnd() < 0.05 ? "" : pick(STATES),
        gender: pick(GENDERS),
        occupation: rnd() < 0.05 ? "" : pick(OCCS),
        categories: rnd() < 0.3 ? [pick(["SC", "ST", "OBC", "General"])] : [],
      })
    );
  }

  // Every bandable field, in both directions, over a couple of rule contexts —
  // including one where OTHER rules are already active, since a band is only
  // sound if unchanged rules cannot themselves flip.
  const contexts = [
    { label: "rules otherwise empty", extra: {} },
    { label: "with an unrelated active age rule", extra: { minAge: 18, maxAge: 60 } },
    { label: "with an unrelated active state rule", extra: { states: ["Bihar", "Odisha"] } },
  ];

  const scenarios = [
    ["eligibilityRules.maxAnnualIncome", { maxAnnualIncome: 250000 }, { maxAnnualIncome: 300000 }],
    ["eligibilityRules.maxAnnualIncome", { maxAnnualIncome: 300000 }, { maxAnnualIncome: 250000 }],
    ["eligibilityRules.minAnnualIncome", { minAnnualIncome: 100000 }, { minAnnualIncome: 150000 }],
    ["eligibilityRules.maxAge", { maxAge: 35 }, { maxAge: 45 }],
    ["eligibilityRules.maxAge", { maxAge: 45 }, { maxAge: 35 }],
    ["eligibilityRules.minAge", { minAge: 18 }, { minAge: 25 }],
    ["eligibilityRules.minAge", { minAge: 25 }, { minAge: 18 }],
    ["eligibilityRules.minMarksPercentage", { minMarksPercentage: 60 }, { minMarksPercentage: 75 }],
    ["eligibilityRules.minMarksPercentage", { minMarksPercentage: 75 }, { minMarksPercentage: 60 }],
    ["eligibilityRules.minEducationLevel", { minEducationLevel: "12th Standard" }, { minEducationLevel: "Graduate" }],
    ["eligibilityRules.minEducationLevel", { minEducationLevel: "Graduate" }, { minEducationLevel: "12th Standard" }],
    ["eligibilityRules.states", { states: ["Bihar"] }, { states: ["Bihar", "Odisha"] }],
    ["eligibilityRules.states", { states: ["Bihar", "Odisha"] }, { states: ["Bihar"] }],
    ["eligibilityRules.genders", { genders: ["Female"] }, { genders: ["Female", "Male"] }],
    ["eligibilityRules.occupations", { occupations: ["Student"] }, { occupations: ["Student", "Farmer"] }],
    ["eligibilityRules.occupations", { occupations: ["Student", "Farmer"] }, { occupations: ["Farmer"] }],
  ];

  let sweepChecked = 0;
  let totalBrute = 0;
  let totalTargeted = 0;
  // A sweep that finds no transitions at all would pass "no missed transitions"
  // vacuously. Count what the brute force actually found, and assert below that
  // the sweep had real work to do.
  let realTransitionsFound = 0;
  let scenariosWithTransitions = 0;

  for (const ctx of contexts) {
    for (const [field, oldPart, newPart] of scenarios) {
      // Skip a scenario whose context would clash with the field under test.
      if (ctx.extra.states && field === "eligibilityRules.states") continue;
      if ((ctx.extra.minAge || ctx.extra.maxAge) && (field === "eligibilityRules.minAge" || field === "eligibilityRules.maxAge")) continue;

      const oldRulesS = { ...baseRules(), ...ctx.extra, ...oldPart };
      const newRulesS = { ...baseRules(), ...ctx.extra, ...newPart };
      const key = field.replace("eligibilityRules.", "");
      const d = [{ field, oldValue: oldRulesS[key], newValue: newRulesS[key] }];
      const schemeS = { schemeId: "sweep", name: "Sweep", status: "active", documents: [], eligibilityRules: newRulesS };

      // (a) brute force
      const bruteBefore = { ...schemeS, eligibilityRules: oldRulesS };
      const brute = new Set();
      for (const u of population) {
        const b = evaluateEligibility(u, bruteBefore).eligible;
        const a = evaluateEligibility(u, schemeS).eligible;
        if (b !== a) brute.add(u.email);
      }

      // (b) targeted
      const r2 = await assessImpact({
        scheme: schemeS, oldRules: oldRulesS, diffs: d,
        changeVerdict: classifyDeterministic(d),
        userModel: fakeUserModel(population),
      });
      const targeted = new Set(
        r2.impacts
          .filter((i) => i.transition !== TRANSITIONS.STILL_ELIGIBLE_CHANGED)
          .map((i) => i.email)
      );

      const missed = [...brute].filter((e) => !targeted.has(e));
      const extra = [...targeted].filter((e) => !brute.has(e));

      const label = `sweep [${ctx.label}] ${field} ${JSON.stringify(oldPart)}->${JSON.stringify(newPart)}`;
      check(`${label}: no missed transitions`, missed, []);
      check(`${label}: no phantom transitions`, extra, []);

      sweepChecked++;
      totalBrute += population.length;
      totalTargeted += r2.candidatesExamined;
      realTransitionsFound += brute.size;
      if (brute.size > 0) scenariosWithTransitions++;
    }
  }

  // Guard against a vacuous sweep.
  ok("sweep: every scenario ran", sweepChecked >= 30);
  ok("sweep: found a substantial number of real transitions", realTransitionsFound > 500);
  ok("sweep: most scenarios produced at least one transition", scenariosWithTransitions >= sweepChecked - 2);

  console.log(
    `\nSoundness sweep: ${sweepChecked} scenarios x ${population.length} users.` +
      `\n  real transitions found          : ${realTransitionsFound} ` +
      `(in ${scenariosWithTransitions}/${sweepChecked} scenarios)` +
      `\n  brute-force matcher evaluations : ${totalBrute}` +
      `\n  targeted matcher evaluations    : ${totalTargeted}` +
      `\n  reduction                       : ${((1 - totalTargeted / totalBrute) * 100).toFixed(1)}%`
  );

  console.log(`\nPolicy Impact Agent — ${pass} passed, ${fail} failed\n`);
  if (failures.length) {
    failures.slice(0, 20).forEach((f) => console.log("  FAIL " + f));
    if (failures.length > 20) console.log(`  ... and ${failures.length - 20} more`);
    process.exit(1);
  }
})();
