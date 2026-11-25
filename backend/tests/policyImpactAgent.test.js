/**
 * Policy Impact Agent — Agent 2.
 *
 * The suite is in two halves.
 *
 * The first half pins the behaviour: which band a diff produces, how bands
 * union, how a transition is classified, and that a no-op change touches no
 * database at all.
 *
 * The second half is the one that matters. `assessImpact` is an optimisation:
 * it re-evaluates a slice of the user base instead of all of it. An
 * optimisation is only worth having if it returns the same answer, so the
 * soundness sweep runs a synthetic population through both the targeted path
 * and a brute-force re-evaluation of every user, and asserts the two agree
 * exactly. A candidate query that is too wide is merely slow; one that is too
 * narrow silently fails to tell someone they lost a benefit, which is the
 * failure this project exists to prevent.
 */
const {
  assessImpact,
  buildImpactQuery,
  deriveCandidateFilter,
  classifyTransition,
  TRANSITIONS,
  COMPLETE_SELECTIONS,
  contractFor,
} = require("../src/agents/policyImpactAgent");
const { classifyDeterministic } = require("../src/agents/policyChangeAgent");
const { evaluateEligibility } = require("../src/services/matcher");
const { fakeUserModel, mkUser, baseRules } = require("./helpers/fakeUserModel");

const activeScheme = (rules) => ({
  schemeId: "test",
  name: "Test Scheme",
  status: "active",
  documents: [],
  eligibilityRules: rules,
});

describe("deriveCandidateFilter", () => {
  describe("numeric upper bounds", () => {
    it("bands an income cap change to the interval between the caps", () => {
      const r = deriveCandidateFilter({
        field: "eligibilityRules.maxAnnualIncome",
        oldValue: 250000,
        newValue: 300000,
      });
      expect(r.narrowingProven).toBe(true);
      expect(r.filter).toEqual({ "profile.annualIncome": { $gt: 250000, $lte: 300000 } });
    });

    it("produces the same band whichever way the cap moved", () => {
      // A cut affects exactly the people a raise would have added.
      const up = deriveCandidateFilter({
        field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000,
      });
      const down = deriveCandidateFilter({
        field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000,
      });
      expect(down.filter).toEqual(up.filter);
    });
  });

  it("bands a lower bound half-open at the top", () => {
    expect(
      deriveCandidateFilter({ field: "eligibilityRules.minAge", oldValue: 18, newValue: 21 }).filter
    ).toEqual({ "profile.age": { $gte: 18, $lt: 21 } });
  });

  it("bands an education change to the rungs between the two levels", () => {
    expect(
      deriveCandidateFilter({
        field: "eligibilityRules.minEducationLevel",
        oldValue: "12th Standard",
        newValue: "Graduate",
      }).filter
    ).toEqual({ "profile.education": { $in: ["12th Standard", "Diploma", "Undergraduate"] } });
  });

  it("bands an OR list to the values that entered or left it", () => {
    const r = deriveCandidateFilter({
      field: "eligibilityRules.states", oldValue: ["Bihar"], newValue: ["Bihar", "Odisha"],
    });
    expect(r.narrowingProven).toBe(true);
    expect(JSON.stringify(r.filter)).toContain("Odisha");
    // Bihar qualified before and qualifies now — no Bihar user can have moved.
    expect(JSON.stringify(r.filter)).not.toContain("Bihar");
  });

  describe("cases that must NOT be banded", () => {
    // For a constrained scheme, matcher.js requires at least one positive
    // match. Adding a rule therefore does not only exclude people outside the
    // new bound — it can also hand someone their first positive and make them
    // eligible. Both effects reach outside any band.
    it("refuses to band a rule that appeared", () => {
      const r = deriveCandidateFilter({
        field: "eligibilityRules.maxAnnualIncome", oldValue: null, newValue: 300000,
      });
      expect(r.narrowingProven).toBe(false);
      expect(r.filter).toBeNull();
    });

    it("refuses to band a rule that was removed", () => {
      expect(
        deriveCandidateFilter({ field: "eligibilityRules.maxAge", oldValue: 40, newValue: null })
          .narrowingProven
      ).toBe(false);
    });

    // Categories are AND-of-OR, and matcher.js bridges gender=female to the
    // "woman" category. Restructuring the groups can flip a user whose own
    // categories appear on both sides, so a symmetric-difference query misses
    // people.
    it("refuses to band a category change", () => {
      expect(
        deriveCandidateFilter({
          field: "eligibilityRules.categories", oldValue: ["SC"], newValue: ["SC", "PwD"],
        }).narrowingProven
      ).toBe(false);
      expect(
        deriveCandidateFilter({
          field: "eligibilityRules.categoryGroups", oldValue: [["SC"]], newValue: [["SC"], ["PwD"]],
        }).narrowingProven
      ).toBe(false);
    });

    it("refuses to band an education level outside the known ladder", () => {
      expect(
        deriveCandidateFilter({
          field: "eligibilityRules.minEducationLevel", oldValue: "Graduate", newValue: "Wizardry",
        }).narrowingProven
      ).toBe(false);
    });

    it("refuses to band scheme-level facts", () => {
      for (const field of ["status", "benefits", "lastDate", "documents"]) {
        expect(deriveCandidateFilter({ field, oldValue: "a", newValue: "b" }).narrowingProven).toBe(false);
      }
    });
  });
});

