const { validateEligibilityRules } = require("../src/services/eligibilityValidator");

describe("Eligibility Validator", () => {
  test("Institutional scheme for AICTE approved colleges is NOT universal", () => {
    const text = "Financial assistance scheme for AICTE approved engineering institutions to upgrade laboratories.";
    const rules = {
      eligibilityType: "universal",
      occupations: [],
      categories: [],
      states: [],
    };
    const res = validateEligibilityRules(text, rules);
    expect(res.isValid).toBe(false);
    expect(res.isInstitutionalOrEnterprise).toBe(true);
    expect(res.eligibilityType).toBe("unknown");
    expect(res.needsReview).toBe(true);
  });

  test("NGO/SHG scheme is NOT universal", () => {
    const text = "Grants to registered NGOs and Self Help Groups for community welfare.";
    const rules = {
      eligibilityType: "universal",
      occupations: [],
      categories: [],
    };
    const res = validateEligibilityRules(text, rules);
    expect(res.isValid).toBe(false);
    expect(res.eligibilityType).toBe("unknown");
    expect(res.needsReview).toBe(true);
  });

  test("Faculty/Researcher fellowship requires faculty/scientist role", () => {
    const text = "Research grant for university faculty and principal investigators in science.";
    const rules = {
      eligibilityType: "constrained",
      occupations: ["Student"], // misassigned student
    };
    const res = validateEligibilityRules(text, rules);
    expect(res.isValid).toBe(false);
    expect(res.specializedTargetDetected).toBe("FACULTY_RESEARCHER");
    expect(res.needsReview).toBe(true);
  });

  test("Genuinely universal citizen scheme passes validation", () => {
    const text = "This welfare pension is open to all Indian citizens residing in the country.";
    const rules = {
      eligibilityType: "universal",
      occupations: [],
      categories: [],
    };
    const res = validateEligibilityRules(text, rules);
    expect(res.isValid).toBe(true);
    expect(res.eligibilityType).toBe("universal");
    expect(res.needsReview).toBe(false);
  });

  test("Startup / Industry scheme without entrepreneur role flags review", () => {
    const text = "Capital subsidy for manufacturing startups and MSME units in industrial corridors.";
    const rules = {
      eligibilityType: "constrained",
      occupations: [],
    };
    const res = validateEligibilityRules(text, rules);
    expect(res.isValid).toBe(false);
    expect(res.isInstitutionalOrEnterprise).toBe(true);
    expect(res.applicantTypes).toContain("ENTERPRISE");
    expect(res.needsReview).toBe(true);
  });

  test("Distinguishes students studying in institutions from institutional grants", () => {
    const text = "Scholarship scheme for college students studying in recognized universities and institutions.";
    const res = validateEligibilityRules(text, { eligibilityType: "constrained", occupations: ["Student"] });
    expect(res.applicantTypes).toContain("STUDENT");
    expect(res.applicantTypes).not.toContain("INSTITUTION");
    expect(res.isInstitutionalOrEnterprise).toBe(false);
  });

  test("Direct grant to colleges/universities produces INSTITUTION and marks review", () => {
    const text = "Scheme for financial assistance to universities and colleges to set up research laboratories.";
    const res = validateEligibilityRules(text, { eligibilityType: "constrained", occupations: [] });
    expect(res.applicantTypes).toContain("INSTITUTION");
    expect(res.isInstitutionalOrEnterprise).toBe(true);
    expect(res.isValid).toBe(false);
  });
});
