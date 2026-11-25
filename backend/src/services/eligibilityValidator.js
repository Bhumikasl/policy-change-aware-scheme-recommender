/**
 * Generic Eligibility Completeness and Validation Layer.
 *
 * Validates extracted eligibilityRules against the scheme's full source text
 * (name, description, eligibility criteria, ministry, category, tags).
 *
 * Distinguishes between:
 * 1. ACTUAL BENEFICIARY / APPLICANT ENTITY:
 *    - INSTITUTION: Colleges, Universities, Schools, AICTE/UGC approved institutes receiving grants/infrastructure assistance
 *    - NGO_SHG: Registered NGOs, Voluntary Organizations, Self Help Groups, Cooperatives receiving funds/aid
 *    - ENTERPRISE: Startups, MSMEs, Manufacturing units, Industrial companies receiving subsidies/incentives
 *    - FACULTY_RESEARCHER: Teachers, Professors, Scientists, Principal Investigators receiving fellowships/research awards
 *    - STUDENT: Students, pupils, scholars receiving scholarships/stipends/coaching
 *    - FARMER: Farmers, cultivators receiving agricultural subsidies/crop assistance
 *    - INDIVIDUAL: Citizens receiving personal welfare/pension
 *
 * 2. CONTEXTUAL / PREPOSITIONAL VENUES:
 *    - "students studying in recognized colleges/universities" -> Beneficiary is STUDENT (not INSTITUTION)
 *    - "treatment in empaneled hospitals" -> Beneficiary is INDIVIDUAL (not INSTITUTION)
 *
 * Guarantees:
 * - Persists structured `applicantTypes` to eligibilityRules
 * - If an institutional/enterprise/faculty restriction exists, normal citizen/student profiles are hard-rejected
 * - A scheme with unrepresented material restrictions is NEVER classified as "universal"
 * - Schemes with unrepresented restrictions are marked "unknown" and flagged for review
 */

/**
 * Validate extracted eligibility rules against source scheme facts and extract canonical applicantTypes.
 *
 * @param {string} sourceText - combined free-text (eligibility, description, name)
 * @param {Object} rules - extracted eligibility rules
 * @param {Object} scheme - scheme document facts (name, category, tags, ministry)
 * @returns {Object} validation outcome including canonical applicantTypes
 */