describe("buildImpactQuery", () => {
  it("unions two bands with $or", () => {
    // A user's verdict can only move if at least one changed rule moved for
    // them, so the union is sound.
    const q = buildImpactQuery([
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
      { field: "eligibilityRules.maxAge", oldValue: 35, newValue: 40 },
    ]);
    expect(q.candidateSelection).toBe("targeted-union");
    expect(q.narrowingProven).toBe(true);
    expect(q.filter).toEqual({
      $or: [
        { "profile.annualIncome": { $gt: 250000, $lte: 300000 } },
        { "profile.age": { $gt: 35, $lte: 40 } },
      ],
    });
  });

  it("degrades the whole query when any one field is unbandable", () => {
    const q = buildImpactQuery([
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
      { field: "eligibilityRules.categories", oldValue: ["SC"], newValue: ["SC", "PwD"] },
    ]);
    expect(q.candidateSelection).toBe("full-scan");
    expect(q.filter).toEqual({});
    // narrowingProven:false means "we could not prove a subset was safe, so
    // we scanned everyone". It never means the result is partial — which is
    // exactly why the old `exhaustive` name had to go.
    expect(q.narrowingProven).toBe(false);
    expect(q.scannedEveryUser).toBe(true);
    expect(q.completenessGuaranteed).toBe(true);
  });

  it("explains every decision it made", () => {
    const q = buildImpactQuery([
      { field: "eligibilityRules.categories", oldValue: ["SC"], newValue: ["SC", "PwD"] },
    ]);
    expect(q.reasons.join(" ")).toMatch(/AND-of-OR/);
  });

  it("selects nobody for an empty diff", () => {
    expect(buildImpactQuery([]).candidateSelection).toBe("none");
  });
});

/**
 * The candidate-selection contract.
 *
 * An earlier version reported one `exhaustive` boolean where `exhaustive:false`
 * meant "we fell back to scanning everyone" — the most complete thing the agent
 * can do, flagged with the word that reads as the opposite. These tests pin the
 * replacement so the ambiguity cannot come back.
 */
