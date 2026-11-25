/**
 * PHASE V — change detection checked against an INDEPENDENT materiality oracle.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * Phases Q through U all begin AFTER a change has been detected. A detection
 * miss is therefore invisible to every one of them: `reconcile()` returning
 * NO_CHANGE writes no history row, bumps no version and starts no pipeline, so
 * there is nothing downstream for any harness to be wrong about.
 *
 * The gap was not hypothetical. `eligibilityRules.eligibilityType` — the field
 * matcher.js branches on before it reads a single rule — was absent from
 * ELIGIBILITY_RULE_FIELDS, which drives BOTH the contentHash and the field
 * diff. A scheme reclassified between unknown/constrained/universal changed
 * every user's verdict while `reconcile()` returned NO_CHANGE on the hash gate.
 *
 * The existing coverage gate in `policyChangeAgent.test.js` could not have
 * caught it: it derives the field list from the detector's own constants, so a
 * field missing from the list is missing from both sides of the check.
 */
const {
  runDetectionCompleteness,
  classifyOutcome,
  candidateSetContains,
  detectChange,
  fieldUniverse,
  withPath,
  BASE_SCHEMES,
  VALUE_DOMAINS,
  EXCLUDED_FROM_UNIVERSE,
  OUTCOME,
  FAILING_OUTCOMES,
} = require("../src/evaluation/detectionCompleteness");
const {
  enumeratePopulation,
  assessMateriality,
  recommendedState,
  schemeIsOpen,
} = require("../src/evaluation/detectionOracle");
const {
  normalize,
  COMPARABLE_FIELDS,
  ELIGIBILITY_RULE_FIELDS,
} = require("../src/normalizer/normalizer");
const { diffFields } = require("../src/services/comparator");
const {
  classifyDeterministic,
  classifyDirection,
  FIELD_MAP,
  CHANGE_TYPES,
  SEVERITY,
} = require("../src/agents/policyChangeAgent");
const { buildImpactQuery, deriveCandidateFilter } = require("../src/agents/policyImpactAgent");
const { evaluateEligibility } = require("../src/services/matcher");
const { referenceEligibility } = require("../src/evaluation/eligibilityReference");
const { enumerateProfiles, PROFILE_AXES, SCHEMES } = require("../src/evaluation/matcherAgreement");

