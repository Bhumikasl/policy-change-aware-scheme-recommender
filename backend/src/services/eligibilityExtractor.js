const { EDUCATION_LEVELS } = require("./eligibilityLevels");
const { generateStructured } = require("./llmClient");

/**
 * Converts a free-text eligibility string into structured rules using
 * whichever LLM provider LLM_PROVIDER points at (groq / gemini / ollama —
 * see services/llmClient.js). Returns null if the provider is
 * unavailable — callers fall back to whatever rules they already have.
 *
 * The response schema below is used two ways:
 *   - as a plain-text hint appended to the system prompt for
 *     groq/ollama (which honour JSON mode but don't enforce a schema)
 *   - as a Google-SDK-shaped responseSchema for gemini (via geminiSchema
 *     in the opts bag), which forces structural compliance server-side.
 */

// Provider-agnostic JSON-schema-ish description. Every string is human-
// readable — the LLM prompt copies this verbatim so the model sees the
// exact field names / types / enums the caller expects.
const RESPONSE_SCHEMA_DESC = {
  type: "object",
  properties: {
    minAge:             { type: ["integer", "null"] },
    maxAge:             { type: ["integer", "null"] },
    maxAnnualIncome:    { type: ["number", "null"], description: "rupees per year, 3 lakh → 300000" },
    minAnnualIncome:    { type: ["number", "null"] },
    minMarksPercentage: { type: ["number", "null"] },
    minEducationLevel:  { type: ["string", "null"], enum: [...EDUCATION_LEVELS, null] },
    maxEducationLevel:  { type: ["string", "null"], enum: [...EDUCATION_LEVELS, null], description: "ceiling, e.g. a pre-matric scholarship for students who have not passed 10th" },
    genders:            { type: "array", items: { type: "string", enum: ["Female", "Male", "Other"] } },
    categories:         { type: "array", items: { type: "string" }, description: "SC,ST,OBC,Minority,BPL / Economically Weaker,Woman,Person with Disability,Senior Citizen,Widow,Ex-Servicemen,Migrant Worker,Single Parent" },
    occupations:        { type: "array", items: { type: "string" }, description: "Student,Farmer,Entrepreneur,Salaried Employee,Self-Employed,Unemployed,Homemaker,Retired,Artisan / Weaver,Fisherman,Construction Worker" },
    states:             { type: "array", items: { type: "string" }, description: "full state / UT names; [] if nationwide" },
    courses:            { type: "array", items: { type: "string" }, description: "course/stream restriction, e.g. Engineering, Computer Science, Medicine, Agriculture, Law, Arts, Commerce, Science, Management, Pharmacy. [] if the scheme is open to any stream" },
    disabilityRequired: { type: ["boolean", "null"], description: "true only if the scheme is restricted to persons with disabilities" },
    minDisabilityPercentage: { type: ["number", "null"], description: "e.g. 40 for '40% or more disability'" },
    singleGirlChildRequired: { type: ["boolean", "null"], description: "true only if the scheme is restricted to a family's single/only girl child" },
    isUniversal:        { type: "boolean", description: "true ONLY if the text explicitly says the scheme is open to all citizens/residents with no restriction. Default false when unsure." },
    confidence:         { type: "number", description: "0..1" },
  },
  required: ["confidence", "isUniversal"],
};

// Google SDK-specific schema. Gemini's structured-output mode requires
// its own SchemaType enum shape (nullable:true instead of type:[X,null]).
// Loaded lazily so the module doesn't crash when the SDK isn't installed
// and the provider is set to groq/ollama.
function geminiResponseSchema() {
  const { SchemaType } = require("@google/generative-ai");
  return {
    type: SchemaType.OBJECT,
    properties: {
      minAge:             { type: SchemaType.INTEGER, nullable: true },
      maxAge:             { type: SchemaType.INTEGER, nullable: true },
      maxAnnualIncome:    { type: SchemaType.NUMBER,  nullable: true },
      minAnnualIncome:    { type: SchemaType.NUMBER,  nullable: true },
      minMarksPercentage: { type: SchemaType.NUMBER,  nullable: true },
      minEducationLevel:  { type: SchemaType.STRING,  nullable: true, enum: EDUCATION_LEVELS },
      maxEducationLevel:  { type: SchemaType.STRING,  nullable: true, enum: EDUCATION_LEVELS },
      genders:            { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING, enum: ["Female", "Male", "Other"] } },
      categories:         { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING } },
      occupations:        { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING } },
      states:             { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING } },
      courses:            { type: SchemaType.ARRAY,   items: { type: SchemaType.STRING } },
      disabilityRequired: { type: SchemaType.BOOLEAN, nullable: true },
      minDisabilityPercentage: { type: SchemaType.NUMBER, nullable: true },
      singleGirlChildRequired: { type: SchemaType.BOOLEAN, nullable: true },
      isUniversal:        { type: SchemaType.BOOLEAN },
      confidence:         { type: SchemaType.NUMBER },
    },
    required: ["confidence", "isUniversal"],
  };
}