describe("candidate-selection contract", () => {
  const CONTRACT_FIELDS = [
    "candidateSelection",
    "scannedEveryUser",
    "narrowingProven",
    "completenessGuaranteed",
  ];

  const targeted = () =>
    buildImpactQuery([
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
    ]);
  const union = () =>
    buildImpactQuery([
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
      { field: "eligibilityRules.maxAge", oldValue: 35, newValue: 40 },
    ]);
  const fullScan = () =>
    buildImpactQuery([
      { field: "eligibilityRules.categories", oldValue: ["SC"], newValue: ["SC", "PwD"] },
    ]);
  const none = () => buildImpactQuery([]);

  it("no longer reports a field named `exhaustive`", () => {
    // The name meant two incompatible things depending on who read it.
    for (const q of [targeted(), union(), fullScan(), none()]) {
      expect(Object.prototype.hasOwnProperty.call(q, "exhaustive")).toBe(false);
    }
  });

  it.each([
    ["targeted band", targeted, "targeted-band", false, true],
    ["targeted union", union, "targeted-union", false, true],
    ["full scan", fullScan, "full-scan", true, false],
    ["nothing selected", none, "none", false, true],
  ])("%s reports its selection unambiguously", (_l, build, selection, scanned, narrowed) => {
    const q = build();
    expect(q.candidateSelection).toBe(selection);
    expect(q.scannedEveryUser).toBe(scanned);
    expect(q.narrowingProven).toBe(narrowed);
  });

  it("always sets every contract field", () => {
    // A partially-populated contract is how ambiguity creeps back in.
    for (const q of [targeted(), union(), fullScan(), none()]) {
      for (const f of CONTRACT_FIELDS) {
        expect(q[f]).toBeDefined();
      }
    }
  });

  it("guarantees completeness on every path, including the full scan", () => {
    // This is the thing the old name obscured: falling back to a full scan is
    // MORE complete, not less. No path currently returns a partial answer.
    for (const q of [targeted(), union(), fullScan(), none()]) {
      expect(q.completenessGuaranteed).toBe(true);
    }
  });

  it("never claims both a proven narrowing and a full scan", () => {
    for (const q of [targeted(), union(), fullScan(), none()]) {
      expect(q.narrowingProven && q.scannedEveryUser).toBe(false);
    }
  });

  it("carries the same contract through to the assessImpact result", async () => {
    const users = [mkUser(1, { annualIncome: 270000, age: 25 })];
    const diffs = [
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 },
    ];
    const r = await assessImpact({
      scheme: activeScheme({ ...baseRules(), maxAnnualIncome: 300000 }),
      oldRules: { ...baseRules(), maxAnnualIncome: 250000 },
      diffs,
      changeVerdict: classifyDeterministic(diffs),
      userModel: fakeUserModel(users),
    });
    expect(Object.prototype.hasOwnProperty.call(r, "exhaustive")).toBe(false);
    expect(r.candidateSelection).toBe("targeted-band");
    expect(r.scannedEveryUser).toBe(false);
    expect(r.narrowingProven).toBe(true);
    expect(r.completenessGuaranteed).toBe(true);
  });

  it("reports zero scan reduction when it scanned everyone", async () => {
    const users = [
      mkUser(1, { annualIncome: 100000, age: 25, categories: ["SC"] }),
      mkUser(2, { annualIncome: 900000, age: 25, categories: [] }),
    ];
    const diffs = [{ field: "eligibilityRules.categories", oldValue: [], newValue: ["SC"] }];
    const r = await assessImpact({
      scheme: activeScheme({ ...baseRules(), categories: ["SC"] }),
      oldRules: baseRules(),
      diffs,
      changeVerdict: classifyDeterministic(diffs),
      userModel: fakeUserModel(users),
    });
    expect(r.candidateSelection).toBe("full-scan");
    expect(r.scannedEveryUser).toBe(true);
    expect(r.candidatesExamined).toBe(users.length);
    expect(r.scanReduction).toBe(0);
  });
});

/**
 * Regression tests from the Phase J validation checkpoint.
 *
 * Each of these covers a defect found by validating the code rather than by
 * reading it. None of them passed before the corresponding fix.
 */
