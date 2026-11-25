/**
 * Rules-engine tests. Pure unit tests — no DB, no network.
 */
const { evaluateEligibility, isMatch, checkRules } = require("../src/services/matcher");

function user(profile) {
  return { email: "t@example.com", profile: { categories: [], documentsAvailable: [], ...profile } };
}
function scheme(rules, extras = {}) {
  return {
    schemeId: "test",
    name: "Test",
    documents: [],
    eligibilityRules: {
      minAge: null, maxAge: null,
      minAnnualIncome: null, maxAnnualIncome: null,
      minMarksPercentage: null, minEducationLevel: null,
      genders: [], categories: [], occupations: [], states: [],
      source: "structured", eligibilityType: "constrained",
      confidence: 0.7, needsReview: false,
      ...rules,
    },
    ...extras,
  };
}

describe("matcher — age", () => {
  test("age within range passes", () => {
    expect(isMatch(user({ age: 25 }), scheme({ minAge: 18, maxAge: 40 }))).toBe(true);
  });
  test("age below min fails", () => {
    expect(isMatch(user({ age: 15 }), scheme({ minAge: 18, maxAge: 40 }))).toBe(false);
  });
  test("age above max fails", () => {
    expect(isMatch(user({ age: 55 }), scheme({ minAge: 18, maxAge: 40 }))).toBe(false);
  });
  test("missing age when scheme requires age fails (strict)", () => {
    expect(isMatch(user({}), scheme({ minAge: 18, maxAge: 40 }))).toBe(false);
  });
  test("age at boundary passes", () => {
    expect(isMatch(user({ age: 18 }), scheme({ minAge: 18, maxAge: 40 }))).toBe(true);
    expect(isMatch(user({ age: 40 }), scheme({ minAge: 18, maxAge: 40 }))).toBe(true);
  });
});

describe("matcher — income", () => {
  test("income under max passes", () => {
    expect(isMatch(user({ annualIncome: 200000 }), scheme({ maxAnnualIncome: 300000 }))).toBe(true);
  });
  test("income over max fails", () => {
    expect(isMatch(user({ annualIncome: 500000 }), scheme({ maxAnnualIncome: 300000 }))).toBe(false);
  });
  test("missing income when required fails", () => {
    expect(isMatch(user({}), scheme({ maxAnnualIncome: 300000 }))).toBe(false);
  });
});

describe("matcher — gender", () => {
  test("female passes women-only scheme", () => {
    expect(isMatch(user({ gender: "Female" }), scheme({ genders: ["Female"] }))).toBe(true);
  });
  test("male fails women-only scheme", () => {
    expect(isMatch(user({ gender: "Male" }), scheme({ genders: ["Female"] }))).toBe(false);
  });
  test("missing gender fails when required", () => {
    expect(isMatch(user({}), scheme({ genders: ["Female"] }))).toBe(false);
  });
});

describe("matcher — state", () => {
  test("user in listed state matches", () => {
    expect(isMatch(user({ state: "Karnataka" }), scheme({ states: ["Karnataka"] }))).toBe(true);
  });
  test("user in different state fails", () => {
    expect(isMatch(user({ state: "Kerala" }), scheme({ states: ["Karnataka"] }))).toBe(false);
  });
});

describe("matcher — education (ranked)", () => {
  test("post graduate satisfies graduate requirement", () => {
    expect(isMatch(user({ education: "Post Graduate" }), scheme({ minEducationLevel: "Graduate" }))).toBe(true);
  });
  test("12th does not satisfy graduate requirement", () => {
    expect(isMatch(user({ education: "12th Standard" }), scheme({ minEducationLevel: "Graduate" }))).toBe(false);
  });
  test("unknown education string fails a rule", () => {
    expect(isMatch(user({ education: "Nonsense" }), scheme({ minEducationLevel: "Graduate" }))).toBe(false);
  });
});

