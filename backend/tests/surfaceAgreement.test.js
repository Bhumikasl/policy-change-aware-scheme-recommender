/**
 * PHASE X — the three recommendation surfaces must tell the user one story.
 *
 * ---------------------------------------------------------------------------
 * THE GAP THIS CLOSES
 * ---------------------------------------------------------------------------
 * Q verifies candidate selection. T verifies the ranker is a function of its
 * inputs. U verifies the matcher. V verifies detection. W verifies the
 * serialization boundary. Every one of them examines a single mechanism.
 *
 * The user, though, is told their recommendations by three different paths —
 * the matches page, the chat assistant, and the propagation pass behind the
 * audit trail and the notification emails. Each assembled its own candidate
 * list. Two of them carried comments saying the shapes had to match, which is a
 * hope rather than a mechanism, and they did not match: the propagation copy
 * omitted `documentReadiness`, so the ranker's readiness term was silently
 * zeroed there and only there.
 *
 * T could not catch it. T proves that ranking the same candidates twice gives
 * the same answer — it never asks whether the three callers hand it the same
 * candidates.
 */
const {
  runSurfaceAgreement,
  compareSurfaces,
  expectedMembership,
  referenceIsOpen,
  shapeOf,
  orderOf,
  membershipOf,
  SURFACES,
  RANKER_CANDIDATE_FIELDS,
  USERS,
  UNIVERSES,
} = require("../src/evaluation/surfaceAgreement");
const {
  buildCandidates,
  computeRecommendationState,
  isActive,
} = require("../src/services/recommendationPropagation");
const { rankCandidates } = require("../src/services/relevanceRanker");
const { getDocumentReadiness } = require("../src/services/matcher");
const { UNIVERSES: CORPUS } = require("../src/evaluation/surfaceCorpus");
const { stripComments } = require("../src/evaluation/responseSurface");

const fs = require("fs");
const path = require("path");

const readySrc = (rel) =>
  fs.readFileSync(path.join(__dirname, "..", "src", rel), "utf8");

const fullUser = USERS[0].user;
const readinessUniverse = CORPUS.find((u) => u.label === "readiness reversed against alphabetical order").schemes;

// ---------------------------------------------------------------------------
// The defect
// ---------------------------------------------------------------------------
describe("X — every ranking surface hands the ranker a complete candidate", () => {
  /**
   * The one-line defect. `computeRecommendationState` built
   * `{scheme, verdict}`; the ranker reads `candidate.documentReadiness` and
   * scores 0 .. 1.5 from it. Absent, that term is silently zero — no error, no
   * warning, a different ordering.
   */
  it("includes documentReadiness in the propagation candidate set", () => {
    const candidates = buildCandidates(fullUser, readinessUniverse);
    expect(candidates.length).toBeGreaterThan(0);
    for (const c of candidates) {
      expect(c.documentReadiness).toBeDefined();
      expect(typeof c.documentReadiness.required).toBe("number");
      expect(typeof c.documentReadiness.have).toBe("number");
    }
  });

  it("matches getDocumentReadiness exactly, rather than approximating it", () => {
    for (const c of buildCandidates(fullUser, readinessUniverse)) {
      expect(c.documentReadiness).toEqual(getDocumentReadiness(fullUser, c.scheme));
    }
  });

  /**
   * The consequence, on the corpus case built for it: the user holds the papers
   * for `b-papers-ready` and not for `a-papers-missing`. With the field, the
   * ready scheme is first. Without it the two tie on everything, and the Phase T
   * schemeId tie-break — working exactly as designed — orders them
   * alphabetically, putting the scheme the user cannot apply for at rank 1.
   */
  it("ranks the scheme the user can actually apply for first", () => {
    const state = computeRecommendationState(fullUser, readinessUniverse);
    expect(orderOf(state.ranked)).toEqual(["b-papers-ready", "a-papers-missing"]);
    expect(state.byScheme.get("b-papers-ready").rank).toBe(1);
  });

  /**
   * The audit trail is built from `byScheme`, and rank-change notifications
   * are classified from it. A wrong ranking here is a wrong assertion sent to
   * a user and a wrong row in the evidence trail.
   */
  it("writes that same ranking into the history state", () => {
    const state = computeRecommendationState(fullUser, readinessUniverse);
    const ready = state.byScheme.get("b-papers-ready");
    const missing = state.byScheme.get("a-papers-missing");
    expect(ready.rank).toBeLessThan(missing.rank);
    expect(ready.relevance).toBeGreaterThan(missing.relevance);
  });

  /**
   * Guards the ordering claim above against becoming vacuous: if a later change
   * made readiness stop affecting this corpus case, the test would keep passing
   * for the wrong reason.
   */
  it("the readiness term really is what decides that order", () => {
    const candidates = buildCandidates(fullUser, readinessUniverse);
    const withField = orderOf(rankCandidates(candidates, fullUser));
    const withoutField = orderOf(
      rankCandidates(candidates.map(({ documentReadiness, ...rest }) => rest), fullUser)
    );
    expect(withField).not.toEqual(withoutField);
  });
});

