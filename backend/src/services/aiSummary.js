const { GoogleGenerativeAI } = require("@google/generative-ai");
const logger = require("../utils/logger");

let genAI = null;
let geminiDisabledForThisRun = false; // circuit breaker: flips true after first quota/rate-limit failure

function getClient() {
  if (geminiDisabledForThisRun) return null;
  if (!process.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY === "your_gemini_api_key_here") {
    return null;
  }
  if (!genAI) genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  return genAI;
}

function isQuotaOrRateLimitError(err) {
  const msg = (err?.message || "").toLowerCase();
  return msg.includes("429") || msg.includes("quota") || msg.includes("rate limit") || msg.includes("resource_exhausted");
}

function fieldLabel(field) {
  const labels = {
    eligibility: "Eligibility",
    benefits: "Benefits",
    lastDate: "Application deadline",
    documents: "Required documents",
    applicationLink: "Application link",
    status: "Status",
    description: "Description",
    name: "Scheme name",
    ministry: "Ministry",
    state: "State/UT",
    category: "Category",
  };
  return labels[field] || field;
}

/** Fallback used when no Gemini key is configured, or the API call fails. */
function buildRawSummary(schemeName, diffs) {
  const lines = diffs.map((d) => {
    const before = Array.isArray(d.oldValue) ? d.oldValue.join(", ") || "(none)" : d.oldValue || "(none)";
    const after = Array.isArray(d.newValue) ? d.newValue.join(", ") || "(none)" : d.newValue || "(none)";
    return `${fieldLabel(d.field)}: "${before}" -> "${after}"`;
  });
  return `${schemeName} was updated. ${lines.join("; ")}.`;
}

/**
 * @param {string} schemeName
 * @param {Array<{field, oldValue, newValue}>} diffs
 * @returns {Promise<string>} plain-language summary for end users
 */
async function generateChangeSummary(schemeName, diffs) {
  const client = getClient();
  if (!client) {
    return buildRawSummary(schemeName, diffs);
  }

  const diffText = diffs
    .map((d) => `- ${fieldLabel(d.field)}: was "${d.oldValue}", now "${d.newValue}"`)
    .join("\n");

  const prompt = `You are writing a short push-notification-style update for an Indian government scheme called "${schemeName}".
The following fields changed:
${diffText}

Write 1-3 short sentences in plain, simple English explaining what changed and what it means for an ordinary citizen.
Do not add information that wasn't given. Do not use technical jargon.`;

  try {
    const model = client.getGenerativeModel({ model: process.env.GEMINI_MODEL || "gemini-2.0-flash" });
    const result = await model.generateContent(prompt);
    const text = result.response.text().trim();
    return text || buildRawSummary(schemeName, diffs);
  } catch (err) {
    if (isQuotaOrRateLimitError(err) && !geminiDisabledForThisRun) {
      geminiDisabledForThisRun = true;
      logger.warn(
        "Gemini hit a quota/rate-limit error — disabling Gemini for the rest of this run and using fallback summaries from here on (this is logged once, not per-scheme)",
        { error: err.message }
      );
    } else if (!geminiDisabledForThisRun) {
      logger.error("Gemini summary generation failed, falling back to raw diff", { error: err.message });
    }
    return buildRawSummary(schemeName, diffs);
  }
}

module.exports = { generateChangeSummary };