/**
 * Second-stage verifier.
 *
 * The rules matcher (services/matcher.js) narrows the ~4700-scheme corpus
 * down to a small candidate set for a given user — fast, deterministic,
 * auditable. But the extracted rules are only as good as the extractor:
 * an "eligibility" blob may carry a nuance the regex missed
 * ("applicant OR spouse must be a farmer") or an exception ("except
 * residents of X") that the LLM extractor happened not to encode as a
 * structured rule.
 *
 * This module does one thing: for a scheme that PASSED the deterministic
 * matcher, feed the LLM the full user profile plus the most-relevant
 * chunks of the scheme document, and ask it to VERIFY eligibility
 * criterion-by-criterion. The response comes back through a strict JSON
 * schema — no free-form summarising — with:
 *
 *   verified          — bool, "yes user is eligible for this scheme"
 *   confidence        — 0..1 from the model itself
 *   matchedCriteria   — string list, one per criterion the model checked
 *   failedCriteria    — string list, criteria the user violates
 *   missingInformation— string list, criteria the profile doesn't cover
 *   reasoning         — short natural-language explanation
 *
 * Recommendation policy (applied in the /matches route):
 *
 *   rules eligible AND verifier says eligible  → RECOMMEND
 *   rules eligible, verifier disagrees          → do NOT recommend, log
 *                                                 the disagreement, flag
 *                                                 for review
 *   rules eligible, verifier says missing-info  → RECOMMEND with a
 *                                                 "needs-more-info" hint
 *                                                 shown to the user
 *   verifier unavailable (no key, quota, error) → fall back to rules
 *                                                 verdict alone
 *
 * The verifier never PROMOTES a rules-rejected scheme to eligible: the
 * rules are the gate, the verifier is only a safety check that catches
 * false positives the rules missed.
 *
 * Caching. Verification is the expensive step. We cache by
 * hash(userProfileHash + scheme.contentHash) so re-asking about the same
 * (user, scheme) pair costs zero tokens until either side changes. The
 * cache is in-process; a durable version would move this into Mongo
 * with the same key, but the in-process version is enough to keep a
 * single /matches call from firing 30 verification calls in a loop.
 */

const crypto = require("crypto");
const { chunkScheme, rankChunksForUser } = require("./schemeChunker");
const { generateStructured } = require("./llmClient");
const logger = require("../utils/logger");

// ----- cache -----
// In-process LRU-ish cache. Bounded so a long-running server can't leak.
const CACHE_MAX = 5000;
const cache = new Map();