// ---------------------------------------------------------------------------
// One assembly, not three
// ---------------------------------------------------------------------------
describe("X — the candidate shape is assembled in exactly one place", () => {
  /**
   * The structural half of the fix. Fixing the field in one copy is what left
   * the other two to drift — chatService carries a comment recording that exact
   * bug being found and fixed *there*, while the propagation copy kept it.
   */
  it("routes every surface through buildCandidates", () => {
    expect(readySrc("services/chatService.js")).toMatch(/buildCandidates\(/);
    expect(readySrc("routes/users.js")).toMatch(/buildCandidates\(/);
    expect(readySrc("services/recommendationPropagation.js")).toMatch(/buildCandidates\(/);
  });

  it("leaves no surface assembling its own {scheme, verdict} list", () => {
    for (const rel of ["services/chatService.js", "routes/users.js"]) {
      const src = readySrc(rel);
      // The tell-tale of a hand-rolled copy: calling the matcher to build a
      // candidate rather than asking for one.
      expect(src).not.toMatch(/verdict:\s*evaluateEligibility\(/);
    }
  });

  /**
   * `GET /matches` gated on `status: "Active"` — an exact, case-sensitive Mongo
   * equality — while both other surfaces used `isActive`, which also accepts
   * "active" and a blank status. The file exporting `isActive` says in as many
   * words that two copies of that rule would drift; this was a third.
   */
  it("gates status through the shared rule, with the query as a superset", () => {
    // Comments stripped first, reusing Phase W's helper. The route's own
    // comment explains the defect by quoting the old filter, and without this
    // the check reads that quotation as live code — the same false alarm W-M's
    // wiring scanner hit, in a different file.
    const src = stripComments(readySrc("routes/users.js"));
    // No route in this file may narrow the universe with an exact status
    // equality: the /matches ranking surface and the /matches/stats endpoint
    // that explains its numbers must count the same schemes.
    expect(src).not.toMatch(/status:\s*"Active"/);
    expect(src).toMatch(/status:\s*\{\s*\$ne:\s*"Closed"\s*\}/);
    // The prefilter must admit everything the shared gate would accept.
    for (const status of ["Active", "active", "ACTIVE", "", undefined]) {
      if (!isActive(status)) continue;
      expect(status !== "Closed").toBe(true);
    }
    expect(isActive("Closed")).toBe(false);
  });

  it("keeps the shared gate's documented semantics", () => {
    expect(isActive("Active")).toBe(true);
    expect(isActive("active")).toBe(true);
    expect(isActive("")).toBe(true);
    expect(isActive(undefined)).toBe(true);
    expect(isActive("Closed")).toBe(false);
  });

  /**
   * `buildCandidates` must hand back the scheme it was given. GET /matches
   * calls `.toObject()` on it afterwards, so converting inside the builder
   * would break the page.
   */
  it("passes the scheme object through untouched", () => {
    const doc = {
      schemeId: "doc-shaped",
      status: "Active",
      documents: [],
      category: [],
      tags: [],
      eligibilityRules: { ...readinessUniverse[0].eligibilityRules },
      toObject() {
        return { schemeId: "doc-shaped", converted: true };
      },
    };
    const [candidate] = buildCandidates(fullUser, [doc]);
    expect(typeof candidate.scheme.toObject).toBe("function");
  });
});

// ---------------------------------------------------------------------------
// Independence of the check
// ---------------------------------------------------------------------------
describe("X — membership is not graded only by agreement with itself", () => {
  /**
   * Three surfaces sharing one bug agree perfectly, so membership is also
   * checked against a reference built on the Phase U implementation, which does
   * not import services/matcher.js.
   */
  it("builds its expectation without the production matcher or status gate", () => {
    const src = fs.readFileSync(
      path.join(__dirname, "..", "src", "evaluation", "surfaceAgreement.js"),
      "utf8"
    );
    // The expectation function must not reach for production eligibility.
    const expectation = src.slice(
      src.indexOf("function referenceIsOpen"),
      src.indexOf("// The three surfaces")
    );
    expect(expectation).toMatch(/referenceEligibility/);
    expect(expectation).not.toMatch(/evaluateEligibility/);
    expect(expectation).not.toMatch(/\bisActive\(/);
  });

  it("agrees with production on who belongs in the candidate set", () => {
    for (const { user } of USERS) {
      for (const universe of UNIVERSES) {
        const built = membershipOf(buildCandidates(user, universe.schemes));
        expect(built).toEqual(expectedMembership(user, universe.schemes));
      }
    }
  });

  it("reads the status rule the same way as production, restated not imported", () => {
    for (const status of ["Active", "active", "ACTIVE", "", "Closed", "Expired", undefined]) {
      expect(referenceIsOpen({ status })).toBe(isActive(status));
    }
  });

  /**
   * The candidate-field list comes from the ranker's documented contract, not
   * from whatever the builder emits — otherwise any consistent mistake would be
   * graded correct.
   */
  it("takes the candidate contract from the ranker's own documentation", () => {
    const src = readySrc("services/relevanceRanker.js");
    for (const field of RANKER_CANDIDATE_FIELDS) {
      expect(src).toMatch(new RegExp(field));
    }
    expect(RANKER_CANDIDATE_FIELDS).toContain("documentReadiness");
  });
});

// ---------------------------------------------------------------------------
// The harness can fail
// ---------------------------------------------------------------------------
describe("X — the agreement check is falsifiable", () => {
  /**
   * The pre-Phase-X propagation surface, reproduced on demand through the
   * injection seam. If the harness cannot fail on the bug it was written for,
   * it is decoration.
   */
  const legacyPropagation = {
    key: "propagation-legacy",
    label: "pre-X propagation (assembled its own candidates)",
    prefilter: (universe) => universe,
    build: (user, universe) =>
      buildCandidates(user, universe).map(({ documentReadiness, ...rest }) => rest),
    rank: (candidates, user, { intent }) => rankCandidates(candidates, user, { intent }),
  };

  it("DETECTS a surface that drops a candidate field", () => {
    const result = runSurfaceAgreement({ surfaces: [SURFACES[0], legacyPropagation] });
    expect(result.status).toBe("DISAGREE");
    const properties = new Set(result.disagreements.map((d) => d.property));
    expect(properties.has("SHAPE")).toBe(true);
    expect(properties.has("ORDER")).toBe(true);
  });

  /**
   * SHAPE fires wherever the field is missing; ORDER only where it changes the
   * result. The shape property is the sensitive one, and it is what would have
   * caught this before it ever produced a wrong ranking.
   */
  it("catches the dropped field more often by shape than by order", () => {
    const result = runSurfaceAgreement({ surfaces: [SURFACES[0], legacyPropagation] });
    const shape = result.disagreements.filter((d) => d.property === "SHAPE").length;
    const order = result.disagreements.filter((d) => d.property === "ORDER").length;
    expect(shape).toBeGreaterThan(order);
    expect(order).toBeGreaterThan(0);
  });

  /**
   * The limit of differential testing, and the reason SHAPE is also checked
   * against the ranker's contract. Phase X made all three surfaces share one
   * builder — so a defect IN that builder breaks them identically and they go
   * on agreeing with each other. Mutation X-M1 (the original defect,
   * reintroduced into the shared builder) left the harness reporting AGREE
   * until this check existed.
   */
  it("DETECTS all surfaces missing a field together, via the ranker's contract", () => {
    const strips = (key) => ({
      key,
      label: key,
      prefilter: (universe) => universe,
      build: (user, universe) =>
        buildCandidates(user, universe).map(({ documentReadiness, ...rest }) => rest),
      rank: (candidates, user) => rankCandidates(candidates, user),
    });
    const result = runSurfaceAgreement({ surfaces: [strips("a"), strips("b")] });
    expect(result.status).toBe("DISAGREE");
    // They agree with each other perfectly — SHAPE and ORDER never fire.
    expect(result.disagreements.every((d) => d.property === "SHAPE_VS_CONTRACT")).toBe(true);
    expect(result.disagreements[0].detail).toMatch(/documentReadiness/);
  });

  /**
   * A user who qualifies for nothing has no candidate shape to check.
   * Reporting one would make every such user look like a contract violation,
   * and a check that cries wolf on correct behaviour gets switched off.
   */
  it("does not fault a surface for an empty candidate set", () => {
    const outsider = USERS.find((u) => u.label === "outside the state most schemes target");
    const keralaOnly = UNIVERSES.find((u) => u.label === "readiness reversed against alphabetical order");
    const result = compareSurfaces(outsider.user, keralaOnly.schemes);
    expect(result.perSurface.matches.membership).toEqual([]);
    expect(result.disagreements).toEqual([]);
  });

  it("DETECTS a surface that selects a different set of schemes", () => {
    const dropsOne = {
      key: "drops-one",
      label: "a surface that loses a scheme",
      prefilter: (universe) => universe.slice(1),
      build: (user, universe) => buildCandidates(user, universe),
      rank: (candidates, user) => rankCandidates(candidates, user),
    };
    const result = runSurfaceAgreement({ surfaces: [SURFACES[0], dropsOne] });
    expect(result.status).toBe("DISAGREE");
    expect(result.disagreements.some((d) => d.property === "MEMBERSHIP")).toBe(true);
  });

  /**
   * And the case differential testing alone cannot catch: every surface wrong
   * in the same way. Caught only by the independent reference.
   */
  it("DETECTS all surfaces agreeing on the WRONG membership", () => {
    const wrongButConsistent = (key) => ({
      key,
      label: key,
      prefilter: (universe) => universe,
      // Admits closed schemes — a mistake all surfaces make together.
      build: (user, universe) =>
        buildCandidates(user, universe.map((s) => ({ ...s, status: "Active" }))),
      rank: (candidates, user) => rankCandidates(candidates, user),
    });
    const result = runSurfaceAgreement({
      surfaces: [wrongButConsistent("a"), wrongButConsistent("b")],
      universes: UNIVERSES.filter((u) => u.label === "status gate boundaries"),
    });
    expect(result.status).toBe("DISAGREE");
    expect(result.disagreements.every((d) => d.property === "MEMBERSHIP_VS_REFERENCE")).toBe(true);
  });

  it("reports the shape as the set of fields actually populated", () => {
    expect(shapeOf([{ scheme: {}, verdict: {}, documentReadiness: {} }])).toEqual([
      "documentReadiness",
      "scheme",
      "verdict",
    ]);
    expect(shapeOf([{ scheme: {}, verdict: {} }])).toEqual(["scheme", "verdict"]);
    // null counts as absent — a field set to null scores zero just the same.
    expect(shapeOf([{ scheme: {}, verdict: {}, documentReadiness: null }])).toEqual([
      "scheme",
      "verdict",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------
describe("X — the sweep over the current code", () => {
  const result = runSurfaceAgreement();

  it("finds the three surfaces in agreement", () => {
    if (result.status !== "AGREE") {
      // eslint-disable-next-line no-console
      console.log("first disagreement:", JSON.stringify(result.disagreements[0], null, 2));
    }
    expect(result.disagreements).toEqual([]);
    expect(result.status).toBe("AGREE");
  });

  /**
   * AGREE over a corpus where no candidate field ever decides anything would be
   * vacuous — the dropped field scores zero rather than throwing, so it is only
   * visible where it is the deciding term.
   */
  it("is not a vacuous pass", () => {
    expect(result.comparisons).toBe(USERS.length * UNIVERSES.length);
    expect(result.comparisons).toBeGreaterThan(20);
    expect(result.readinessDecisive).toBeGreaterThan(0);
    expect(result.surfaces).toBe(3);
    // Some comparison must actually produce candidates.
    expect(result.cases.some((c) => c.candidates > 1)).toBe(true);
  });

  it("compares all three real surfaces", () => {
    const keys = SURFACES.map((s) => s.key).sort();
    expect(keys).toEqual(["chat", "matches", "propagation"]);
    for (const c of result.cases) {
      expect(Object.keys(c.perSurface).sort()).toEqual(["chat", "matches", "propagation"]);
    }
  });
});
