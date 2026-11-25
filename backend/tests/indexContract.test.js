/**
 * PHASE Y — the guarantee that lives in the database, not in a function.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * Four production paths treat a duplicate-key error as "already done" and
 * continue: the in-app notification writer, the email notifier, the propagation
 * pass, and the RAG indexer. Each is exactly-once ONLY because a unique index
 * rejects the second insert — the services say so explicitly, and say why the
 * pre-check cannot be the guarantee (two concurrent runs can both pass it).
 *
 * Phases Q through X verify code. This one cannot be verified by running code:
 * the mechanism is not in the process. What CAN be checked in process is the
 * contract — that every index the code depends on is declared, that every index
 * declared is on the operator's checklist, and that the checklist does not send
 * someone to verify a set that no longer matches the schemas.
 *
 * It had. The checklist listed 8 indexes while the models declared 47, and
 * omitted three of the six unique ones — including
 * `notifications.uniq_user_scheme_change_channel`, which is the whole
 * exactly-once guarantee for the in-app inbox.
 */
const fs = require("fs");
const path = require("path");

const {
  runIndexContract,
  declaredIndexes,
  documentedIndexes,
  documentsIndex,
  liveIndexes,
  checklistRows,
  collectionNameFor,
  indexNameFor,
  sameSpec,
  verifyDependency,
  CONSTRAINT_DEPENDENCIES,
  DUPLICATE_KEY_PATTERN,
  OUTCOME,
} = require("../src/evaluation/indexContract");
const { stripComments } = require("../src/evaluation/responseSurface");

const BACKEND = path.join(__dirname, "..");
const readSrc = (rel) => fs.readFileSync(path.join(BACKEND, rel), "utf8");

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------
describe("Y — the checklist matches the schemas", () => {
  const result = runIndexContract();

  it("documents every index the models declare", () => {
    const undocumented = result.findings.filter((f) => f.outcome === OUTCOME.UNDOCUMENTED);
    if (undocumented.length > 0) {
      // eslint-disable-next-line no-console
      console.log("undocumented:", undocumented.map((f) => f.detail).join("\n"));
    }
    expect(undocumented).toEqual([]);
  });

  it("does not send an operator looking for indexes nothing declares", () => {
    expect(result.findings.filter((f) => f.outcome === OUTCOME.DOCUMENTED_BUT_UNDECLARED)).toEqual([]);
  });

  /**
   * The three that were missing. Named individually rather than counted,
   * because each is a different subsystem's exactly-once guarantee and a
   * count would not say which one came back.
   */
  it("covers the unique indexes the checklist used to omit", () => {
    const documented = documentedIndexes();
    for (const [collection, name] of [
      ["notifications", "uniq_user_scheme_change_channel"],
      ["schemes", "schemeId_1"],
      ["schemechunks", "chunkId_1"],
    ]) {
      expect(documentsIndex(documented, { collection, name })).toBe(true);
      const row = documented.find((r) => r.collection === collection && r.names.includes(name));
      expect(row.unique).toBe(true);
    }
  });

  it("marks a declared-unique index as unique in the checklist too", () => {
    const documented = documentedIndexes();
    for (const index of declaredIndexes().filter((d) => d.unique)) {
      const row = documented.find(
        (r) => r.collection === index.collection && r.names.includes(index.name)
      );
      expect(row).toBeDefined();
      expect(row.unique).toBe(true);
    }
  });

  it("reports CONSISTENT overall", () => {
    if (result.status !== "CONSISTENT") {
      // eslint-disable-next-line no-console
      console.log("findings:", JSON.stringify(result.findings.slice(0, 5), null, 2));
    }
    expect(result.findings).toEqual([]);
    expect(result.status).toBe("CONSISTENT");
  });
});