describe("matcher — strict AND-of-OR on categoryGroups (PwD-student regression)", () => {
  test("scheme for PwD students REJECTS a plain student without PwD category", () => {
    const s = scheme({
      occupations: ["Student"],
      categoryGroups: [["Person with Disability"]],
      categories: ["Person with Disability"],
    });
    // Plain student — no PwD in categories → must FAIL
    expect(isMatch(user({ occupation: "Student" }), s)).toBe(false);
  });
  test("scheme for PwD students ACCEPTS a student who also lists PwD", () => {
    const s = scheme({
      occupations: ["Student"],
      categoryGroups: [["Person with Disability"]],
      categories: ["Person with Disability"],
    });
    expect(isMatch(
      user({ occupation: "Student", categories: ["Person with Disability"] }),
      s,
    )).toBe(true);
  });
  test("SC/ST/OBC or-group: user with only SC still matches", () => {
    const s = scheme({
      categoryGroups: [["SC", "ST", "OBC"]],
      categories: ["SC", "ST", "OBC"],
    });
    expect(isMatch(user({ categories: ["SC"] }), s)).toBe(true);
    expect(isMatch(user({ categories: ["ST"] }), s)).toBe(true);
    expect(isMatch(user({ categories: [] }), s)).toBe(false);
  });
  test("compound: (SC OR ST) AND BPL — user needs one from each group", () => {
    const s = scheme({
      categoryGroups: [["SC", "ST"], ["BPL"]],
      categories: ["SC", "ST", "BPL"],
    });
    expect(isMatch(user({ categories: ["SC", "BPL"] }), s)).toBe(true);
    expect(isMatch(user({ categories: ["ST", "BPL"] }), s)).toBe(true);
    expect(isMatch(user({ categories: ["SC"] }), s)).toBe(false);      // missing BPL group
    expect(isMatch(user({ categories: ["BPL"] }), s)).toBe(false);     // missing caste group
    expect(isMatch(user({ categories: ["OBC", "BPL"] }), s)).toBe(false); // OBC not in first group
  });
  test("flat categories with no groups → each becomes an AND-required singleton", () => {
    // Legacy row: no categoryGroups, multiple categories → treated as AND
    const s = scheme({ categories: ["SC", "Widow"] });
    expect(isMatch(user({ categories: ["SC"] }), s)).toBe(false); // missing Widow
    expect(isMatch(user({ categories: ["SC", "Widow"] }), s)).toBe(true);
  });
});

describe("matcher — categories with woman ↔ female bridging", () => {
  test("female user matches Woman-only scheme even without categories set", () => {
    expect(isMatch(user({ gender: "Female" }), scheme({ categories: ["Woman"] }))).toBe(true);
  });
  test("male user does not match Woman-only scheme", () => {
    expect(isMatch(user({ gender: "Male" }), scheme({ categories: ["Woman"] }))).toBe(false);
  });
  test("SC user matches SC scheme", () => {
    expect(isMatch(user({ categories: ["SC"] }), scheme({ categories: ["SC"] }))).toBe(true);
  });
});

describe("matcher — combined rules", () => {
  test("all pass → eligible", () => {
    const v = evaluateEligibility(
      user({ age: 25, gender: "Female", state: "Karnataka", annualIncome: 200000, education: "Graduate" }),
      scheme({ minAge: 18, maxAge: 40, genders: ["Female"], states: ["Karnataka"], maxAnnualIncome: 300000, minEducationLevel: "Graduate" })
    );
    expect(v.eligible).toBe(true);
    expect(v.positiveMatches.length).toBeGreaterThanOrEqual(5);
  });
  test("one failure kills eligibility even with many matches", () => {
    const v = evaluateEligibility(
      user({ age: 25, gender: "Female", state: "Kerala", annualIncome: 200000 }),
      scheme({ minAge: 18, maxAge: 40, genders: ["Female"], states: ["Karnataka"], maxAnnualIncome: 300000 })
    );
    expect(v.eligible).toBe(false);
    expect(v.failed.map((f) => f.rule)).toContain("state");
  });
});

describe("matcher — eligibilityType semantics", () => {
  test("universal scheme matches user with sparse profile", () => {
    expect(isMatch(
      user({ state: "" }),
      scheme({}, { eligibilityRules: { ...scheme({}).eligibilityRules, eligibilityType: "universal" } })
    )).toBe(true);
  });
  test("universal scheme with state constraint still applies it", () => {
    expect(isMatch(
      user({ state: "Kerala" }),
      scheme({ states: ["Karnataka"] }, { eligibilityRules: { ...scheme({ states: ["Karnataka"] }).eligibilityRules, eligibilityType: "universal" } })
    )).toBe(false);
  });
  test("unknown scheme is excluded by default", () => {
    const s = scheme({});
    s.eligibilityRules.eligibilityType = "unknown";
    expect(isMatch(user({ age: 25 }), s)).toBe(false);
  });
  test("unknown scheme can be included with allowUnknown=true (still needs positive signal)", () => {
    const s = scheme({ states: ["Karnataka"] });
    s.eligibilityRules.eligibilityType = "unknown";
    expect(isMatch(user({ state: "Karnataka" }), s, { allowUnknown: true })).toBe(true);
  });
  test("constrained scheme with zero constraints and matching user does NOT match", () => {
    // Regression for the 650-matches bug: eligibilityType=constrained but no
    // real signals → require a positive match to succeed. With none, it fails.
    const s = scheme({}); // all null / empty
    expect(isMatch(user({ age: 25, state: "Karnataka" }), s)).toBe(false);
  });
});

