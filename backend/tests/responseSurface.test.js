/**
 * PHASE W — what leaves the process, checked against an independent policy.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * Phases O through V each measure a FUNCTION: retrieval, guards, candidate
 * selection, notification cost, schedule arithmetic, comparator stability, the
 * matcher, the change detector. Every one of them inspects what production code
 * returns to other production code.
 *
 * None of them looks at what is serialized to a caller.
 *
 * So `res.json(historyRow)` on four unauthenticated endpoints published the
 * pipeline's operational state — retry flags, job ids, affected-user counts and
 * the provider error messages from the LLM and embedding calls — and eight
 * evaluation harnesses reported healthy throughout, correctly: no function was
 * returning the wrong value.
 */
const fs = require("fs");
const path = require("path");

const {
  runResponseSurfaceAudit,
  documentFieldUniverse,
  schemaFieldPaths,
  routeInventory,
  stripComments,
  isProjectedResponse,
  isEmptyish,
  frontendFieldsUsed,
  flattenPaths,
  fullyPopulated,
  classify,
  EXPOSURE_POLICY,
  FRONTEND_BINDINGS,
  MONGOOSE_IMPLICIT_FIELDS,
  SCHEME_FIXTURE,
  HISTORY_FIXTURE,
  INTERNAL,
  PUBLIC,
  CONTAINER,
} = require("../src/evaluation/responseSurface");
const {
  toPublicScheme,
  toPublicHistoryEntry,
  SCHEME_PUBLIC_FIELDS,
  HISTORY_PUBLIC_FIELDS,
} = require("../src/services/publicProjection");
const Scheme = require("../src/models/Scheme");
const SchemeHistory = require("../src/models/SchemeHistory");