// ---------------------------------------------------------------------------
// The independent anchor
// ---------------------------------------------------------------------------
describe("Y — every uniqueness the code depends on is declared", () => {
  /**
   * The dependency table is only worth anything if it still describes the code.
   * Both halves are asserted: the file must still catch a duplicate-key error,
   * and it must still reference the model it was recorded against. A rename
   * breaks this rather than silently emptying the audit.
   */
  it("still describes what the services actually do", () => {
    expect(CONSTRAINT_DEPENDENCIES.length).toBe(4);
    for (const dep of CONSTRAINT_DEPENDENCIES) {
      const checked = verifyDependency(dep);
      expect(checked.present).toBe(true);
      expect(checked.catchesDuplicateKey).toBe(true);
      expect(checked.referencesModel).toBe(true);
    }
  });

  /**
   * And nothing NEW depends on a constraint without being recorded. Without
   * this, a fifth service could start relying on a duplicate-key error and the
   * audit would keep reporting four.
   */
  it("finds no service depending on a constraint the table does not list", () => {
    const dir = path.join(BACKEND, "src", "services");
    const recorded = new Set(CONSTRAINT_DEPENDENCIES.map((d) => d.file));
    const dependent = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith(".js"))
      .filter((f) => DUPLICATE_KEY_PATTERN.test(fs.readFileSync(path.join(dir, f), "utf8")));
    for (const file of dependent) expect(recorded.has(file)).toBe(true);
    expect(dependent.length).toBe(CONSTRAINT_DEPENDENCIES.length);
  });

  it("has a unique declaration behind every one of them", () => {
    const result = runIndexContract();
    expect(result.findings.filter((f) => f.outcome === OUTCOME.UNBACKED)).toEqual([]);
    const declared = declaredIndexes();
    for (const dep of CONSTRAINT_DEPENDENCIES) {
      const match = declared.find((d) => d.model === dep.model && sameSpec(d.spec, dep.spec));
      expect(match).toBeDefined();
      expect(match.unique).toBe(true);
    }
  });

  /**
   * The anchor is independent in the direction that matters: it is read from
   * the code that DEPENDS on the constraint, not from the code that DECLARES
   * it. Deleting `unique: true` from a schema and from the checklist together
   * still leaves this dependency behind.
   */
  it("reads its requirement from the dependent code, not from the declaration", () => {
    const src = readSrc("src/evaluation/indexContract.js");
    const table = stripComments(src).slice(
      stripComments(src).indexOf("const CONSTRAINT_DEPENDENCIES"),
      stripComments(src).indexOf("const DUPLICATE_KEY_PATTERN")
    );
    // The table names services and models — it never reads schema options.
    expect(table).toMatch(/notificationService\.js/);
    expect(table).not.toMatch(/schema\.obj|indexes_|unique:\s*true/);
  });
});