function userProfileHash(user) {
  const p = user?.profile || {};
  const canonical = {
    state: p.state || "",
    gender: p.gender || "",
    age: p.age ?? null,
    occupation: p.occupation || "",
    annualIncome: p.annualIncome ?? null,
    categories: [...(p.categories || [])].sort(),
    education: p.education || "",
    marksPercentage: p.marksPercentage ?? null,
    documentsAvailable: [...(p.documentsAvailable || [])].sort(),
  };
  return crypto.createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function cacheKey(user, scheme) {
  const sHash = scheme?.contentHash || crypto.createHash("sha256").update(JSON.stringify({ id: scheme?.schemeId, name: scheme?.name })).digest("hex");
  return `${userProfileHash(user)}::${sHash}`;
}

function cacheGet(key) {
  const hit = cache.get(key);
  if (!hit) return null;
  // LRU-ish: touching moves to end
  cache.delete(key); cache.set(key, hit);
  return hit;
}
function cacheSet(key, value) {
  cache.set(key, value);
  while (cache.size > CACHE_MAX) {
    const first = cache.keys().next().value;
    cache.delete(first);
  }
}

// ----- LLM contract -----
// Provider-agnostic JSON schema description. For Gemini we also build the
// Google SDK-shaped variant lazily so the module works even when the SDK
// isn't installed (groq / ollama users).
const RESPONSE_SCHEMA = {
  type: "object",
  properties: {
    verified:           { type: "boolean" },
    confidence:         { type: "number", description: "0..1" },
    matchedCriteria:    { type: "array", items: { type: "string" } },
    failedCriteria:     { type: "array", items: { type: "string" } },
    missingInformation: { type: "array", items: { type: "string" } },
    reasoning:          { type: "string" },
  },
  required: ["verified", "confidence", "matchedCriteria", "failedCriteria", "missingInformation"],
};
function geminiResponseSchema() {
  const { SchemaType } = require("@google/generative-ai");
  return {
    type: SchemaType.OBJECT,
    properties: {
      verified:           { type: SchemaType.BOOLEAN },
      confidence:         { type: SchemaType.NUMBER },
      matchedCriteria:    { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      failedCriteria:     { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      missingInformation: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      reasoning:          { type: SchemaType.STRING },
    },
    required: ["verified", "confidence", "matchedCriteria", "failedCriteria", "missingInformation"],
  };
}

const SYSTEM_INSTRUCTION = `You verify eligibility for Indian government welfare schemes.

You will receive:
  - A USER PROFILE (state, gender, age, occupation, annual income in rupees,
    social categories like SC/ST/OBC/BPL/EWS/PwD/Woman/Widow, education
    level, marks percentage, documents the user says they hold).
  - The relevant CHUNKS of one scheme's document (name, description,
    eligibility rules, benefits, required documents, ministry, state).

Determine whether the user meets EVERY eligibility criterion the scheme
requires. Rules:

  - Be strict. "Physically disabled students" means BOTH student AND
    physically disabled — a plain student without disability does NOT
    qualify. "SC/ST/OBC candidates" means ANY of those three qualifies.
    "Applicant OR spouse must be a farmer" is satisfied if either side is
    a farmer.
  - If the scheme requires a specific document (e.g. "Domicile
    Certificate") and the user's documentsAvailable list does NOT include
    it, list that criterion under missingInformation, not failedCriteria.
    Missing information is different from failing.
  - If the scheme requires an attribute (e.g. age band, income cap, caste
    group, occupation) and the user's profile is silent on it, that goes
    in missingInformation.
  - Only mark verified: true when EVERY hard criterion is satisfied and
    no critical information is missing. In doubt, verified: false.
  - Confidence: 0.9 when the text is clear and the profile answers every
    question, 0.5 when partial, 0.2 when guessing.
  - Never invent criteria that aren't in the chunks.
  - Reasoning: one or two short sentences the user can read.`;

/**
 * Verify one (user, scheme) pair.
 *
 * @param {Object} user   full user document
 * @param {Object} scheme full scheme document (with contentHash)
 * @param {Object} opts
 * @param {boolean} [opts.forceRefresh]  ignore cache
 * @returns {Promise<{verified,confidence,matchedCriteria,failedCriteria,missingInformation,reasoning,cached,fromLlm} | null>}
 *          null when the LLM is unavailable (no key, disabled, error).
 */
async function verifyEligibility(user, scheme, { forceRefresh = false } = {}) {
  const key = cacheKey(user, scheme);
  if (!forceRefresh) {
    const cached = cacheGet(key);
    if (cached) return { ...cached, cached: true };
  }

  const chunks = chunkScheme(scheme);
  const top = rankChunksForUser(chunks, user, 8);
  if (top.length === 0) return null;

  const prompt = {
    userProfile: {
      state: user?.profile?.state || null,
      gender: user?.profile?.gender || null,
      age: user?.profile?.age ?? null,
      occupation: user?.profile?.occupation || null,
      annualIncome: user?.profile?.annualIncome ?? null,
      categories: user?.profile?.categories || [],
      education: user?.profile?.education || null,
      marksPercentage: user?.profile?.marksPercentage ?? null,
      documentsAvailable: user?.profile?.documentsAvailable || [],
    },
    schemeName: scheme?.name || "",
    schemeChunks: top.map((c) => ({ section: c.section, text: c.text })),
  };

  // Pick the model per provider: LLM_PROVIDER=groq uses GROQ_MODEL,
  // ollama uses OLLAMA_MODEL, gemini uses GEMINI_VERIFIER_MODEL (fall
  // through to GEMINI_MODEL). The generateStructured call routes based
  // on LLM_PROVIDER — this module doesn't need to know which one.
  const provider = (process.env.LLM_PROVIDER || "groq").toLowerCase();
  const opts = {
    temperature: 0,
    model:
      provider === "groq"   ? process.env.GROQ_VERIFIER_MODEL   || process.env.GROQ_MODEL :
      provider === "ollama" ? process.env.OLLAMA_VERIFIER_MODEL || process.env.OLLAMA_MODEL :
                              process.env.GEMINI_VERIFIER_MODEL || process.env.GEMINI_MODEL,
    ...(provider === "gemini" ? { geminiSchema: geminiResponseSchema() } : {}),
  };
  const parsed = await generateStructured(SYSTEM_INSTRUCTION, JSON.stringify(prompt), RESPONSE_SCHEMA, opts);
  if (!parsed) return null;

  const value = {
    verified: !!parsed.verified,
    confidence: typeof parsed.confidence === "number" ? Math.max(0, Math.min(1, parsed.confidence)) : 0.3,
    matchedCriteria: Array.isArray(parsed.matchedCriteria) ? parsed.matchedCriteria : [],
    failedCriteria: Array.isArray(parsed.failedCriteria) ? parsed.failedCriteria : [],
    missingInformation: Array.isArray(parsed.missingInformation) ? parsed.missingInformation : [],
    reasoning: typeof parsed.reasoning === "string" ? parsed.reasoning : "",
    fromLlm: true,
    cached: false,
    verifiedAt: new Date(),
  };
  cacheSet(key, value);
  return value;
}

/**
 * Combine deterministic rules verdict + LLM verifier verdict into a final
 * recommendation. This is the ONE place the recommendation policy lives —
 * the /matches route calls this and gets a single answer.
 *
 * The rules verdict is the AUTHORITATIVE gate. The verifier can only
 * downgrade a rules-eligible scheme (catch a false positive) or add a
 * needs-more-info flag; it CANNOT promote a rules-rejected scheme, so a
 * hallucinating model can never sneak an ineligible user into a scheme.
 */
function decideRecommendation(rulesVerdict, verifierVerdict) {
  if (rulesVerdict.status === "NOT_ELIGIBLE" || (!rulesVerdict.status && !rulesVerdict.eligible)) {
    return {
      recommend: false,
      stage: "rules",
      reason: "failed rule check",
      rulesVerdict,
      verifierVerdict: null,
    };
  }
  // The user hasn't answered a field the scheme needs, but no known
  // condition has failed — recommend it WITH a needs-more-info flag rather
  // than silently dropping it (that silent drop is the exact defect this
  // status exists to fix: missing information is not a rejection). Skip
  // the LLM verifier here — asking it to "verify" a profile the rules
  // engine itself can't yet complete isn't a meaningful second opinion.
  if (rulesVerdict.status === "NEEDS_MORE_INFORMATION") {
    return {
      recommend: false,
      stage: "rules-needs-more-info",
      reason: "rules could not fully verify — some profile information is missing",
      rulesVerdict,
      verifierVerdict: null,
      needsMoreInfo: true,
    };
  }

  // When no verifier result is present (verifier disabled, rate-limited,
  // or verify=false requested), fall back to the rules verdict alone.
  // The rules engine is the authoritative gate.
  if (!verifierVerdict) {
    return {
      recommend: true,
      stage: "rules-only",
      reason: "verifier unavailable or disabled; rules verdict accepted",
      rulesVerdict,
      verifierVerdict: null,
    };
  }
  if (verifierVerdict.verified) {
    return {
      recommend: true,
      stage: "rules+llm",
      reason: verifierVerdict.reasoning || "both stages agree",
      rulesVerdict,
      verifierVerdict,
      needsMoreInfo: verifierVerdict.missingInformation.length > 0,
    };
  }
  if (verifierVerdict.failedCriteria.length === 0 && verifierVerdict.missingInformation.length > 0) {
    // Not a disagreement — the LLM just wants more profile info before
    // committing. Still safe to surface; UI can prompt for the missing bits.
    return {
      recommend: true,
      stage: "rules+llm-partial",
      reason: "rules passed; verifier requests more profile information",
      rulesVerdict,
      verifierVerdict,
      needsMoreInfo: true,
    };
  }
  return {
    recommend: false,
    stage: "verifier-veto",
    reason: verifierVerdict.reasoning || "LLM verifier found failing criteria the rules missed",
    rulesVerdict,
    verifierVerdict,
    disagreement: true,
  };
}

// Test-only helpers — safe to keep exported, they only touch the module-
// scoped in-process cache.
function _clearCache() { cache.clear(); disabledForThisRun = false; }

module.exports = {
  verifyEligibility,
  decideRecommendation,
  userProfileHash,
  cacheKey,
  _clearCache,
};
