/**
 * Policy Change Agent — Agent 1.
 *
 * Pure unit tests: no DB, no network, no LLM. Everything exercised here is the
 * deterministic path, which is the path that must carry the system when the
 * free-tier LLM is rate-limited or offline.
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

const diff = (field, oldValue, newValue) => ({ field, oldValue, newValue });

describe("field map coverage", () => {
  // An unmapped field degrades to ADMINISTRATIVE/LOW and would never notify
  // anyone. If someone adds a comparable field without mapping it, that is a
  // silent loss of notifications — so this is a correctness gate.
  it("maps every field the comparator can emit", () => {
    const emittable = [
      ...COMPARABLE_FIELDS.filter((f) => f !== "eligibilityRules"),
      ...ELIGIBILITY_RULE_FIELDS.map((f) => `eligibilityRules.${f}`),
    ];
    const unmapped = emittable.filter((f) => !FIELD_MAP[f]);
    expect(unmapped).toEqual([]);
  });
});

describe("income threshold change (the worked example from the spec)", () => {
  const result = classifyDeterministic([
    diff("eligibilityRules.maxAnnualIncome", 250000, 300000),
  ]);

  it("classifies as an ELIGIBILITY change of HIGH severity", () => {
    expect(result.changeType).toBe(CHANGE_TYPES.ELIGIBILITY);
    expect(result.severity).toBe(SEVERITY.HIGH);
  });

  it("names the affected attribute and expects user impact", () => {
    expect(result.affectedAttributes).toEqual(["income"]);
    expect(result.userImpactExpected).toBe(true);
    expect(result.eligibilityImpact).toBe(true);
  });

  it("records the direction as a broadening", () => {
    expect(result.fieldChanges[0].direction).toBe("BROADENED");
  });

  it("reaches this verdict without an LLM", () => {
    expect(result.method).toBe("deterministic");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });
});

describe("severity escalation on narrowing", () => {
  it("escalates a tightened income cap to CRITICAL", () => {
    // People who qualified yesterday do not qualify today. That is the case
    // most worth telling someone about, so it outranks a loosened cap.
    const r = classifyDeterministic([diff("eligibilityRules.maxAnnualIncome", 300000, 250000)]);
    expect(r.fieldChanges[0].direction).toBe("NARROWED");
    expect(r.severity).toBe(SEVERITY.CRITICAL);
  });

  it("does not escalate a loosened cap", () => {
    const r = classifyDeterministic([diff("eligibilityRules.maxAnnualIncome", 250000, 300000)]);
    expect(r.severity).toBe(SEVERITY.HIGH);
  });
});

describe("classifyDirection", () => {
  it.each([
    ["eligibilityRules.maxAge", 35, 40, "BROADENED"],
    ["eligibilityRules.maxAge", 40, 35, "NARROWED"],
    ["eligibilityRules.maxAge", null, 40, "NARROWED"],
    ["eligibilityRules.maxAge", 40, null, "BROADENED"],
    ["eligibilityRules.minAge", 18, 21, "NARROWED"],
    ["eligibilityRules.minAge", 21, 18, "BROADENED"],
    ["eligibilityRules.minMarksPercentage", 60, 75, "NARROWED"],
    ["eligibilityRules.minMarksPercentage", 75, 60, "BROADENED"],
  ])("%s %s -> %s is %s", (field, o, n, expected) => {
    expect(classifyDirection(field, o, n)).toBe(expected);
  });

  describe("OR allow-lists (state, gender, occupation)", () => {
    // An empty allow-list means "unrestricted". Going from [] to ["Bihar"]
    // grows the array but shrinks who qualifies, so length alone is not enough.
    it("treats [] -> non-empty as a narrowing", () => {
      expect(classifyDirection("eligibilityRules.states", [], ["Bihar"])).toBe("NARROWED");
      expect(classifyDirection("eligibilityRules.genders", [], ["Female"])).toBe("NARROWED");
    });

    it("treats non-empty -> [] as a broadening", () => {
      expect(classifyDirection("eligibilityRules.occupations", ["Student"], [])).toBe("BROADENED");
    });

    it("reads a longer list as more ways to qualify", () => {
      expect(classifyDirection("eligibilityRules.states", ["Bihar"], ["Bihar", "UP"])).toBe("BROADENED");
      expect(classifyDirection("eligibilityRules.states", ["Bihar", "UP"], ["Bihar"])).toBe("NARROWED");
    });
  });

  describe("categories are AND-of-singletons, not an OR list", () => {
    // matcher.js requires the user to hold EVERY entry in a flat `categories`
    // array, so growing it narrows. Reading it like the OR lists above would
    // tell a user they gained eligibility at the moment they lost it.
    it("reads a longer list as more requirements", () => {
      expect(classifyDirection("eligibilityRules.categories", ["SC"], ["SC", "PwD"])).toBe("NARROWED");
      expect(classifyDirection("eligibilityRules.categories", ["SC", "PwD"], ["SC"])).toBe("BROADENED");
    });

    it("still treats [] as unrestricted", () => {
      expect(classifyDirection("eligibilityRules.categories", [], ["SC"])).toBe("NARROWED");
      expect(classifyDirection("eligibilityRules.categories", ["SC"], [])).toBe("BROADENED");
    });
  });

  describe("categoryGroups are AND-of-OR", () => {
    it("reads an added group as an added requirement", () => {
      expect(classifyDirection("eligibilityRules.categoryGroups", [["SC"]], [["SC"], ["PwD"]])).toBe(
        "NARROWED"
      );
      expect(classifyDirection("eligibilityRules.categoryGroups", [["SC"], ["PwD"]], [["SC"]])).toBe(
        "BROADENED"
      );
    });

    it("reads a wider group at the same count as more ways to qualify", () => {
      expect(classifyDirection("eligibilityRules.categoryGroups", [["SC"]], [["SC", "ST"]])).toBe(
        "BROADENED"
      );
      expect(classifyDirection("eligibilityRules.categoryGroups", [["SC", "ST"]], [["SC"]])).toBe(
        "NARROWED"
      );
    });

    it("treats [] as unrestricted", () => {
      expect(classifyDirection("eligibilityRules.categoryGroups", [], [["SC"]])).toBe("NARROWED");
    });
  });

  describe("education ladder", () => {
    it.each([
      ["Graduate", "Post Graduate", "NARROWED"],
      ["Graduate", "12th Standard", "BROADENED"],
      [null, "Graduate", "NARROWED"],
      ["Graduate", null, "BROADENED"],
    ])("%s -> %s is %s", (o, n, expected) => {
      expect(classifyDirection("eligibilityRules.minEducationLevel", o, n)).toBe(expected);
    });

    it("does not guess at an unrecognised level", () => {
      expect(classifyDirection("eligibilityRules.minEducationLevel", "Graduate", "Wizardry")).toBe(
        "CHANGED"
      );
    });
  });

  it("treats extra required documents as a higher bar", () => {
    expect(classifyDirection("documents", ["Aadhaar"], ["Aadhaar", "Income Certificate"])).toBe(
      "NARROWED"
    );
    expect(classifyDirection("documents", ["Aadhaar", "Income Certificate"], ["Aadhaar"])).toBe(
      "BROADENED"
    );
  });

  it("reads a deadline moving forward as less time to apply", () => {
    expect(classifyDirection("lastDate", "2026-06-30", "2026-03-31")).toBe("NARROWED");
    expect(classifyDirection("lastDate", "2026-03-31", "2026-06-30")).toBe("BROADENED");
  });

  it("reads scheme closure as a narrowing", () => {
    expect(classifyDirection("status", "active", "closed")).toBe("NARROWED");
    expect(classifyDirection("status", "closed", "active")).toBe("BROADENED");
  });
});

describe("no change produces no downstream work", () => {
  const r = classifyDeterministic([]);

  it("is cosmetic with no impact of any kind", () => {
    expect(r.changeType).toBe(CHANGE_TYPES.COSMETIC);
    expect(r.userImpactExpected).toBe(false);
    expect(r.eligibilityImpact).toBe(false);
    expect(r.benefitImpact).toBe(false);
    expect(r.deadlineImpact).toBe(false);
    expect(r.documentImpact).toBe(false);
    expect(r.affectedAttributes).toEqual([]);
  });
});

describe("description-only changes", () => {
  it("does not claim an eligibility impact from prose alone", () => {
    // The deterministic layer cannot tell a rewrite from a silent narrowing,
    // so it must not assert impact. It flags the field for LLM review instead.
    const r = classifyDeterministic([
      diff(
        "description",
        "A scholarship for meritorious students.",
        "A scholarship programme supporting meritorious students across India."
      ),
    ]);
    expect(r.userImpactExpected).toBe(false);
    expect(r.eligibilityImpact).toBe(false);
    expect(r.fieldChanges[0].ambiguous).toBe(true);
  });

  it("recognises a pure reflow as cosmetic and does not flag it for the LLM", () => {
    const r = classifyDeterministic([
      diff(
        "description",
        "A scholarship  for   meritorious students.",
        "A scholarship for meritorious students"
      ),
    ]);
    expect(r.fieldChanges[0].changeType).toBe(CHANGE_TYPES.COSMETIC);
    expect(r.fieldChanges[0].ambiguous).toBe(false);
    expect(r.userImpactExpected).toBe(false);
  });
});

describe("administrative and cosmetic changes stay quiet", () => {
  it("does not expect user impact from a ministry rename or a link change", () => {
    const r = classifyDeterministic([
      diff("ministry", "MoE", "Ministry of Education"),
      diff("applicationLink", "http://a.gov.in", "https://a.gov.in"),
    ]);
    expect(r.changeType).toBe(CHANGE_TYPES.ADMINISTRATIVE);
    expect(r.severity).toBe(SEVERITY.LOW);
    expect(r.userImpactExpected).toBe(false);
  });

  it("reports no affected attributes for tag and name edits", () => {
    const r = classifyDeterministic([
      diff("tags", ["a"], ["a", "b"]),
      diff("name", "PM Yojana", "PM Yojana Scheme"),
    ]);
    expect(r.changeType).toBe(CHANGE_TYPES.COSMETIC);
    expect(r.userImpactExpected).toBe(false);
    expect(r.affectedAttributes).toEqual([]);
  });
});

describe("scheme closure", () => {
  it("is CRITICAL and outranks anything else in the same diff", () => {
    const r = classifyDeterministic([
      diff("status", "active", "closed"),
      diff("ministry", "MoE", "Ministry of Education"),
    ]);
    expect(r.changeType).toBe(CHANGE_TYPES.STATUS);
    expect(r.severity).toBe(SEVERITY.CRITICAL);
    expect(r.userImpactExpected).toBe(true);
  });
});

describe("new scheme", () => {
  it("expects impact, because it can make people newly eligible", () => {
    const r = classifyDeterministic([], { isNew: true });
    expect(r.changeType).toBe(CHANGE_TYPES.NEW_SCHEME);
    expect(r.eligibilityImpact).toBe(true);
    expect(r.userImpactExpected).toBe(true);
  });
});

describe("multi-field diffs", () => {
  const r = classifyDeterministic([
    diff("eligibilityRules.maxAnnualIncome", 250000, 300000),
    diff("benefits", "Rs 10000", "Rs 12000"),
    diff("documents", ["Aadhaar"], ["Aadhaar", "Bank Passbook"]),
    diff("tags", [], ["new"]),
  ]);

  it("headlines the most consequential dimension", () => {
    expect(r.changeType).toBe(CHANGE_TYPES.ELIGIBILITY);
  });

  it("takes the maximum severity", () => {
    expect(r.severity).toBe(SEVERITY.HIGH);
  });

  it("sets every impact flag the diff touches", () => {
    expect(r.eligibilityImpact).toBe(true);
    expect(r.benefitImpact).toBe(true);
    expect(r.documentImpact).toBe(true);
    expect(r.deadlineImpact).toBe(false);
  });

  it("unions the attributes, excluding cosmetic ones", () => {
    expect([...r.affectedAttributes].sort()).toEqual(["benefits", "documents", "income"]);
  });

  it("takes the weakest-link confidence", () => {
    expect(r.confidence).toBe(Math.min(...r.fieldChanges.map((c) => c.confidence)));
  });
});

describe("unmapped fields degrade safely", () => {
  it("makes no eligibility claim and admits low confidence", () => {
    const c = classifyField(diff("somethingNobodyMappedYet", 1, 2));
    expect(c.changeType).toBe(CHANGE_TYPES.ADMINISTRATIVE);
    expect(c.eligibilityImpact).toBe(false);
    expect(c.confidence).toBeLessThan(0.5);
  });
});

describe("normalizeProse", () => {
  it("collapses case, whitespace and punctuation", () => {
    expect(normalizeProse("  The  Scheme, for STUDENTS.  ")).toBe("the scheme for students");
  });

  it("keeps substantive differences distinct", () => {
    expect(normalizeProse("income below 2 lakh")).not.toBe(normalizeProse("income below 3 lakh"));
  });
});