// ---------------------------------------------------------------------------
// Reading the schemas
// ---------------------------------------------------------------------------
describe("Y — the declared set is read from the models", () => {
  const declared = declaredIndexes();

  it("finds every collection, not just the documented ones", () => {
    const collections = [...new Set(declared.map((d) => d.collection))].sort();
    expect(collections).toEqual([
      "notificationlogs",
      "notifications",
      "recommendationhistories",
      "schemechunks",
      "schemehistories",
      "schemes",
      "users",
    ]);
  });

  it("finds both field-level and compound declarations", () => {
    expect(declared.some((d) => d.kind === "field" && d.name === "chunkId_1" && d.unique)).toBe(true);
    expect(
      declared.some((d) => d.kind === "compound" && d.name === "uniq_user_scheme_change_channel" && d.unique)
    ).toBe(true);
  });

  /**
   * `schema.indexes_` (trailing underscore) was believed to be needed
   * because `schema.indexes()` "doesn't exist on the sandbox stub" — but no
   * such stub exists anywhere in this project (searched the full tree; only
   * this comment referenced it), and `schema.indexes()` IS real Mongoose's
   * genuine public method. Confirmed by an actual real-Jest run:
   * `schema.indexes_` was always `undefined`, so every COMPOUND index this
   * project declares (dedup keys, uniqueness constraints — the exact things
   * Y.2 exists to protect) was silently invisible to this evaluator. This
   * test used to assert the broken implementation was present; it now
   * asserts the corrected one is.
   */
  it("reads indexes through Mongoose's own schema.indexes(), not a private/nonexistent property", () => {
    const src = stripComments(readSrc("src/evaluation/indexContract.js"));
    expect(src).toMatch(/schema\.indexes\(\)/);
    expect(src).not.toMatch(/indexes_/);
    expect(declared.length).toBeGreaterThan(40);
  });

  it("derives Mongo's own collection and index names", () => {
    expect(collectionNameFor("Notification")).toBe("notifications");
    expect(collectionNameFor("RecommendationHistory")).toBe("recommendationhistories");
    expect(collectionNameFor("SchemeChunk")).toBe("schemechunks");
    expect(indexNameFor({ userId: 1, createdAt: -1 })).toBe("userId_1_createdAt_-1");
  });

  /**
   * The pluraliser is a guess about Mongoose's behaviour, so it is checked
   * against every real model rather than trusted — a wrong collection name
   * would compare a declared index against the wrong live collection and report
   * a phantom failure.
   */
  it("names every real model's collection without a special case", () => {
    for (const [model, expected] of [
      ["Notification", "notifications"],
      ["NotificationLog", "notificationlogs"],
      ["RecommendationHistory", "recommendationhistories"],
      ["Scheme", "schemes"],
      ["SchemeChunk", "schemechunks"],
      ["SchemeHistory", "schemehistories"],
      ["User", "users"],
    ]) {
      expect(collectionNameFor(model)).toBe(expected);
    }
  });

  it("compares index specs without caring about key order", () => {
    expect(sameSpec({ a: 1, b: -1 }, { b: -1, a: 1 })).toBe(true);
    expect(sameSpec({ a: 1 }, { a: -1 })).toBe(false);
    expect(sameSpec({ a: 1 }, { a: 1, b: 1 })).toBe(false);
  });

  /**
   * `profile.state`, `profile.age` and `profile.annualIncome` each back a
   * real single-field PolicyImpactAgent band query (deriveCandidateFilter in
   * src/agents/policyImpactAgent.js narrows on exactly one of these when only
   * that rule changed). `profile.categories` does not: category-rule diffs
   * are AND-of-OR and always fall back to a full scan, so no production code
   * ever filters on `profile.categories`. It was a dead index — declared but
   * never read through — until Phase Y's checklist audit surfaced it as
   * undocumented and this investigation removed `index: true` from it rather
   * than just adding a checklist row. This test pins that decision so a
   * future edit to User.js re-adding it silently doesn't go unnoticed.
   */
  it("indexes the three profile fields PolicyImpactAgent actually queries, and not the one it never does", () => {
    const names = declared.filter((d) => d.collection === "users").map((d) => d.name);
    expect(names).toEqual(
      expect.arrayContaining(["profile.state_1", "profile.age_1", "profile.annualIncome_1"])
    );
    expect(names).not.toContain("profile.categories_1");
  });
});