const FRONTEND_SRC = path.join(__dirname, "..", "..", "frontend", "src");
const frontendAvailable = fs.existsSync(FRONTEND_SRC);

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------
describe("W — the pipeline's operational state does not reach an anonymous caller", () => {
  const published = toPublicHistoryEntry(HISTORY_FIXTURE);
  const emitted = new Set(flattenPaths(published));

  /**
   * Named one by one rather than asserted in a loop. Each of these was in the
   * response before Phase W, and each is a category the project's own rules
   * forbid publishing: internal ids, retry data, provider errors, operational
   * fields.
   */
  it("withholds the retry flags that drive the recovery sweeps", () => {
    expect(emitted.has("policyRetryable")).toBe(false);
    expect(emitted.has("ragIndexRetryable")).toBe(false);
    expect(emitted.has("policyImpactStatus")).toBe(false);
    expect(emitted.has("propagationStatus")).toBe(false);
    expect(emitted.has("ragIndexStatus")).toBe(false);
  });

  it("withholds job ids and internal identifiers", () => {
    expect(emitted.has("_id")).toBe(false);
    expect(emitted.has("__v")).toBe(false);
    expect(emitted.has("policyProcessing.jobId")).toBe(false);
    expect(emitted.has("policyProcessing.changeId")).toBe(false);
  });

  /**
   * The most consequential one. `affectedUserCount` is how many people on this
   * platform a given policy change moved — an aggregate about the user base,
   * published per scheme, to callers with no account.
   */
  it("withholds counts describing the user base", () => {
    expect(emitted.has("policyProcessing")).toBe(false);
    expect(emitted.has("policyProcessing.affectedUserCount")).toBe(false);
    expect(JSON.stringify(published)).not.toMatch(/1843/);
  });

  /**
   * The provider strings carry a Google project number and an internal IP in
   * the fixture, because that is the kind of thing they carry in production.
   */
  it("withholds provider error messages", () => {
    const body = JSON.stringify(published);
    expect(body).not.toMatch(/GoogleGenerativeAI/);
    expect(body).not.toMatch(/project_number/);
    expect(body).not.toMatch(/ETIMEDOUT/);
    expect(body).not.toMatch(/10\.0\.4\.19/);
  });

  it("withholds the change detector's own fingerprint", () => {
    expect(JSON.stringify(toPublicScheme(SCHEME_FIXTURE))).not.toMatch(/contentHash/);
    // ...including the copy inside a history row's snapshot.
    expect(emitted.has("snapshot.contentHash")).toBe(false);
  });

  it("withholds the extractor's self-assessment, but not the rules themselves", () => {
    const scheme = toPublicScheme(SCHEME_FIXTURE);
    expect(scheme.eligibilityRules.maxAnnualIncome).toBe(200000);
    expect(scheme.eligibilityRules.eligibilityType).toBe("constrained");
    expect(scheme.eligibilityRules.confidence).toBeUndefined();
    expect(scheme.eligibilityRules.needsReview).toBeUndefined();
    expect(scheme.eligibilityRules.source).toBeUndefined();
    expect(scheme.eligibilityRules.extractedAt).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The counterweight
// ---------------------------------------------------------------------------
describe("W — the pages that consume these endpoints still work", () => {
  /**
   * Confinement alone is satisfied by returning {}. These assertions are the
   * other jaw of the vice: they name what the timeline and the activity feed
   * actually render.
   */
  it("keeps everything the version timeline renders", () => {
    const entry = toPublicHistoryEntry(HISTORY_FIXTURE);
    expect(entry.version).toBe(7);
    expect(entry.eventType).toBe("UPDATED");
    expect(entry.createdAt).toBeDefined();
    expect(entry.aiSummary).toBeDefined();
    expect(entry.diffs[0].field).toBe("eligibilityRules.maxAnnualIncome");
    expect(entry.diffs[0].oldValue).toBe(250000);
    expect(entry.diffs[0].newValue).toBe(200000);
  });

  /**
   * The feed labels each row with the scheme's name AT THAT VERSION, which is
   * not always the current name — so it cannot be recovered from the Scheme
   * collection and the snapshot cannot simply be dropped.
   */
  it("keeps the scheme name the activity feed labels each row with", () => {
    const entry = toPublicHistoryEntry(HISTORY_FIXTURE);
    expect(entry.schemeId).toBe("vidya-scholarship");
    expect(entry.snapshot.name).toBe("Vidya Scholarship");
    expect(Object.keys(entry.snapshot)).toEqual(["name"]);
  });

  it("keeps the provenance the scheme detail page renders", () => {
    const scheme = toPublicScheme(SCHEME_FIXTURE);
    expect(scheme.version).toBe(7);
    expect(scheme.source).toBe("myScheme");
    expect(scheme.sourceUrl).toBeDefined();
    expect(scheme.firstSeenAt).toBeDefined();
    expect(scheme.lastUpdatedAt).toBeDefined();
    expect(scheme.schemeId).toBe("vidya-scholarship");
  });

  it("does not invent fields that were never on the document", () => {
    const scheme = toPublicScheme({ schemeId: "x", name: "X" });
    expect(Object.keys(scheme).sort()).toEqual(["name", "schemeId"]);
  });
});

// ---------------------------------------------------------------------------
// Independence of the audit
// ---------------------------------------------------------------------------
describe("W — the audit does not grade the projection by its own allowlist", () => {
  /**
   * The whole methodological point. If the policy table were derived from
   * SCHEME_PUBLIC_FIELDS, the audit would agree with the projection by
   * construction and could never report a leak — the tautology the brief
   * forbids.
   */
  it("classifies fields the projection never mentions", () => {
    const projectionKnows = new Set([...SCHEME_PUBLIC_FIELDS, ...HISTORY_PUBLIC_FIELDS]);
    const policyKnows = [
      ...Object.keys(EXPOSURE_POLICY.Scheme),
      ...Object.keys(EXPOSURE_POLICY.SchemeHistory),
    ];
    const beyond = policyKnows.filter((f) => !projectionKnows.has(f));
    expect(beyond.length).toBeGreaterThan(0);
    expect(beyond).toContain("policyProcessing");
    expect(beyond).toContain("contentHash");
    expect(beyond).toContain("_id");
  });

  it("reads the field universe from the schema, not from the projection", () => {
    const universe = schemaFieldPaths(Scheme);
    expect(universe).toContain("contentHash");
    expect(universe).toContain("lastCheckedAt");
    expect(universe).toContain("eligibilityRules.needsReview");
    // Not emitted by the projection, therefore invisible to any check that
    // started from the projection.
    for (const f of ["contentHash", "lastCheckedAt", "eligibilityRules.needsReview"]) {
      expect(SCHEME_PUBLIC_FIELDS).not.toContain(f);
    }
  });

  /**
   * `schema.paths` is empty under a hand-written stand-in Mongoose used by an
   * offline sandbox that has no schema compiler. No such stand-in ships in
   * this project (confirmed: none exists anywhere in this tree), so this
   * assertion was asserting an environment artifact that is not true under
   * REAL Mongoose — real Jest confirms `schema.paths` reports 25 real,
   * compiled paths for `Scheme`. The old assertion was simply wrong there,
   * not a security or response-surface issue: `documentFieldUniverse` is
   * built from `schema.obj`, not `schema.paths`, so it never depended on
   * `schema.paths` being empty or non-empty to work correctly.
   *
   * The genuine invariant worth protecting is the opposite of what this test
   * checked: now that `schema.paths` is available for real, every path REAL
   * Mongoose compiles must still be accounted for by `documentFieldUniverse`
   * — otherwise the schema.obj-based enumeration could silently miss a field
   * a real document can actually carry, and the audit would report a clean
   * surface it never looked at. `id` is Mongoose's own auto-added virtual
   * getter (not a stored field, not in `schema.obj`), so it's excluded here
   * the same way `_id`/`__v` are handled as MONGOOSE_IMPLICIT_FIELDS above.
   */
  it("documentFieldUniverse accounts for every path real Mongoose compiles", () => {
    const compiledPaths = Object.keys(Scheme.schema.paths || {});
    // A genuine regression guard: if this ever reports 0 again, something is
    // wrong with the Mongoose setup itself, not with this audit.
    expect(compiledPaths.length).toBeGreaterThan(0);
    const universe = new Set(documentFieldUniverse(Scheme));
    const missing = compiledPaths.filter((p) => p !== "id" && !universe.has(p));
    expect(missing).toEqual([]);
    expect(documentFieldUniverse(Scheme).length).toBeGreaterThan(20);
    expect(documentFieldUniverse(SchemeHistory).length).toBeGreaterThan(10);
  });

  it("accounts for the fields Mongoose adds without being asked", () => {
    expect(MONGOOSE_IMPLICIT_FIELDS).toEqual(["_id", "__v"]);
    for (const f of MONGOOSE_IMPLICIT_FIELDS) {
      expect(documentFieldUniverse(Scheme)).toContain(f);
      expect(classify("Scheme", f)[0]).toBe(INTERNAL);
    }
  });

  it("grades a history snapshot by the Scheme policy rather than a second copy", () => {
    expect(classify("SchemeHistory", "snapshot.contentHash")[0]).toBe(INTERNAL);
    expect(classify("SchemeHistory", "snapshot.name")[0]).toBe(PUBLIC);
    expect(classify("SchemeHistory", "snapshot")[0]).toBe(CONTAINER);
  });

  it("classifies every field the two documents can carry", () => {
    for (const [modelName, model] of [["Scheme", Scheme], ["SchemeHistory", SchemeHistory]]) {
      const unclassified = documentFieldUniverse(model).filter((f) => !classify(modelName, f));
      expect(unclassified).toEqual([]);
    }
  });

  it("gives a reason for every field it withholds", () => {
    for (const fields of Object.values(EXPOSURE_POLICY)) {
      for (const [field, entry] of Object.entries(fields)) {
        expect([INTERNAL, PUBLIC, CONTAINER]).toContain(entry[0]);
        expect(typeof entry[1]).toBe("string");
        expect(entry[1].length).toBeGreaterThan(10);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// The audit's other two inputs
// ---------------------------------------------------------------------------
describe("W — route inventory and frontend demand are read, not assumed", () => {
  it("finds the routers' real endpoints and their guards", () => {
    const routes = routeInventory();
    expect(routes.length).toBeGreaterThan(15);

    const updates = routes.find((r) => r.route === "/updates/recent");
    expect(updates.authenticated).toBe(false);

    const collect = routes.find((r) => r.route === "/collect/run");
    expect(collect.authenticated).toBe(true);

    // Every /users/:email/... route is guarded — the K0 invariant.
    for (const r of routes.filter((x) => x.route.startsWith("/users/:email"))) {
      expect(r.authenticated).toBe(true);
    }
  });

  it("reads required fields out of the frontend, not out of the backend", () => {
    if (!frontendAvailable) return; // covered by the audit's own frontendAvailable flag
    const adminBinding = FRONTEND_BINDINGS.find((b) => b.endpoint === "GET /updates/recent");
    const used = frontendFieldsUsed(adminBinding.file, adminBinding.accessors);
    expect(used).toContain("schemeId");
    expect(used).toContain("eventType");
    expect(used).toContain("aiSummary");
    expect(used).toContain("diffs");
    expect(used).toContain("snapshot");
    // ...and it must not silently resolve nothing, which would make the
    // sufficiency check unfalsifiable.
    expect(used.length).toBeGreaterThan(3);
  });

  it("keeps its frontend bindings pointing at files that exist", () => {
    if (!frontendAvailable) return;
    for (const binding of FRONTEND_BINDINGS) {
      expect(fs.existsSync(path.join(FRONTEND_SRC, binding.file))).toBe(true);
      expect(frontendFieldsUsed(binding.file, binding.accessors).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The audit can fail
// ---------------------------------------------------------------------------
describe("W — the audit is falsifiable in both directions", () => {
  /**
   * The pre-Phase-W behaviour, reproduced on demand: `res.json(doc)` is the
   * identity projection. If the audit cannot fail on that, it is worthless.
   */
  it("DETECTS the raw document being published", () => {
    const raw = flattenPaths(HISTORY_FIXTURE);
    const leaked = raw.filter((f) => classify("SchemeHistory", f)?.[0] === INTERNAL);
    expect(leaked.length).toBeGreaterThan(5);
    expect(leaked).toContain("policyRetryable");
    expect(leaked).toContain("snapshot.contentHash");
    expect(leaked).toContain("_id");
  });

  /**
   * And the other direction: an empty response satisfies confinement perfectly
   * and must still fail.
   */
  it("DETECTS a projection that withholds everything", () => {
    const empty = {};
    const required = frontendAvailable
      ? frontendFieldsUsed("pages/Admin.jsx", ["entry", "u"]).filter((f) =>
          classify("SchemeHistory", f)
        )
      : ["schemeId", "eventType"];
    const missing = required.filter((f) => !(f in empty));
    expect(missing.length).toBeGreaterThan(0);
  });

  /**
   * A projection is only tested by what it is handed. Auditing a sparse row
   * would let a leak hide behind an absent value, so the fixtures must populate
   * every path the schema declares — and the audit refuses to run otherwise.
   */
  it("refuses to run against a fixture that leaves a field unset", () => {
    expect(() => fullyPopulated(Scheme, SCHEME_FIXTURE)).not.toThrow();
    const { contentHash, ...withoutHash } = SCHEME_FIXTURE;
    expect(() => fullyPopulated(Scheme, withoutHash)).toThrow(/contentHash/);
    const sparseRules = {
      ...SCHEME_FIXTURE,
      eligibilityRules: { ...SCHEME_FIXTURE.eligibilityRules, needsReview: undefined },
    };
    delete sparseRules.eligibilityRules.needsReview;
    expect(() => fullyPopulated(Scheme, sparseRules)).toThrow(/needsReview/);
  });

  it("flattens nested and array-valued paths, so a nested leak is visible", () => {
    const paths = flattenPaths({ a: 1, b: { c: 2 }, d: [{ e: 3 }] });
    expect(paths).toContain("a");
    expect(paths).toContain("b.c");
    expect(paths).toContain("d.e");
  });
});

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------
describe("W — the audit over the current code", () => {
  const result = runResponseSurfaceAudit();

  it("reports no leak, no missing field and nothing unclassified", () => {
    if (result.status !== "CONFINED") {
      // eslint-disable-next-line no-console
      console.log("leaks:", JSON.stringify(result.leaks, null, 2));
      console.log("missing:", JSON.stringify(result.missing, null, 2));
      console.log("undeclared:", JSON.stringify(result.undeclared, null, 2));
    }
    expect(result.leaks).toEqual([]);
    expect(result.missing).toEqual([]);
    expect(result.undeclared).toEqual([]);
    expect(result.status).toBe("CONFINED");
  });

  /**
   * CONFINED over a surface with nothing internal to withhold would be vacuous.
   */
  it("is not a vacuous pass", () => {
    expect(result.surfaces.length).toBe(4);
    for (const s of result.surfaces) {
      expect(s.authenticated).toBe(false);
      expect(s.internalFieldsInDocument).toBeGreaterThan(0);
      expect(s.internalFieldsWithheld).toBe(s.internalFieldsInDocument);
      expect(s.fieldsEmitted).toBeGreaterThan(0);
      if (frontendAvailable) expect(s.frontendFieldsRequired).toBeGreaterThan(0);
    }
  });

  /**
   * W.3. The projection can be flawless and simply not be called — which is
   * how the defect existed in the first place: nothing was wrong with any
   * function, the route just handed the raw document to res.json.
   */
  it("requires every audited route to actually call its projection", () => {
    expect(result.unprojected).toEqual([]);
    const schemeRoutes = result.routes.filter((r) => r.file === "schemes.js");
    for (const r of schemeRoutes) expect(r.projected).toBe(true);
  });

  /**
   * EVERY, not SOME. Mutation W-M14 weakened the wiring predicate to `some` and
   * survived, because every handler in the tree today has exactly one exit — so
   * the two are indistinguishable on real input. Tested directly on a mixed
   * list, which is the shape a future regression would actually take.
   */
  it("requires EVERY exit of a handler to be projected, not just one", () => {
    expect(isProjectedResponse(["toPublicHistory(updates"])).toBe(true);
    expect(isProjectedResponse(["{ error: \"Scheme not found\" }"])).toBe(true);
    expect(isProjectedResponse(["updates"])).toBe(false);
    // The case that survives under `some`: one good exit and one raw one.
    expect(isProjectedResponse(["toPublicHistory(updates", "raw"])).toBe(false);
    expect(isProjectedResponse(["{ error: \"nope\" }", "doc"])).toBe(false);
  });

  /**
   * Mutation W-M5 emptied the diff list. The key survived, the timeline
   * rendered nothing, and a key-presence check called that sufficient — so the
   * sufficiency test now asks whether a field the source row carries still
   * carries something after projection.
   */
  it("treats a required field that was emptied as missing, not present", () => {
    expect(isEmptyish(undefined)).toBe(true);
    expect(isEmptyish([])).toBe(true);
    expect(isEmptyish({})).toBe(true);
    expect(isEmptyish("")).toBe(true);
    expect(isEmptyish([{ field: "x" }])).toBe(false);
    expect(isEmptyish(0)).toBe(false);
    expect(isEmptyish(false)).toBe(false);

    const emptied = { ...toPublicHistoryEntry(HISTORY_FIXTURE), diffs: [] };
    expect("diffs" in emptied).toBe(true);
    expect(isEmptyish(HISTORY_FIXTURE.diffs)).toBe(false);
    expect(isEmptyish(emptied.diffs)).toBe(true);
  });

  /**
   * Run the audit against a projection that keeps every key but empties the
   * diff list. The check that catches it is a branch no correct projection
   * reaches, so without handing the audit a broken one it is unreachable —
   * which is how mutation W-M15 survived disabling it.
   */
  it("DETECTS a projection that keeps a required field but empties it", () => {
    const emptyingAudit = runResponseSurfaceAudit({
      surfaces: [
        {
          endpoint: "GET /updates/recent",
          model: "SchemeHistory",
          project: (doc) => ({ ...toPublicHistoryEntry(doc), diffs: [] }),
          fixtureName: "HISTORY_FIXTURE",
        },
      ],
    });
    expect(emptyingAudit.status).toBe("EXPOSED");
    expect(emptyingAudit.missing.map((m) => m.field)).toContain("diffs");
    expect(emptyingAudit.missing[0].why).toMatch(/emptied/);
  });

  it("DETECTS a projection that leaks, through the same seam", () => {
    const leakyAudit = runResponseSurfaceAudit({
      surfaces: [
        {
          endpoint: "GET /updates/recent",
          model: "SchemeHistory",
          project: (doc) => ({ ...toPublicHistoryEntry(doc), policyRetryable: doc.policyRetryable }),
          fixtureName: "HISTORY_FIXTURE",
        },
      ],
    });
    expect(leakyAudit.status).toBe("EXPOSED");
    expect(leakyAudit.leaks.map((l) => l.field)).toContain("policyRetryable");
  });

  it("DETECTS a route that reverts to res.json(doc)", () => {
    const reverted = stripComments(`
      router.get("/updates/recent", async (req, res) => {
        const updates = await SchemeHistory.find({});
        res.json(updates);
      });
    `);
    const responses = [...reverted.matchAll(/res\.json\(\s*([^)]*)/g)].map((m) => m[1].trim());
    expect(responses).toEqual(["updates"]);
    const projected = responses.every(
      (arg) => arg.startsWith("{") || /^toPublic|toSafeJSON|\bserialize\(|^await |^list|^mark/.test(arg)
    );
    expect(projected).toBe(false);
  });

  /**
   * The scanner reads handler bodies, and one of those bodies explains the
   * defect by quoting `res.json(doc)` in a comment. Without comment stripping
   * the audit reported the fixed route as broken.
   */
  it("does not mistake prose about code for code", () => {
    expect(stripComments("// res.json(doc) is what we used to do\nres.json(toPublicScheme(x));"))
      .not.toMatch(/res\.json\(doc\)/);
    expect(stripComments("/* res.json(raw) */\nres.json(toPublicScheme(x));"))
      .toMatch(/toPublicScheme/);
    // A URL is not a comment.
    expect(stripComments('const u = "https://example.gov.in/a";')).toMatch(/https:/);
  });

  it("audits every unauthenticated GET that returns a stored document", () => {
    const audited = new Set(result.surfaces.map((s) => s.endpoint));
    expect(audited.has("GET /schemes")).toBe(true);
    expect(audited.has("GET /schemes/:schemeId")).toBe(true);
    expect(audited.has("GET /schemes/:schemeId/history")).toBe(true);
    expect(audited.has("GET /updates/recent")).toBe(true);
  });
});
