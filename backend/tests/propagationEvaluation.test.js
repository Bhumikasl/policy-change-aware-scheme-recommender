/**
 * PHASE Q — the propagation-soundness experiment.
 *
 * ---------------------------------------------------------------------------
 * WHAT THESE TESTS ARE FOR
 * ---------------------------------------------------------------------------
 * Phase Q reports that the Impact Agent's narrow candidate query never misses
 * an affected user. A harness that reports "0 missed" is worth nothing unless
 * it can be shown to detect a miss, so the tests below are mostly about the
 * INSTRUMENT rather than about the result:
 *
 *   - the query evaluator matches the way Mongo matches, including the null
 *     semantics that decide whether a user with no income falls inside a band;
 *   - the agent cannot emit an operator the evaluator does not implement;
 *   - the ORACLE is independent of the thing it is measuring;
 *   - an unsound band produces UNSOUND, not a slightly lower average;
 *   - unmeasured stays `null`, never 0.
 *
 * The one test that asserts a RESULT — that the current corpus runs sound — is
 * last, and it is the least interesting of them.
 */
const fs = require("fs");
const path = require("path");

const {
  matchesQuery,
  SUPPORTED_OPERATORS,
  UnsupportedQueryError,
} = require("../src/evaluation/queryEvaluator");
const { buildCorpus, makeUsers, baseRules, scheme, PROVENANCE } = require("../src/evaluation/propagationCorpus");
const { runCorpus, makeUserStore } = require("../src/evaluation/propagationHarness");
const { runCase, compareRuns, scanAllModel } = require("../src/evaluation/propagationOracle");
const { summarise, STATUS } = require("../src/evaluation/propagationMetrics");