// ---------------------------------------------------------------------------
// The live check is honest about not having run
// ---------------------------------------------------------------------------
describe("Y — an unobserved index is never reported as present", () => {
  /**
   * The failure mode this whole phase exists to prevent is treating a
   * declaration as a fact. An evaluation that quietly reported "fine" when it
   * could not reach a database would be the same mistake one level up.
   */
  it("reports NOT MEASURED with a reason when there is no database", async () => {
    const withoutUri = await liveIndexes({ uri: "" });
    expect(withoutUri.status).toBe("NOT MEASURED");
    expect(withoutUri.reason).toMatch(/MONGODB_URI/);
    expect(withoutUri.collections).toEqual({});
  });

  /**
   * `liveIndexes()` defaults to an 8s Mongo `serverSelectionTimeoutMS` before
   * it can honestly report NOT MEASURED for an unreachable host — reasonable
   * for a real connection attempt. Jest's own default per-test timeout is
   * 5s, which is SHORTER, so under real Jest this test was being killed by
   * Jest ("Exceeded timeout of 5000 ms") before the function ever got the
   * chance to return its own honest NOT MEASURED. That's a test-harness gap,
   * not a defect in `liveIndexes()` itself — it was always going to resolve
   * correctly, just not within Jest's default window. Given an explicit
   * per-test timeout longer than the function's own, it does.
   */
  it("reports NOT MEASURED, not a false pass, when it can't reach a database", async () => {
    const stubbed = await liveIndexes({ uri: "mongodb://localhost:27017/test", timeoutMs: 3000 });
    expect(stubbed.status).toBe("NOT MEASURED");
    // Either the stub is detected, or a real driver failed to connect. Both are
    // NOT MEASURED; neither is a pass.
    expect(typeof stubbed.reason).toBe("string");
    expect(stubbed.reason.length).toBeGreaterThan(0);
  }, 10000);

  it("never turns NOT MEASURED into a passing live check", () => {
    const result = runIndexContract({
      live: { status: "NOT MEASURED", reason: "no database", collections: {} },
    });
    expect(result.live.status).toBe("NOT MEASURED");
    // No live outcome may be produced from an unmeasured read.
    for (const f of result.findings) {
      expect([OUTCOME.MISSING_LIVE, OUTCOME.NOT_UNIQUE_LIVE, OUTCOME.STILL_BUILDING]).not.toContain(
        f.outcome
      );
    }
  });
});