describe("validation checkpoint regressions", () => {
  it("derives completenessGuaranteed rather than hardcoding it", () => {
    // It used to be a literal `true`, which could never report a problem and
    // therefore told a reader nothing. It is now membership in the set of
    // modes whose completeness has actually been argued.
    expect(COMPLETE_SELECTIONS.has("targeted-band")).toBe(true);
    expect(COMPLETE_SELECTIONS.has("full-scan")).toBe(true);
    // A hypothetical future mode that samples is NOT complete by default. This
    // is the property a hardcoded true cannot have.
    expect(contractFor("sampled-estimate").completenessGuaranteed).toBe(false);
    expect(contractFor("anything-unrecognised").completenessGuaranteed).toBe(false);
  });

  it("reports one identical contract from buildImpactQuery and assessImpact", async () => {
    // These used to disagree: candidateSelection "none" gave narrowingProven
    // true from buildImpactQuery and false from assessImpact's early return —
    // exactly the ambiguity the `exhaustive` rename was meant to end.
    const fromQuery = buildImpactQuery([]);
    const fromAssess = await assessImpact({
      scheme: activeScheme(baseRules()),
      oldRules: baseRules(),
      diffs: [],
      changeVerdict: { userImpactExpected: true },
      userModel: fakeUserModel([]),
    });
    const pick = (o) => ({
      candidateSelection: o.candidateSelection,
      scannedEveryUser: o.scannedEveryUser,
      narrowingProven: o.narrowingProven,
      completenessGuaranteed: o.completenessGuaranteed,
    });
    expect(pick(fromAssess)).toEqual(pick(fromQuery));
  });

  it("gives every selection mode a contract consistent with contractFor", async () => {
    for (const mode of ["targeted-band", "targeted-union", "full-scan", "none", "skipped"]) {
      const c = contractFor(mode);
      expect(c.completenessGuaranteed).toBe(true);
      expect(c.scannedEveryUser).toBe(mode === "full-scan");
      expect(c.narrowingProven).toBe(mode !== "full-scan");
    }
  });

  it("finds users made newly eligible by a scheme REOPENING", async () => {
    // The old code wrote `{ eligible: X, ...before }` — spread last, so
    // before.eligible overwrote X and the wasClosed adjustment was dead. A
    // reopened scheme reported nobody as newly eligible. No test covered this.
    const rules = { ...baseRules(), maxAnnualIncome: 300000 };
    const diffs = [{ field: "status", oldValue: "closed", newValue: "active" }];
    const r = await assessImpact({
      scheme: { ...activeScheme(rules), status: "active" },
      oldRules: rules,
      oldSchemeSnapshot: { status: "closed" },
      diffs,
      changeVerdict: classifyDeterministic(diffs),
      userModel: fakeUserModel([mkUser(1, { age: 25, annualIncome: 100000 })]),
    });
    expect(r.counts.NEWLY_ELIGIBLE).toBe(1);
    expect(r.impacts[0].wasEligible).toBe(false);
    expect(r.impacts[0].isEligible).toBe(true);
  });

  it("still revokes for everyone when a scheme closes", async () => {
    // The mirror of the above, to be sure the fix did not invert the closure
    // case it sits next to.
    const rules = { ...baseRules(), maxAnnualIncome: 300000 };
    const diffs = [{ field: "status", oldValue: "active", newValue: "closed" }];
    const r = await assessImpact({
      scheme: { ...activeScheme(rules), status: "closed" },
      oldRules: rules,
      oldSchemeSnapshot: { status: "active" },
      diffs,
      changeVerdict: classifyDeterministic(diffs),
      userModel: fakeUserModel([mkUser(1, { age: 25, annualIncome: 100000 })]),
    });
    expect(r.counts.NO_LONGER_ELIGIBLE).toBe(1);
    expect(r.counts.NEWLY_ELIGIBLE).toBe(0);
  });
});

describe("classifyTransition", () => {
  it("names the four transitions", () => {
    expect(classifyTransition({ eligible: false }, { eligible: true })).toBe(
      TRANSITIONS.NEWLY_ELIGIBLE
    );
    expect(classifyTransition({ eligible: true }, { eligible: false })).toBe(
      TRANSITIONS.NO_LONGER_ELIGIBLE
    );
    expect(
      classifyTransition({ eligible: true }, { eligible: true }, {
        changeVerdict: { benefitImpact: true },
      })
    ).toBe(TRANSITIONS.STILL_ELIGIBLE_CHANGED);
    expect(classifyTransition({ eligible: false }, { eligible: false })).toBe(
      TRANSITIONS.UNCHANGED
    );
  });

  it("stays silent when an eligible user's situation did not materially move", () => {
    // A ministry rename is not worth an email.
    expect(
      classifyTransition({ eligible: true }, { eligible: true }, {
        changeVerdict: { benefitImpact: false, deadlineImpact: false, documentImpact: false },
      })
    ).toBe(TRANSITIONS.UNCHANGED);
  });

  it("treats closure as losing eligibility even when the rules still pass", () => {
    // matcher.js does not look at status, so the impact layer must.
    expect(
      classifyTransition({ eligible: true }, { eligible: true }, { schemeClosed: true })
    ).toBe(TRANSITIONS.NO_LONGER_ELIGIBLE);
  });
});