describe("matcher — score ordering", () => {
  test("more positive matches → higher score", () => {
    const a = evaluateEligibility(
      user({ age: 25, gender: "Female", state: "Karnataka" }),
      scheme({ minAge: 18, maxAge: 40, genders: ["Female"], states: ["Karnataka"] })
    );
    const b = evaluateEligibility(
      user({ age: 25 }),
      scheme({ minAge: 18, maxAge: 40 })
    );
    expect(a.score).toBeGreaterThan(b.score);
  });
});

describe("matcher — checkRules non-strict mode", () => {
  test("non-strict treats missing user fields as noConstraint, not failure", () => {
    const rules = scheme({ minAge: 18, maxAge: 40 }).eligibilityRules;
    const { failed, noConstraint } = checkRules(user({}), rules, { strict: false });
    expect(failed.length).toBe(0);
    expect(noConstraint.map((n) => n.rule)).toContain("age");
  });
});

describe("matcher — tri-state status (ELIGIBLE / NOT_ELIGIBLE / NEEDS_MORE_INFORMATION)", () => {
  test("known failed condition → NOT_ELIGIBLE", () => {
    const v = evaluateEligibility(
      user({ age: 15 }),
      scheme({ minAge: 18, maxAge: 40 })
    );
    expect(v.status).toBe("NOT_ELIGIBLE");
    expect(v.eligible).toBe(false);
  });
  test("all required known conditions satisfied → ELIGIBLE", () => {
    const v = evaluateEligibility(
      user({ age: 25, gender: "Female" }),
      scheme({ minAge: 18, maxAge: 40, genders: ["Female"] })
    );
    expect(v.status).toBe("ELIGIBLE");
    expect(v.eligible).toBe(true);
  });
  test("required information genuinely unknown → NEEDS_MORE_INFORMATION, not NOT_ELIGIBLE", () => {
    const v = evaluateEligibility(
      user({}), // age not provided at all
      scheme({ minAge: 18, maxAge: 40 })
    );
    expect(v.status).toBe("NEEDS_MORE_INFORMATION");
    expect(v.eligible).toBe(false); // still not eligible — just not a rejection
    expect(v.unknown.map((u) => u.rule)).toContain("age");
    expect(v.failed.length).toBe(0);
  });
  test("a genuine failure always outranks an unrelated unknown field", () => {
    // Age fails AND income is unanswered — the known failure must win.
    const v = evaluateEligibility(
      user({ age: 10 }),
      scheme({ minAge: 18, maxAge: 40, maxAnnualIncome: 300000 })
    );
    expect(v.status).toBe("NOT_ELIGIBLE");
  });
  test("AI/verifier layer must never see NOT_ELIGIBLE turned into ELIGIBLE by missing info alone", () => {
    // Sanity check on the boolean/status relationship other services rely on.
    const v = evaluateEligibility(user({}), scheme({ minAge: 18 }));
    expect(v.eligible).toBe(v.status === "ELIGIBLE");
  });
});