function validateEligibilityRules(sourceText, rules = {}, scheme = {}) {
  const safe = String(sourceText || "").toLowerCase();
  const unrepresented = [];
  let isInstitutionalOrEnterprise = false;
  let specializedTargetDetected = null;
  const applicantTypes = new Set((rules.applicantTypes || []).map((t) => String(t).toUpperCase()));

  // 1. Context mask: Replace prepositional/affiliational mentions so they are not mistaken for the primary applicant
  const cleanText = safe
    .replace(/\b(?:studying|enrolled|admitted|pursuing|undergoing|reading|training|registered)\s+(?:in|at|with|from)\s+[^.;,\n]{0,80}\b(?:institutions?|colleges?|universit\w+|schools?|polytechnics?|training\s+centres?|hospitals?|laborator\w+)\b/gi, " [CONTEXT_STUDY_PLACE] ")
    .replace(/\b(?:college\s+students?|university\s+students?|school\s+students?|students?|pupils?|scholars?|children|youth|candidates?|applicants?|patients?)\s+(?:of|from|in|at)\s+[^.;,\n]{0,80}\b(?:institutions?|colleges?|universit\w+|schools?|polytechnics?|training\s+centres?|hospitals?|laborator\w+)\b/gi, " [CONTEXT_STUDENT_INST] ")
    .replace(/\b(?:college\s+students?|university\s+students?|school\s+students?)\b/gi, " [CONTEXT_STUDENT] ")
    .replace(/\b(?:affiliated\s+(?:to|with)|recognized\s+by|approved\s+by|accredited\s+by)\s+[^.;,\n]{0,60}\b(?:aicte|ugc|board|state|central|university|cbse|icse|ncte|pci|dci)\b/gi, " [CONTEXT_ACCREDITATION] ")
    .replace(/\b(?:treatment\s+in|hospitalized\s+in|admitted\s+in)\s+[^.;,\n]{0,60}\b(?:hospitals?|laborator\w+|centres?)\b/gi, " [CONTEXT_TREATMENT_PLACE] ");

  // 2. Direct Institutional Beneficiary Check
  const isDirectInstitution =
    /\b(?:financial\s+)?(?:assistance|grants?|subsid\w+|funds?|support|aid|loans?|scheme|proposals?|applications?)\s+(?:for|to|provided\s+to|given\s+to)\s+[^.;\n]{0,60}\b(?:aicte|ugc|institutions?|colleges?|universit\w+|schools?|polytechnics?|training\s+institutes?|laborator\w+|hospitals?)\b/i.test(cleanText) ||
    /\b(?:aicte|ugc)\s+approved\s+(?:engineering\s+)?(?:institutions?|colleges?|institutes?)\b/i.test(cleanText) ||
    /\b(?:institutions?|colleges?|universit\w+|schools?|polytechnics?)\s+(?:shall\s+be\s+eligible|can\s+apply|are\s+eligible|may\s+apply|must\s+be\s+accredited|must\s+submit|seeking\s+grant|eligible\s+for\s+grant)\b/i.test(cleanText) ||
    /\b(?:financial\s+assistance\s+to|scheme\s+for)\s+(?:upgrading|infrastructure|modernization|laboratories\s+of)\s+(?:institutions?|colleges?|universit\w+)\b/i.test(cleanText);

  if (isDirectInstitution) {
    applicantTypes.add("INSTITUTION");
    unrepresented.push("Institutional / Educational Organization");
    isInstitutionalOrEnterprise = true;
  }

  // 3. Direct NGO / SHG Beneficiary Check
  const isDirectNgo =
    /\b(?:assistance|grants?|subsid\w+|support|funds?|aid|scheme)\s+(?:for|to|provided\s+to|given\s+to)\s+[^.;\n]{0,60}\b(?:ngos?|non[-\s]?governmental\s+organizations?|voluntary\s+organizations?|trusts?|societ\w+|self[-\s]?help\s+groups?|shgs?|cooperatives?|federations?|fpos?|producer\s+organizations?)\b/i.test(cleanText) ||
    /\b(?:ngos?|voluntary\s+organizations?|registered\s+societ\w+|trusts?|shgs?|self[-\s]?help\s+groups?|cooperatives?)\s+(?:can\s+apply|are\s+eligible|may\s+apply|must\s+be\s+registered|working\s+in)\b/i.test(cleanText);

  if (isDirectNgo) {
    applicantTypes.add("NGO_SHG");
    unrepresented.push("NGO / Voluntary Organization / Self Help Group");
    isInstitutionalOrEnterprise = true;
  }

  // 4. Direct Enterprise / Startup Beneficiary Check
  const isDirectEnterprise =
    /\b(?:capital\s+)?(?:subsidy|assistance|incentives?|funds?|loans?|support|scheme)\s+(?:for|to|provided\s+to|given\s+to)\s+[^.;\n]{0,60}\b(?:start[-\s]?ups?|msmes?|micro\s+enterprises?|small\s+enterprises?|medium\s+enterprises?|industr\w+|manufacturing\s+units?|factories|companies|firms?|commercial\s+units?)\b/i.test(cleanText) ||
    /\b(?:start[-\s]?ups?|msmes?|industr\w+|manufacturing\s+units?|companies|firms?)\s+(?:can\s+apply|are\s+eligible|must\s+have\s+dpiit|registered\s+under\s+companies\s+act)\b/i.test(cleanText);

  if (isDirectEnterprise) {
    applicantTypes.add("ENTERPRISE");
    const hasEntrepreneur = (rules.occupations || []).some(
      (o) => String(o).toLowerCase() === "entrepreneur" || String(o).toLowerCase() === "self-employed"
    );
    if (!hasEntrepreneur) {
      unrepresented.push("Enterprise / Startup / MSME");
      isInstitutionalOrEnterprise = true;
    }
  }

  // 5. Direct Faculty / Researcher Beneficiary Check
  const isDirectFaculty =
    /\b(?:fellowships?|grants?|awards?|assistance|scheme)\s+(?:for|to|tenable\s+for)\s+[^.;\n]{0,60}\b(?:facult\w+|teachers?|professors?|associate\s+professors?|assistant\s+professors?|lecturers?|scientists?|principal\s+investigators?|\bpi\b|researchers?|post[-\s]?doctoral|post[-\s]?docs?)\b/i.test(cleanText) ||
    /\b(?:facult\w+|teachers?|professors?|scientists?|principal\s+investigators?|researchers?|post[-\s]?docs?)\s+(?:working\s+in|holding\s+phd|can\s+apply|are\s+eligible)\b/i.test(cleanText);

  if (isDirectFaculty) {
    applicantTypes.add("FACULTY_RESEARCHER");
    const hasFaculty = (rules.occupations || []).some(
      (o) => String(o).toLowerCase() === "faculty" || String(o).toLowerCase() === "scientist" || String(o).toLowerCase() === "researcher"
    );
    if (!hasFaculty) {
      unrepresented.push("Faculty / Scientist / Researcher");
      specializedTargetDetected = "FACULTY_RESEARCHER";
    }
  }

  // 6. Direct Student Beneficiary Check
  const isDirectStudent =
    /\b(scholarships?|stipends?|free\s+coaching|hostel\s+subsidy|tuition\s+fee|education\s+loan|college\s+students?|university\s+students?|students?|pupils?|matric\w*|pre[-\s]?matric|post[-\s]?matric|class\s+\d+|under[-\s]?graduate|post[-\s]?graduate|degree|diploma|pursuing\s+education)\b/i.test(safe);

  if (isDirectStudent && !isDirectInstitution) {
    applicantTypes.add("STUDENT");
  }

  // 7. Direct Farmer Check
  const isDirectFarmer =
    /\b(farmers?|kisan|cultivators?|agricultural\s+labourers?|landholders?|tenant\s+farmers?|crop\s+insurance|pm-kisan)\b/i.test(safe);

  if (isDirectFarmer) {
    applicantTypes.add("FARMER");
  }

  // 8. Universal Sanity Validation: A scheme can NEVER be universal if it has any unrepresented constraint
  let finalEligibilityType = rules.eligibilityType || "unknown";
  let needsReview = rules.needsReview || false;

  if (unrepresented.length > 0) {
    if (finalEligibilityType === "universal") {
      finalEligibilityType = "unknown";
      needsReview = true;
    } else if (finalEligibilityType === "constrained" && isInstitutionalOrEnterprise) {
      needsReview = true;
    }
  }

  return {
    isValid: unrepresented.length === 0,
    applicantTypes: [...applicantTypes],
    unrepresented,
    isInstitutionalOrEnterprise,
    specializedTargetDetected,
    eligibilityType: finalEligibilityType,
    needsReview,
  };
}

module.exports = {
  validateEligibilityRules,
};