const base = BASE_SCHEMES.find((b) => b.label === "constrained-bare");
const asType = (t) => normalize(withPath(base.raw, "eligibilityRules.eligibilityType", t), base.source);

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------
describe("V — eligibilityType is part of the change signal", () => {
  it("is one of the fields that count toward a change", () => {
    expect(ELIGIBILITY_RULE_FIELDS).toContain("eligibilityType");
  });

  /**
   * The hash gate is the one that failed. reconcile() returns NO_CHANGE on an
   * identical hash WITHOUT ever calling diffFields, so a field outside the hash
   * cannot be rescued by being inside the diff.
   */
  it("changes the contentHash when the scheme is reclassified", () => {
    expect(asType("constrained").contentHash).not.toBe(asType("universal").contentHash);
    expect(asType("constrained").contentHash).not.toBe(asType("unknown").contentHash);
    expect(asType("universal").contentHash).not.toBe(asType("unknown").contentHash);
  });

  it("is emitted as its own field diff", () => {
    const diffs = diffFields(asType("constrained"), asType("universal"));
    expect(diffs.map((d) => d.field)).toContain("eligibilityRules.eligibilityType");
  });

  it("reaches the UPDATED route rather than being swallowed as NO_CHANGE", () => {
    const d = detectChange(asType("constrained"), asType("universal"));
    expect(d.detected).toBe(true);
    expect(d.route).toBe("updated");
  });

  it("is mapped by the change agent, so it can notify somebody", () => {
    expect(FIELD_MAP["eligibilityRules.eligibilityType"]).toBeDefined();
    const v = classifyDeterministic([
      { field: "eligibilityRules.eligibilityType", oldValue: "constrained", newValue: "universal" },
    ]);
    expect(v.changeType).toBe(CHANGE_TYPES.ELIGIBILITY);
    expect(v.eligibilityImpact).toBe(true);
    expect(v.userImpactExpected).toBe(true);
  });

  /**
   * An unmapped field degrades to ADMINISTRATIVE/LOW with eligibilityImpact
   * false, which makes assessImpact return SKIPPED and nobody is told. Detecting
   * the change without classifying it would have looked like a fix and delivered
   * nothing, so this asserts the second half explicitly.
   */
  it("would notify: userImpactExpected survives the whole classification", () => {
    for (const [from, to] of [
      ["constrained", "universal"],
      ["universal", "constrained"],
      ["constrained", "unknown"],
      ["unknown", "constrained"],
    ]) {
      const v = classifyDeterministic([
        { field: "eligibilityRules.eligibilityType", oldValue: from, newValue: to },
      ]);
      expect(v.userImpactExpected).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Direction — and the lattice that justifies it
// ---------------------------------------------------------------------------
describe("V — direction follows the permissiveness lattice", () => {
  const dir = (from, to) =>
    classifyDirection("eligibilityRules.eligibilityType", from, to);

  it("reads a move up the lattice as a broadening", () => {
    expect(dir("unknown", "constrained")).toBe("BROADENED");
    expect(dir("constrained", "universal")).toBe("BROADENED");
    expect(dir("unknown", "universal")).toBe("BROADENED");
  });

  it("reads a move down the lattice as a narrowing", () => {
    expect(dir("universal", "constrained")).toBe("NARROWED");
    expect(dir("constrained", "unknown")).toBe("NARROWED");
    expect(dir("universal", "unknown")).toBe("NARROWED");
  });

  /**
   * A narrowing revokes standing someone already had, which the agent's
   * documented rule escalates to CRITICAL. Getting the direction backwards
   * would tell a user they gained eligibility at the moment they lost it.
   */
  it("escalates a narrowing to CRITICAL", () => {
    const v = classifyDeterministic([
      { field: "eligibilityRules.eligibilityType", oldValue: "universal", newValue: "unknown" },
    ]);
    expect(v.severity).toBe(SEVERITY.CRITICAL);
  });

  it("does not guess a direction for an unrecognised type, but still propagates it", () => {
    expect(dir("constrained", "provisional")).toBe("CHANGED");
    const v = classifyDeterministic([
      { field: "eligibilityRules.eligibilityType", oldValue: "constrained", newValue: "provisional" },
    ]);
    expect(v.eligibilityImpact).toBe(true);
    expect(v.userImpactExpected).toBe(true);
    expect(v.severity).toBe(SEVERITY.HIGH);
  });

  /**
   * The lattice is the justification for the direction rule, so it is asserted
   * rather than described: over the full Phase U enumeration, the set of
   * eligible users can only GROW along unknown -> constrained -> universal.
   *
   * Checked in BOTH implementations. If it held only in production it would be
   * a property of one reading of the specification rather than of the
   * specification itself.
   */
  it("holds by exhaustive enumeration in production AND in the reference", () => {
    const profiles = enumerateProfiles(PROFILE_AXES);
    let violations = 0;
    let eligibleUnknown = 0;
    let eligibleConstrained = 0;
    let eligibleUniversal = 0;

    for (const profile of profiles) {
      const user = { _id: "u", profile };
      for (const s of SCHEMES) {
        const as = (t) => ({ ...s, eligibilityRules: { ...s.eligibilityRules, eligibilityType: t } });
        const pU = evaluateEligibility(user, as("unknown")).eligible;
        const pC = evaluateEligibility(user, as("constrained")).eligible;
        const pV = evaluateEligibility(user, as("universal")).eligible;
        const rU = referenceEligibility(user, as("unknown")).eligible;
        const rC = referenceEligibility(user, as("constrained")).eligible;
        const rV = referenceEligibility(user, as("universal")).eligible;
        if (pU && !pC) violations++;
        if (pC && !pV) violations++;
        if (rU && !rC) violations++;
        if (rC && !rV) violations++;
        if (pU) eligibleUnknown++;
        if (pC) eligibleConstrained++;
        if (pV) eligibleUniversal++;
      }
    }

    expect(violations).toBe(0);
    // Non-vacuous: containment over a space where nobody is ever eligible would
    // hold for any ordering at all.
    expect(eligibleUnknown).toBe(0);
    expect(eligibleConstrained).toBeGreaterThan(0);
    expect(eligibleUniversal).toBeGreaterThan(eligibleConstrained);
  });
});

// ---------------------------------------------------------------------------
// Candidate selection
// ---------------------------------------------------------------------------
describe("V — a reclassification selects every user", () => {
  it("cannot be banded, and says why in the audit trail", () => {
    const out = deriveCandidateFilter({
      field: "eligibilityRules.eligibilityType",
      oldValue: "constrained",
      newValue: "universal",
    });
    expect(out.filter).toBeNull();
    expect(out.narrowingProven).toBe(false);
    expect(out.reason).toMatch(/matcher branch/i);
    // The generic fallback would say "no candidate band defined", which reads
    // as an oversight rather than a proof.
    expect(out.reason).not.toMatch(/no candidate band defined/);
  });

  it("produces a full scan that is still provably complete", () => {
    const q = buildImpactQuery([
      { field: "eligibilityRules.eligibilityType", oldValue: "universal", newValue: "constrained" },
    ]);
    expect(q.candidateSelection).toBe("full-scan");
    expect(q.scannedEveryUser).toBe(true);
    expect(q.completenessGuaranteed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The candidate-set check
// ---------------------------------------------------------------------------
describe("V — the candidate query is checked against the users who moved", () => {
  const u = (profile) => ({ _id: "u1", profile });

  it("reproduces Mongo's missing-field semantics", () => {
    // A comparison operator does not match a document without the field. A
    // user with no age is genuinely not in an age band — under the matcher's
    // strict flag they fail an age rule before AND after, so they cannot flip.
    const band = { "profile.age": { $gt: 30, $lte: 40 } };
    expect(candidateSetContains(band, u({ age: 35 }))).toBe(true);
    expect(candidateSetContains(band, u({ age: 30 }))).toBe(false);
    expect(candidateSetContains(band, u({ age: 40 }))).toBe(true);
    expect(candidateSetContains(band, u({}))).toBe(false);
  });

  it("handles every shape the impact agent emits", () => {
    expect(candidateSetContains({}, u({}))).toBe(true); // full scan
    expect(candidateSetContains(null, u({}))).toBe(true); // scanAll
    expect(candidateSetContains({ _id: null }, u({}))).toBe(false); // nobody
    expect(candidateSetContains({ "profile.state": { $in: ["Kerala"] } }, u({ state: "Kerala" }))).toBe(true);
    expect(candidateSetContains({ "profile.state": { $in: ["Kerala"] } }, u({ state: "Delhi" }))).toBe(false);
    expect(
      candidateSetContains(
        { $or: [{ "profile.age": { $gte: 18, $lt: 21 } }, { "profile.state": { $in: ["Kerala"] } }] },
        u({ age: 40, state: "Kerala" })
      )
    ).toBe(true);
  });

  /**
   * Returning true for something it does not understand would make this check
   * a rubber stamp — the exact failure it exists to prevent.
   */
  it("throws rather than silently admitting an unrecognised query", () => {
    expect(() => candidateSetContains({ "profile.age": { $ne: 5 } }, u({ age: 4 }))).toThrow(/\$ne/);
    expect(() => candidateSetContains({ createdAt: { $gt: 1 } }, u({}))).toThrow(/createdAt/);
  });

  /**
   * `completenessGuaranteed` is derived from the selection MODE, so a band that
   * is simply too narrow still reports complete. This is the demonstration that
   * the flag cannot police band soundness on its own — which is why the sweep
   * checks the query against the moved users instead of reading the flag.
   */
  it("catches a band that is too narrow even when the mode claims completeness", () => {
    const q = buildImpactQuery([
      { field: "eligibilityRules.maxAge", oldValue: 60, newValue: 65 },
    ]);
    expect(q.completenessGuaranteed).toBe(true);
    const inside = u({ age: 62 });
    const outside = u({ age: 30 });
    expect(candidateSetContains(q.filter, inside)).toBe(true);
    expect(candidateSetContains(q.filter, outside)).toBe(false);
  });

  it("reports a dropped user as UNSOUND_BAND, not as a pass", () => {
    expect(
      classifyOutcome({
        material: true,
        detected: true,
        userImpactExpected: true,
        completenessGuaranteed: true,
        usersOutsideCandidateSet: 1,
      })
    ).toBe(OUTCOME.UNSOUND_BAND);
  });
});

// ---------------------------------------------------------------------------
// The deploy-time hash migration
// ---------------------------------------------------------------------------
describe("V — widening the hash does not stampede the next collection cycle", () => {
  /**
   * Adding a field to ELIGIBILITY_RULE_FIELDS changes every stored contentHash
   * once. That is only safe because reconcile()'s SECOND gate catches it: the
   * hash differs, diffFields finds nothing, and the NO_CHANGE branch rewrites
   * the hash without bumping the version or writing a history row.
   *
   * If that branch did not exist, the next cycle after deployment would version
   * every scheme in the database and classify each as a change.
   */
  it("an unchanged scheme with a stale hash produces no field diffs", () => {
    const current = asType("constrained");
    const legacyStored = { ...current, contentHash: "sha256-computed-before-phase-V" };
    const d = detectChange(legacyStored, current);
    expect(d.detected).toBe(false);
    expect(d.route).toBe("hash-differs-no-field-diff");
    expect(d.diffs).toEqual([]);
  });

  it("reconcile keeps the no-diff branch that makes the migration silent", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "services", "comparator.js"),
      "utf8"
    );
    const reconcile = src.slice(src.indexOf("async function reconcile"));
    // Gate 1: identical hash returns before diffing.
    expect(reconcile).toMatch(/contentHash === normalized\.contentHash/);
    // Gate 2: hash differs, no comparable field does — store the hash, do NOT
    // bump the version.
    const noDiffBranch = reconcile.slice(reconcile.indexOf("diffs.length === 0"));
    expect(noDiffBranch).toMatch(/existing\.contentHash = normalized\.contentHash/);
    const beforeVersionBump = noDiffBranch.slice(0, noDiffBranch.indexOf("const newVersion"));
    expect(beforeVersionBump).toMatch(/return \{ type: "NO_CHANGE"/);
  });
});

// ---------------------------------------------------------------------------
// The instrument's independence
// ---------------------------------------------------------------------------
describe("V — the mutation set is not derived from the detector", () => {
  /**
   * The whole methodological point. If the field universe came from
   * COMPARABLE_FIELDS, a field missing from that list would be missing from the
   * sweep too, and the harness would agree with the detector by construction —
   * the tautology the Phase V brief's rule 7 forbids.
   */
  it("reaches fields the comparator does not compare", () => {
    const doc = normalize(base.raw, base.source);
    const universe = fieldUniverse(doc);
    const comparable = new Set([
      ...COMPARABLE_FIELDS.filter((f) => f !== "eligibilityRules"),
      ...ELIGIBILITY_RULE_FIELDS.map((f) => `eligibilityRules.${f}`),
    ]);
    const beyond = universe.filter((f) => !comparable.has(f));
    expect(beyond.length).toBeGreaterThan(0);
    // Concretely: rule provenance and the scheme's source URL are carried by the
    // document and deliberately not compared.
    expect(beyond).toContain("sourceUrl");
    expect(beyond).toContain("eligibilityRules.confidence");
  });

  it("covers every key the normalizer writes, or excludes it with a reason", () => {
    const doc = normalize(base.raw, base.source);
    const universe = fieldUniverse(doc);
    const accounted = new Set([...universe, ...Object.keys(EXCLUDED_FROM_UNIVERSE)]);
    for (const key of Object.keys(doc)) expect(accounted.has(key)).toBe(true);
    for (const key of Object.keys(doc.eligibilityRules)) {
      expect(universe).toContain(`eligibilityRules.${key}`);
    }
    for (const reason of Object.values(EXCLUDED_FROM_UNIVERSE)) {
      expect(String(reason).length).toBeGreaterThan(10);
    }
  });

  /**
   * A new normalizer field with no perturbation domain must fail loudly. Silent
   * skipping would reintroduce exactly the blind spot this phase closes, one
   * field later.
   */
  it("refuses to run when a field has no perturbation domain", () => {
    const doc = normalize(base.raw, base.source);
    expect(() => fieldUniverse({ ...doc, newlyAddedField: "x" })).toThrow(/newlyAddedField/);
    expect(() =>
      fieldUniverse({ ...doc, eligibilityRules: { ...doc.eligibilityRules, minHouseholdSize: 4 } })
    ).toThrow(/minHouseholdSize/);
  });

  it("keeps the oracle independent of the production matcher", () => {
    const fs = require("fs");
    const path = require("path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "evaluation", "detectionOracle.js"),
      "utf8"
    );
    expect(src).not.toMatch(/require\(["'].*services\/matcher["']\)/);
    expect(src).not.toMatch(/evaluateEligibility/);
  });

  it("is never reachable from production code", () => {
    const fs = require("fs");
    const path = require("path");
    const walk = (dir, hits = []) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p, hits);
        // An actual require, not a mention: policyChangeAgent.js names the
        // Phase V test file in a comment, and a comment is not a dependency.
        else if (
          e.name.endsWith(".js") &&
          /require\(["'][^"']*(detectionOracle|detectionCompleteness)["']\)/.test(
            fs.readFileSync(p, "utf8")
          )
        ) {
          hits.push(p);
        }
      }
      return hits;
    };
    const src = path.join(__dirname, "..", "src");
    const importers = walk(src).map((p) => path.relative(src, p).replace(/\\/g, "/"));
    for (const f of importers) expect(f.startsWith("evaluation/")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The oracle
// ---------------------------------------------------------------------------
describe("V — the materiality oracle", () => {
  const population = enumeratePopulation();
  // `constrained-bare` has no rules, so nobody is ever recommended under it —
  // useful for provoking a type flip, useless for showing the population is
  // mixed. These tests use the shape that actually has criteria.
  const mixed = BASE_SCHEMES.find((b) => b.label === "constrained-multi");

  it("enumerates a non-trivial population with a real mix of verdicts", () => {
    expect(population.length).toBeGreaterThan(500);
    const s = normalize(mixed.raw, mixed.source);
    const eligible = population.filter((u) => recommendedState(u, s)).length;
    expect(eligible).toBeGreaterThan(0);
    expect(eligible).toBeLessThan(population.length);
  });

  /**
   * Closure is not an eligibility rule — matcher.js never reads `status` — but
   * a closed scheme is not recommended. An oracle that only looked at the
   * matcher would call a closure immaterial and would then be unable to notice
   * a detector that missed it.
   */
  it("treats a scheme closing as material even though no rule moved", () => {
    const open = normalize(mixed.raw, mixed.source);
    const closed = normalize(withPath(mixed.raw, "status", "Closed"), mixed.source);
    const m = assessMateriality(open, closed, population);
    expect(m.material).toBe(true);
    expect(m.flips).toBeGreaterThan(0);
    expect(schemeIsOpen(closed)).toBe(false);
    // A blank status must not silently revoke every scheme.
    expect(schemeIsOpen({ status: "" })).toBe(true);
    expect(schemeIsOpen({})).toBe(true);
  });

  it("reports no flips when nothing about the scheme moved", () => {
    const a = normalize(base.raw, base.source);
    const m = assessMateriality(a, a, population);
    expect(m.material).toBe(false);
    expect(m.flips).toBe(0);
    expect(m.sampleFlip).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The instrument can fail
// ---------------------------------------------------------------------------
describe("V — the completeness check is falsifiable", () => {
  /**
   * Enumerated over every combination of its inputs, because a decision rule
   * only ever exercised by the cases that happen to arise is the position Phase
   * Q was in. Each of the three defect outcomes must be reachable.
   */
  it("names each defect, over the whole input space of the rule", () => {
    const seen = new Set();
    for (const material of [true, false]) {
      for (const detected of [true, false]) {
        for (const userImpactExpected of [true, false]) {
          for (const completenessGuaranteed of [true, false]) {
            for (const usersOutsideCandidateSet of [0, 1]) {
              seen.add(
                classifyOutcome({
                  material,
                  detected,
                  userImpactExpected,
                  completenessGuaranteed,
                  usersOutsideCandidateSet,
                })
              );
            }
          }
        }
      }
    }
    for (const o of Object.values(OUTCOME)) expect(seen.has(o)).toBe(true);
  });

  it("calls an undetected material change MISSED, whatever else is true", () => {
    expect(
      classifyOutcome({
        material: true,
        detected: false,
        userImpactExpected: true,
        completenessGuaranteed: true,
      })
    ).toBe(OUTCOME.MISSED);
  });

  it("calls a detected-but-unnotified material change MISCLASSIFIED", () => {
    expect(
      classifyOutcome({
        material: true,
        detected: true,
        userImpactExpected: false,
        completenessGuaranteed: true,
      })
    ).toBe(OUTCOME.MISCLASSIFIED);
  });

  it("never treats an immaterial change as a defect", () => {
    for (const detected of [true, false]) {
      const o = classifyOutcome({
        material: false,
        detected,
        userImpactExpected: false,
        completenessGuaranteed: false,
      });
      expect(FAILING_OUTCOMES).not.toContain(o);
    }
  });

  /**
   * Fed a scheme whose only difference is invisible to the detector, the sweep
   * must report MISSED. This is the harness reproducing the pre-Phase-V defect
   * on demand, so a future regression cannot pass quietly.
   */
  it("DETECTS a detector that cannot see a material field", () => {
    const blindBase = {
      label: "blind",
      source: "myScheme",
      raw: BASE_SCHEMES.find((b) => b.label === "constrained-bare").raw,
    };
    const result = runDetectionCompleteness({ bases: [blindBase], crossCheck: false });
    expect(result.status).toBe("COMPLETE");

    // Now simulate the pre-fix detector by hashing without the field.
    const before = normalize(blindBase.raw, blindBase.source);
    const after = normalize(
      withPath(blindBase.raw, "eligibilityRules.eligibilityType", "universal"),
      blindBase.source
    );
    const blinded = { ...after, contentHash: before.contentHash };
    const detection = detectChange(before, blinded);
    const materiality = assessMateriality(before, after, enumeratePopulation());
    expect(detection.detected).toBe(false);
    expect(materiality.material).toBe(true);
    expect(
      classifyOutcome({
        material: materiality.material,
        detected: detection.detected,
        userImpactExpected: false,
        completenessGuaranteed: false,
      })
    ).toBe(OUTCOME.MISSED);
  });
});

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------
describe("V — the sweep over the current code", () => {
  const result = runDetectionCompleteness();

  it("finds no missed, misclassified or unproven material change", () => {
    if (result.failures.length > 0) {
      // eslint-disable-next-line no-console
      console.log("first failure:", JSON.stringify(result.failures[0], null, 2));
    }
    expect(result.counts[OUTCOME.MISSED]).toBe(0);
    expect(result.counts[OUTCOME.MISCLASSIFIED]).toBe(0);
    expect(result.counts[OUTCOME.UNSOUND_BAND]).toBe(0);
    expect(result.counts[OUTCOME.INCOMPLETE_SELECTION]).toBe(0);
    expect(result.status).toBe("COMPLETE");
  });

  /**
   * COMPLETE over a sweep where nothing is ever material would be vacuous —
   * the same trap Phase U's `unknown-type` scheme fell into.
   */
  it("is not a vacuous pass", () => {
    expect(result.mutations).toBeGreaterThan(100);
    expect(result.materialMutations).toBeGreaterThan(20);
    expect(result.counts[OUTCOME.DETECTED_MATERIAL]).toBeGreaterThan(20);
    expect(result.counts[OUTCOME.IGNORED_IMMATERIAL]).toBeGreaterThan(0);
    expect(result.counts[OUTCOME.DETECTED_IMMATERIAL]).toBeGreaterThan(0);
  });

  it("exercises every base scheme shape and every domain value", () => {
    expect(result.bases).toBe(BASE_SCHEMES.length);
    const fields = new Set(result.cases.map((c) => c.field));
    for (const field of Object.keys(VALUE_DOMAINS)) expect(fields.has(field)).toBe(true);
  });

  it("confirms the oracle still agrees with the production matcher", () => {
    expect(result.crossCheck.compared).toBeGreaterThan(1000);
    expect(result.crossCheck.divergent).toBe(0);
    expect(result.crossCheck.status).toBe("AGREE");
  });
});