const SYSTEM_INSTRUCTION = `You are an eligibility-rule extractor for Indian government schemes.

Given the free-text eligibility criteria of one scheme, return a JSON object
matching the response schema. Rules:

- Use null (not 0, not "") for any constraint the text does not specify.
- minEducationLevel MUST be one of: ${EDUCATION_LEVELS.join(", ")}, or null.
- genders MUST use exactly "Female", "Male", "Other".
- categories: use short canonical labels like "SC","ST","OBC","Minority","BPL / Economically Weaker","Woman","Person with Disability","Senior Citizen","Widow","Ex-Servicemen","Migrant Worker","Single Parent". Empty [] if unspecified.
- occupations: e.g. "Student","Farmer","Entrepreneur","Salaried Employee","Self-Employed","Unemployed","Homemaker","Retired","Artisan / Weaver","Fisherman","Construction Worker". Empty [] if unspecified.
- states: full state/UT names as India uses them ("Karnataka","Delhi", etc). Empty [] if the scheme is nationwide.
- courses: course/stream restriction, e.g. "Engineering","Computer Science","Medicine","Agriculture","Law","Arts","Commerce","Science","Management","Pharmacy". Empty [] if the scheme applies to any stream.
- disabilityRequired: true ONLY if the scheme is explicitly restricted to persons with disabilities. null otherwise — never infer this from unrelated context.
- minDisabilityPercentage: a number like 40 for "40% or more disability". null if no percentage is stated.
- singleGirlChildRequired: true ONLY if the scheme is explicitly restricted to a family's single/only girl child. null otherwise.
- isUniversal: true ONLY if the text explicitly states the scheme is open to all citizens/residents with no eligibility restriction at all (e.g. "open to all Indian citizens"). If the text has ANY age, income, category, occupation, education, course, disability, gender or state restriction, isUniversal MUST be false — restrictions and "universal" are mutually exclusive. When genuinely unsure or the text is ambiguous/unparsed, use false, never true — a scheme wrongly marked universal can be shown to someone it should have excluded.
- Income values are in rupees per year. If the text says "3 lakh", use 300000.
- confidence: 0.9 if the text is clear and specific, 0.5 if partially clear, 0.2 if you are mostly guessing.
- Never invent constraints not in the text. When unsure, prefer null.`;

async function extractEligibility(freeText) {
  if (!freeText || typeof freeText !== "string" || freeText.trim().length < 10) {
    return null;
  }

  // For Gemini, pass the SDK-shaped schema so it enforces structure
  // server-side. For every other provider, generateStructured injects
  // the JSON-schema-ish description into the prompt.
  const provider = (process.env.LLM_PROVIDER || "groq").toLowerCase();
  const opts = provider === "gemini" ? { geminiSchema: geminiResponseSchema() } : {};

  const parsed = await generateStructured(SYSTEM_INSTRUCTION, freeText, RESPONSE_SCHEMA_DESC, opts);
  if (!parsed) return null;

  return {
    minAge: parsed.minAge ?? null,
    maxAge: parsed.maxAge ?? null,
    maxAnnualIncome: parsed.maxAnnualIncome ?? null,
    minAnnualIncome: parsed.minAnnualIncome ?? null,
    minMarksPercentage: parsed.minMarksPercentage ?? null,
    minEducationLevel: parsed.minEducationLevel ?? null,
    maxEducationLevel: parsed.maxEducationLevel ?? null,
    genders: Array.isArray(parsed.genders) ? parsed.genders : [],
    categories: Array.isArray(parsed.categories) ? parsed.categories : [],
    occupations: Array.isArray(parsed.occupations) ? parsed.occupations : [],
    states: Array.isArray(parsed.states) ? parsed.states : [],
    courses: Array.isArray(parsed.courses) ? parsed.courses : [],
    disabilityRequired: typeof parsed.disabilityRequired === "boolean" ? parsed.disabilityRequired : null,
    minDisabilityPercentage: parsed.minDisabilityPercentage ?? null,
    singleGirlChildRequired: typeof parsed.singleGirlChildRequired === "boolean" ? parsed.singleGirlChildRequired : null,
    // Defaults false, never true, when the model omits it — see the "never
    // true when unsure" instruction above; a missing field must not be
    // read as an affirmative universal claim.
    isUniversal: parsed.isUniversal === true,
    source: "llm-extracted",
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.3,
    extractedAt: new Date(),
  };
}

module.exports = { extractEligibility };