// ---------------------------------------------------------------------------
// The query evaluator
// ---------------------------------------------------------------------------
describe("Q — the query evaluator matches the way Mongo matches", () => {
  const user = (over = {}) => ({ _id: "u1", profile: { age: 30, annualIncome: 250000, state: "Kerala", categories: ["SC"] }, ...over });

  it("applies the numeric range operators inclusively where Mongo does", () => {
    expect(matchesQuery(user(), { "profile.annualIncome": { $gt: 200000, $lte: 300000 } })).toBe(true);
    // $gt is exclusive at the lower bound.
    expect(matchesQuery(user(), { "profile.annualIncome": { $gt: 250000, $lte: 300000 } })).toBe(false);
    // $lte is inclusive at the upper bound. This is the boundary the income
    // band depends on, and an off-by-one here would silently lose a user.
    expect(matchesQuery(user(), { "profile.annualIncome": { $gt: 200000, $lte: 250000 } })).toBe(true);
  });

  it("does NOT match a missing or null field against a range", () => {
    // Mongo does not match null against $gt/$lte, and neither does the band.
    // Matching here would put every profile-less user inside every band and
    // make the measured recall look better than it is.
    expect(matchesQuery({ profile: {} }, { "profile.annualIncome": { $gt: 0, $lte: 9e9 } })).toBe(false);
    expect(matchesQuery({ profile: { annualIncome: null } }, { "profile.annualIncome": { $lte: 100 } })).toBe(false);
  });

  it("matches $in against a scalar and against an array field", () => {
    expect(matchesQuery(user(), { "profile.state": { $in: ["Kerala", "Bihar"] } })).toBe(true);
    expect(matchesQuery(user(), { "profile.state": { $in: ["Bihar"] } })).toBe(false);
    // Array fields match if ANY element is in the list, as Mongo does.
    expect(matchesQuery(user(), { "profile.categories": { $in: ["SC"] } })).toBe(true);
    expect(matchesQuery(user(), { "profile.categories": { $in: ["ST"] } })).toBe(false);
  });

  it("treats { _id: null } as the empty set", () => {
    // The agent's sentinel for "nobody can be affected". Reading it as an
    // equality test against a missing field would match everything.
    expect(matchesQuery(user(), { _id: null })).toBe(false);
  });

  it("unions $or branches", () => {
    const q = { $or: [{ "profile.age": { $gt: 100 } }, { "profile.state": { $in: ["Kerala"] } }] };
    expect(matchesQuery(user(), q)).toBe(true);
    expect(matchesQuery(user(), { $or: [{ "profile.age": { $gt: 100 } }] })).toBe(false);
    // An empty $or matches nothing in Mongo.
    expect(matchesQuery(user(), { $or: [] })).toBe(false);
  });

  it("matches an empty query against everything", () => {
    expect(matchesQuery(user(), {})).toBe(true);
  });

  it("THROWS on an operator it does not implement rather than guessing", () => {
    // Silently ignoring an unknown operator would widen the filter, and a
    // widened filter cannot miss anyone — so the harness would report perfect
    // soundness precisely when it understood the query least.
    let threw = null;
    try {
      matchesQuery(user(), { "profile.state": { $regex: "^K" } });
    } catch (err) {
      threw = err;
    }
    expect(threw instanceof UnsupportedQueryError).toBe(true);
    expect(threw.operator).toBe("$regex");
  });

  /**
   * THE DRIFT GUARD.
   *
   * Read the agent's source and fail if it can emit an operator the evaluator
   * does not implement. Without this, someone adds a `$regex` band, the
   * evaluator throws at run time, the case is recorded FAILED, and the run
   * status silently stops being a soundness measurement.
   */
  it("implements every operator the Impact Agent can emit", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "agents", "policyImpactAgent.js"),
      "utf8"
    );
    // Operators appear as object keys in the filter literals.
    const emitted = new Set([...src.matchAll(/\$[a-zA-Z]+\s*:/g)].map((m) => m[0].replace(/\s*:$/, "")));
    expect(emitted.size).toBeGreaterThan(0);
    for (const op of emitted) {
      expect(SUPPORTED_OPERATORS).toContain(op);
    }
  });
});

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------
describe("Q — the oracle is independent of what it measures", () => {
  const users = makeUsers(60);

  /**
   * THE BUG THIS TEST EXISTS FOR.
   *
   * The first version of the oracle differed from the pipeline run only by a
   * model wrapper that ignored the filter. That is not enough: `assessImpact`
   * returns BEFORE touching the model when the query classifies as `none`, so
   * a banding bug that selected nobody produced an empty pipeline result AND an
   * empty oracle — and the comparison scored it 0 missed.
   *
   * It was found by mutation, not by inspection: dropping removed values from
   * the state symmetric difference made `state-list-reduced` select nobody, and
   * the harness called it SOUND.
   *
   * Here the diff list is empty, so the pipeline query is `none`. The oracle
   * must still find the users whose eligibility actually moved.
   */
  it("finds affected users even when the pipeline query selects nobody", async () => {
    const kase = {
      id: "none-query",
      diffs: [], // -> candidateSelection "none", early return, model untouched
      oldRules: baseRules({ maxAnnualIncome: 100000 }),
      schemeAfter: scheme({ eligibilityRules: baseRules({ maxAnnualIncome: 500000 }) }),
      oldSchemeSnapshot: scheme({ version: 1, eligibilityRules: baseRules({ maxAnnualIncome: 100000 }) }),
    };

    const { pipeline, oracle } = await runCase(kase, { userModel: makeUserStore(users) });

    expect(pipeline.candidateSelection).toBe("none");
    expect(pipeline.impacts.length).toBe(0);
    // The oracle is not fooled.
    expect(oracle.impacts.length).toBeGreaterThan(0);

    const cmp = compareRuns({ pipeline, oracle });
    expect(cmp.sound).toBe(false);
    expect(cmp.missed.length).toBe(oracle.impacts.length);
  });

  it("scans every user regardless of the filter it is handed", async () => {
    const store = makeUserStore(users);
    const wrapped = scanAllModel(store);
    const seen = [];
    const cursor = wrapped.find({ "profile.age": { $gt: 999 } }).batchSize(10).cursor();
    for (let u = await cursor.next(); u != null; u = await cursor.next()) seen.push(u);
    expect(seen.length).toBe(users.length);
  });

  it("reports recall as null, not 1.0, when no user moved", () => {
    const cmp = compareRuns({
      pipeline: { impacts: [], candidatesExamined: 0 },
      oracle: { impacts: [], candidatesExamined: 60 },
    });
    // A case where nothing moved demonstrates nothing. Scoring it 100% would
    // pad the average with cases that tested the band not at all.
    expect(cmp.recall).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Reporting rules
// ---------------------------------------------------------------------------
describe("Q — reporting refuses to flatter the result", () => {
  const obs = (over) => ({
    id: over.id || "c",
    status: STATUS.SOUND,
    affectedByOracle: 10,
    missed: [],
    candidatesExamined: 5,
    oracleExamined: 50,
    candidateSelection: "targeted-band",
    scannedEveryUser: false,
    ...over,
  });

  it("one unsound case makes the WHOLE run unsound", () => {
    // Soundness is not averaged. There is no amount of efficiency elsewhere
    // that trades against failing to tell someone they lost a benefit.
    const s = summarise([obs({ id: "a" }), obs({ id: "b", status: STATUS.UNSOUND, missed: [{ userId: "x" }] })]);
    expect(s.status).toBe(STATUS.UNSOUND);
    expect(s.soundness.unsoundCases).toBe(1);
    expect(s.soundness.unsoundCaseIds).toContain("b");
  });

  it("a failed case makes the run FAILED and is never dropped", () => {
    const s = summarise([obs({ id: "a" }), { id: "boom", status: STATUS.FAILED, error: "x" }]);
    expect(s.status).toBe(STATUS.FAILED);
    expect(s.cases.failed).toBe(1);
    expect(s.cases.total).toBe(2);
  });

  it("reports NOT_MEASURED — never SOUND — when nothing moved anywhere", () => {
    const s = summarise([obs({ affectedByOracle: 0 })]);
    expect(s.status).toBe(STATUS.NOT_MEASURED);
    expect(s.cases.informative).toBe(0);
  });

  it("leaves narrowing NULL rather than 0 when no band was attempted", () => {
    const s = summarise([obs({ candidateSelection: "full-scan", scannedEveryUser: true })]);
    expect(s.narrowing.casesWithBand).toBe(0);
    expect(s.narrowing.scanReduction).toBeNull();
    expect(s.narrowing.usersNotRescored).toBeNull();
  });

  it("carries the provenance and store of every number it prints", () => {
    const s = summarise([obs({})], { provenance: "SYNTHETIC", store: "SIMULATED_STORE", population: 240 });
    expect(s.provenance).toBe("SYNTHETIC");
    expect(s.store).toBe("SIMULATED_STORE");
    expect(s.population).toBe(240);
  });
});

// ---------------------------------------------------------------------------
// The corpus and the result
// ---------------------------------------------------------------------------
describe("Q — the corpus", () => {
  it("is declared synthetic", () => {
    expect(PROVENANCE).toBe("SYNTHETIC");
  });

  it("includes change shapes that CANNOT be banded, not only ones that can", () => {
    // A corpus of only the bandable shapes would report a soundness figure
    // that says nothing about the cases where narrowing is refused.
    const corpus = buildCorpus();
    const expectations = corpus.map((c) => c.expectedSelection);
    expect(expectations).toContain("full-scan");
    expect(expectations).toContain("targeted-band");
    expect(expectations).toContain("targeted-union");
    expect(expectations).toContain("none");
  });

  it("runs SOUND, and the agent picks the candidate mode the corpus expects", async () => {
    const users = makeUsers(240);
    const { observations } = await runCorpus({ corpus: buildCorpus(), users });
    const summary = summarise(observations, { provenance: PROVENANCE, store: "SIMULATED_STORE", population: users.length });

    expect(summary.status).toBe(STATUS.SOUND);
    expect(summary.soundness.unsoundCases).toBe(0);
    expect(summary.soundness.usersMissed).toBe(0);
    // Not a vacuous pass: users really did move, and a band really was used.
    expect(summary.soundness.usersAffected).toBeGreaterThan(0);
    expect(summary.narrowing.casesWithBand).toBeGreaterThan(0);

    for (const o of observations) {
      expect(o.selectionAsExpected).toBe(true);
    }
  });
});