describe("assessImpact — the worked example", () => {
  // "Income: 250000 -> 300000. Find users where 250000 < userIncome <= 300000.
  //  Then re-evaluate those users."
  const users = [
    mkUser(1, { annualIncome: 200000, age: 25 }), // passed before and after
    mkUser(2, { annualIncome: 270000, age: 25 }), // inside the band
    mkUser(3, { annualIncome: 400000, age: 25 }), // failed before and after
    mkUser(4, { annualIncome: 300000, age: 25 }), // exactly the new cap
    mkUser(5, { annualIncome: 250000, age: 25 }), // exactly the old cap
    mkUser(6, { annualIncome: null, age: 25 }),   // income unknown
  ];
  const oldRules = { ...baseRules(), maxAnnualIncome: 250000 };
  const scheme = activeScheme({ ...baseRules(), maxAnnualIncome: 300000 });
  const diffs = [{ field: "eligibilityRules.maxAnnualIncome", oldValue: 250000, newValue: 300000 }];

  let result;
  beforeAll(async () => {
    result = await assessImpact({
      scheme, oldRules, diffs,
      changeVerdict: classifyDeterministic(diffs),
      userModel: fakeUserModel(users),
    });
  });

  it("re-evaluates only the band, not the whole user base", () => {
    expect(result.candidateSelection).toBe("targeted-band");
    expect(result.candidatesExamined).toBe(2);
    expect(result.totalUsers).toBe(6);
  });

  it("finds exactly the users the raise admitted", () => {
    expect(result.counts.NEWLY_ELIGIBLE).toBe(2);
    expect(result.counts.NO_LONGER_ELIGIBLE).toBe(0);
    expect(result.impacts.map((i) => i.email).sort()).toEqual([
      "u2@example.com",
      "u4@example.com",
    ]);
  });

  it("names the rule that moved, for the explanation agent to use", () => {
    expect(result.impacts[0].rulesNowPassing).toEqual(["annualIncome"]);
    expect(result.impacts[0].transition).toBe(TRANSITIONS.NEWLY_ELIGIBLE);
  });

  it("reports how much of the user base it skipped", () => {
    expect(result.scanReduction).toBeCloseTo(1 - 2 / 6, 3);
  });

  it("finds the mirror-image set when the cap is cut instead", () => {
    // Same band, opposite direction: the people a raise would admit are
    // exactly the people a cut removes.
    const cutDiffs = [
      { field: "eligibilityRules.maxAnnualIncome", oldValue: 300000, newValue: 250000 },
    ];
    return assessImpact({
      scheme: activeScheme({ ...baseRules(), maxAnnualIncome: 250000 }),
      oldRules: { ...baseRules(), maxAnnualIncome: 300000 },
      diffs: cutDiffs,
      changeVerdict: classifyDeterministic(cutDiffs),
      userModel: fakeUserModel(users),
    }).then((cut) => {
      expect(cut.counts.NEWLY_ELIGIBLE).toBe(0);
      expect(cut.counts.NO_LONGER_ELIGIBLE).toBe(2);
      expect(cut.impacts[0].rulesNowFailing).toEqual(["annualIncome"]);
    });
  });
});

describe("changes that must cost nothing", () => {
  const scheme = activeScheme(baseRules());

  it("does not touch the database when no field changed", () => {
    const spy = {};
    return assessImpact({
      scheme, oldRules: baseRules(), diffs: [],
      changeVerdict: classifyDeterministic([]),
      userModel: fakeUserModel([mkUser(1, { age: 30 })], spy),
    }).then((r) => {
      expect(r.candidateSelection).toBe("skipped");
      expect(r.impacts).toEqual([]);
      expect(spy.queried).toBeUndefined();
      expect(spy.counted).toBeUndefined();
    });
  });

  it("does not touch the database for a description-only change", () => {
    // This is what keeps a nightly run from re-scoring every user over a typo.
    const spy = {};
    const diffs = [{ field: "description", oldValue: "Old text.", newValue: "New, longer text." }];
    return assessImpact({
      scheme, oldRules: baseRules(), diffs,
      changeVerdict: classifyDeterministic(diffs),
      userModel: fakeUserModel([mkUser(1, { age: 30 })], spy),
    }).then((r) => {
      expect(r.candidateSelection).toBe("skipped");
      expect(spy.queried).toBeUndefined();
    });
  });
});

describe("scheme closure", () => {
  it("revokes the scheme for everyone who qualified", async () => {
    const users = [
      mkUser(1, { annualIncome: 100000, age: 25 }), // qualified
      mkUser(2, { annualIncome: 900000, age: 25 }), // never qualified
    ];
    const rules = { ...baseRules(), maxAnnualIncome: 250000 };
    const diffs = [{ field: "status", oldValue: "active", newValue: "closed" }];
    const r = await assessImpact({
      scheme: { ...activeScheme(rules), status: "closed" },
      oldRules: rules,
      oldSchemeSnapshot: { status: "active" },
      diffs,
      changeVerdict: classifyDeterministic(diffs),
      userModel: fakeUserModel(users),
    });
    expect(r.candidateSelection).toBe("full-scan");
    expect(r.counts.NO_LONGER_ELIGIBLE).toBe(1);
    expect(r.counts.NEWLY_ELIGIBLE).toBe(0);
    expect(r.impacts[0].email).toBe("u1@example.com");
  });
});