// ---------------------------------------------------------------------------
// The audit can fail
// ---------------------------------------------------------------------------
describe("Y — the contract check is falsifiable", () => {
  const tmpdir = fs.mkdtempSync(path.join(require("os").tmpdir(), "phase-y-"));
  const writeChecklist = (rows) => {
    const file = path.join(tmpdir, `${Math.random().toString(36).slice(2)}.md`);
    fs.writeFileSync(
      file,
      "| Collection | Index | Purpose | Unique |\n|---|---|---|---|\n" +
        rows.map((r) => `| \`${r.collection}\` | \`${r.name}\` | x | ${r.unique ? "**Yes**" : "No"} |`).join("\n") +
        "\n"
    );
    return file;
  };

  /**
   * The pre-Phase-Y checklist, reproduced: the eight rows it actually had.
   * If the audit cannot fail on that, it is decoration.
   */
  it("DETECTS the checklist that shipped before Phase Y", () => {
    const legacy = writeChecklist([
      { collection: "recommendationhistories", name: "uniq_user_scheme_change", unique: true },
      { collection: "recommendationhistories", name: "userId_1_createdAt_-1", unique: false },
      { collection: "recommendationhistories", name: "processingJobId_1_createdAt_-1", unique: false },
      { collection: "schemehistories", name: "schemeId_1_version_1", unique: false },
      { collection: "schemehistories", name: "policyRetryable_1_createdAt_1", unique: false },
      { collection: "notificationlogs", name: "email_1_schemeId_1_version_1_channel_1", unique: true },
      { collection: "users", name: "email_1", unique: true },
      { collection: "users", name: "profile.state_1_profile.annualIncome_1", unique: false },
    ]);
    const result = runIndexContract({ checklist: legacy });
    expect(result.status).toBe("INCONSISTENT");
    const undocumented = result.findings.filter((f) => f.outcome === OUTCOME.UNDOCUMENTED);
    expect(undocumented.length).toBeGreaterThan(30);
    // The three unique ones it omitted are what made it dangerous rather than untidy.
    const names = undocumented.filter((f) => f.unique).map((f) => `${f.collection}.${f.name}`);
    expect(names).toContain("notifications.uniq_user_scheme_change_channel");
    expect(names).toContain("schemes.schemeId_1");
    expect(names).toContain("schemechunks.chunkId_1");
  });

  it("DETECTS a checklist asking for an index nothing declares", () => {
    const rows = checklistRows().map((r) => ({ collection: r.collection, name: r.name, unique: r.unique }));
    rows.push({ collection: "users", name: "favouriteColour_1", unique: false });
    const result = runIndexContract({ checklist: writeChecklist(rows) });
    expect(result.status).toBe("INCONSISTENT");
    expect(
      result.findings.some(
        (f) => f.outcome === OUTCOME.DOCUMENTED_BUT_UNDECLARED && f.name === "favouriteColour_1"
      )
    ).toBe(true);
  });

  /**
   * Y.2's branch is unreachable while every model is correct, so it is
   * exercised through the injection seam: a declared set with the unique flag
   * stripped, against the same real dependency table. Mutation Y-M10 disabled
   * this branch and survived until this test existed.
   */
  it("DETECTS a dependency whose index is declared but NOT unique", () => {
    const weakened = declaredIndexes().map((d) =>
      d.name === "uniq_user_scheme_change_channel" ? { ...d, unique: false } : d
    );
    const result = runIndexContract({ declared: weakened });
    expect(result.status).toBe("INCONSISTENT");
    const unbacked = result.findings.filter((f) => f.outcome === OUTCOME.UNBACKED);
    expect(unbacked.length).toBe(1);
    expect(unbacked[0].detail).toMatch(/notificationService\.js/);
    expect(unbacked[0].detail).toMatch(/not declared unique/);
    expect(unbacked[0].why).toMatch(/exactly-once/);
  });

  it("DETECTS a dependency with no matching index at all", () => {
    const stripped = declaredIndexes().filter((d) => d.name !== "chunkId_1");
    const result = runIndexContract({ declared: stripped });
    const unbacked = result.findings.filter((f) => f.outcome === OUTCOME.UNBACKED);
    expect(unbacked.length).toBe(1);
    expect(unbacked[0].detail).toMatch(/SchemeChunk declares no index/);
  });

  it("DETECTS a missing index on a live cluster", () => {
    const result = runIndexContract({
      live: {
        status: "MEASURED",
        reason: null,
        collections: { notifications: [] },
      },
    });
    expect(result.status).toBe("INCONSISTENT");
    expect(
      result.findings.some(
        (f) => f.outcome === OUTCOME.MISSING_LIVE && f.name === "uniq_user_scheme_change_channel"
      )
    ).toBe(true);
  });

  /**
   * The subtlest live failure, and the one the checklist warns about in prose:
   * the index exists, so `getIndexes()` looks healthy, but it carries no unique
   * flag. It speeds up reads and guarantees nothing.
   */
  it("DETECTS an index that exists on the cluster WITHOUT its unique flag", () => {
    const declared = declaredIndexes();
    const collections = {};
    for (const d of declared) {
      collections[d.collection] = collections[d.collection] || [];
      collections[d.collection].push({
        name: d.name,
        key: d.spec,
        // every index present, but the uniqueness quietly dropped
        unique: false,
      });
    }
    const result = runIndexContract({ live: { status: "MEASURED", reason: null, collections } });
    const notUnique = result.findings.filter((f) => f.outcome === OUTCOME.NOT_UNIQUE_LIVE);
    expect(notUnique.length).toBe(declared.filter((d) => d.unique).length);
    expect(notUnique.map((f) => f.name)).toContain("uniq_user_scheme_change_channel");
  });

  it("DETECTS an index that is still building", () => {
    const declared = declaredIndexes();
    const collections = {};
    for (const d of declared) {
      collections[d.collection] = collections[d.collection] || [];
      collections[d.collection].push({ name: d.name, key: d.spec, unique: d.unique, building: true });
    }
    const result = runIndexContract({ live: { status: "MEASURED", reason: null, collections } });
    expect(result.findings.filter((f) => f.outcome === OUTCOME.STILL_BUILDING).length).toBe(declared.length);
  });
});