describe("matcher — course/stream", () => {
  const s = scheme({ courses: ["Computer Science", "Engineering"] });
  test("matching course passes", () => {
    expect(isMatch(user({ course: "Computer Science" }), s)).toBe(true);
  });
  test("non-matching course (Agriculture) fails", () => {
    const v = evaluateEligibility(user({ course: "Agriculture" }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
  });
  test("missing course → NEEDS_MORE_INFORMATION, not NOT_ELIGIBLE", () => {
    const v = evaluateEligibility(user({}), s);
    expect(v.status).toBe("NEEDS_MORE_INFORMATION");
  });
  test("no course restriction on the scheme → noConstraint", () => {
    const { noConstraint } = checkRules(user({}), scheme({}).eligibilityRules);
    expect(noConstraint.map((n) => n.rule)).toContain("course");
  });
});

describe("matcher — minimum education level (Undergraduate vs Graduate)", () => {
  const ugScheme = scheme({ minEducationLevel: "Undergraduate" });
  const gradScheme = scheme({ minEducationLevel: "Graduate" });

  test("Undergraduate user matches Undergraduate scheme", () => {
    expect(isMatch(user({ education: "Undergraduate" }), ugScheme)).toBe(true);
  });

  test("Undergraduate user fails Graduate scheme", () => {
    const v = evaluateEligibility(user({ education: "Undergraduate" }), gradScheme);
    expect(v.status).toBe("NOT_ELIGIBLE");
    expect(v.failed.map((f) => f.rule)).toContain("education");
  });

  test("Graduate user matches Graduate scheme", () => {
    expect(isMatch(user({ education: "Graduate" }), gradScheme)).toBe(true);
  });
});

describe("matcher — disability requirement and percentage", () => {
  test("disability required, user has none → NOT_ELIGIBLE", () => {
    const s = scheme({ disabilityRequired: true });
    const v = evaluateEligibility(user({ disability: false }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
  });
  test("disability required, user unanswered (null) → NEEDS_MORE_INFORMATION, never NOT_ELIGIBLE", () => {
    const s = scheme({ disabilityRequired: true });
    const v = evaluateEligibility(user({}), s);
    expect(v.status).toBe("NEEDS_MORE_INFORMATION");
  });
  test("disability required, user has it → ELIGIBLE", () => {
    const s = scheme({ disabilityRequired: true });
    expect(isMatch(user({ disability: true }), s)).toBe(true);
  });
  test("30% disability against a 40% requirement fails", () => {
    const s = scheme({ disabilityRequired: true, minDisabilityPercentage: 40 });
    const v = evaluateEligibility(user({ disability: true, disabilityPercentage: 30 }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
  });
  test("40% disability against a 40% requirement passes (boundary)", () => {
    const s = scheme({ disabilityRequired: true, minDisabilityPercentage: 40 });
    expect(isMatch(user({ disability: true, disabilityPercentage: 40 }), s)).toBe(true);
  });
  test("has disability but percentage unanswered → NEEDS_MORE_INFORMATION", () => {
    const s = scheme({ disabilityRequired: true, minDisabilityPercentage: 40 });
    const v = evaluateEligibility(user({ disability: true }), s);
    expect(v.status).toBe("NEEDS_MORE_INFORMATION");
  });
  test("no disability restriction → user's disability status is irrelevant", () => {
    expect(isMatch(user({ disability: false, age: 25, state: "Karnataka" }), scheme({ states: ["Karnataka"] }))).toBe(true);
  });
});

describe("matcher — course equivalence normalization", () => {
  const s = scheme({ courses: ["Computer Science"] });
  test("B.Tech CSE matches Computer Science", () => {
    expect(isMatch(user({ course: "B.Tech CSE" }), s)).toBe(true);
  });
  test("BSc Computer Science matches Computer Science", () => {
    expect(isMatch(user({ course: "BSc Computer Science" }), s)).toBe(true);
  });
  test("Agriculture does not match a Computer Science requirement", () => {
    const v = evaluateEligibility(user({ course: "Agriculture" }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
  });
});

describe("matcher — single girl child", () => {
  const s = scheme({ singleGirlChildRequired: true });
  test("true → ELIGIBLE", () => {
    expect(isMatch(user({ singleGirlChild: true }), s)).toBe(true);
  });
  test("false → NOT_ELIGIBLE", () => {
    const v = evaluateEligibility(user({ singleGirlChild: false }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
  });
  test("unanswered → NEEDS_MORE_INFORMATION", () => {
    const v = evaluateEligibility(user({}), s);
    expect(v.status).toBe("NEEDS_MORE_INFORMATION");
  });
});

describe("matcher — applicant / entity types", () => {
  test("scheme for INSTITUTION hard-rejects individual citizen user", () => {
    const s = scheme({ applicantTypes: ["INSTITUTION"] });
    const v = evaluateEligibility(user({ occupation: "Student" }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
    expect(v.failed.map((f) => f.rule)).toContain("applicantType");
  });

  test("scheme for NGO_SHG hard-rejects individual citizen user", () => {
    const s = scheme({ applicantTypes: ["NGO_SHG"] });
    const v = evaluateEligibility(user({ occupation: "Student" }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
  });

  test("scheme for FACULTY_RESEARCHER hard-rejects Student user", () => {
    const s = scheme({ applicantTypes: ["FACULTY_RESEARCHER"] });
    const v = evaluateEligibility(user({ occupation: "Student" }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
  });

  test("scheme for ENTERPRISE hard-rejects Student user", () => {
    const s = scheme({ applicantTypes: ["ENTERPRISE"] });
    const v = evaluateEligibility(user({ occupation: "Student" }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
  });

  test("scheme for STUDENT matches Student user", () => {
    const s = scheme({ applicantTypes: ["STUDENT"], states: ["Karnataka"] });
    const v = evaluateEligibility(user({ occupation: "Student", state: "Karnataka" }), s);
    expect(v.status).toBe("ELIGIBLE");
  });

  test("scheme tagged with both INSTITUTION and STUDENT still hard-rejects individual citizen student", () => {
    const s = scheme({ applicantTypes: ["INSTITUTION", "STUDENT"] });
    const v = evaluateEligibility(user({ occupation: "Student" }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
    expect(v.failed.map((f) => f.rule)).toContain("applicantType");
  });

  test("scheme tagged with both FACULTY_RESEARCHER and STUDENT hard-rejects Student user", () => {
    const s = scheme({ applicantTypes: ["FACULTY_RESEARCHER", "STUDENT"] });
    const v = evaluateEligibility(user({ occupation: "Student" }), s);
    expect(v.status).toBe("NOT_ELIGIBLE");
    expect(v.failed.map((f) => f.rule)).toContain("applicantType");
  });
});