// ---------------------------------------------------------------------------
// SOUNDNESS SWEEP
// ---------------------------------------------------------------------------
describe("soundness: targeted results equal brute force", () => {
  const EDU = [
    "Below 10th", "10th Standard", "12th Standard", "Diploma",
    "Graduate", "Post Graduate", "Doctorate",
  ];
  const STATES = ["Bihar", "Odisha", "Kerala", "Punjab"];
  const GENDERS = ["Male", "Female"];
  const OCCS = ["Student", "Farmer", "Entrepreneur"];

  // Deterministic pseudo-random population: a failure here is reproducible,
  // which Math.random would not be.
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

  // Each scenario is also run against contexts where OTHER rules are already
  // active: a band is only sound if the rules that did NOT change cannot
  // themselves flip a user's verdict.
  const contexts = [
    { label: "rules otherwise empty", extra: {} },
    { label: "with an unrelated age rule", extra: { minAge: 18, maxAge: 60 } },
    { label: "with an unrelated state rule", extra: { states: ["Bihar", "Odisha"] } },
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

  const cases = [];
  for (const ctx of contexts) {
    for (const [field, oldPart, newPart] of scenarios) {
      // Skip scenarios whose context collides with the field under test.
      if (ctx.extra.states && field === "eligibilityRules.states") continue;
      if (
        (ctx.extra.minAge || ctx.extra.maxAge) &&
        (field === "eligibilityRules.minAge" || field === "eligibilityRules.maxAge")
      ) {
        continue;
      }
      cases.push([
        `${ctx.label} | ${field} ${JSON.stringify(oldPart)} -> ${JSON.stringify(newPart)}`,
        ctx.extra, field, oldPart, newPart,
      ]);
    }
  }

  // Accumulated so the suite can prove it was not vacuous.
  const seen = { transitions: 0, scenariosWithTransitions: 0, brute: 0, targeted: 0 };

  it.each(cases)("%s", async (_label, extra, field, oldPart, newPart) => {
    const oldRules = { ...baseRules(), ...extra, ...oldPart };
    const newRules = { ...baseRules(), ...extra, ...newPart };
    const key = field.replace("eligibilityRules.", "");
    const diffs = [{ field, oldValue: oldRules[key], newValue: newRules[key] }];
    const scheme = activeScheme(newRules);

    // Brute force: every user, evaluated under both rule sets.
    const schemeBefore = { ...scheme, eligibilityRules: oldRules };
    const brute = new Set();
    for (const u of population) {
      if (evaluateEligibility(u, schemeBefore).eligible !== evaluateEligibility(u, scheme).eligible) {
        brute.add(u.email);
      }
    }

    const r = await assessImpact({
      scheme, oldRules, diffs,
      changeVerdict: classifyDeterministic(diffs),
      userModel: fakeUserModel(population),
    });
    const targeted = new Set(
      r.impacts
        .filter((i) => i.transition !== TRANSITIONS.STILL_ELIGIBLE_CHANGED)
        .map((i) => i.email)
    );

    // Missed: the brute force found a transition the targeted query did not.
    // This is the failure that would silently withhold a notification.
    expect([...brute].filter((e) => !targeted.has(e))).toEqual([]);
    // Phantom: the targeted path claims a transition that did not happen.
    expect([...targeted].filter((e) => !brute.has(e))).toEqual([]);

    seen.transitions += brute.size;
    if (brute.size > 0) seen.scenariosWithTransitions++;
    seen.brute += population.length;
    seen.targeted += r.candidatesExamined;
  });

  // A sweep that found no transitions would pass every assertion above
  // vacuously, so assert it had real work to do.
  it("was not vacuous, and did less work than brute force", () => {
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(seen.transitions).toBeGreaterThan(500);
    expect(seen.scenariosWithTransitions).toBeGreaterThanOrEqual(cases.length - 2);
    expect(seen.targeted).toBeLessThan(seen.brute * 0.5);
  });
});
