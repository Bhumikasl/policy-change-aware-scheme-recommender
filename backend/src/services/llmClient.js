/**
 * Provider-agnostic LLM client for structured-JSON generation.
 *
 * Why this exists: the extractor and verifier used to call Gemini
 * directly. Gemini's free tier is punishingly small (~50 requests/day
 * per project), which is fine for a demo but stops you dead the moment
 * you try to backfill a real corpus of schemes. This module abstracts
 * over "call an LLM, get parsed JSON back" so we can point at any of
 * several providers via one env variable.
 *
 * Supported providers (set with LLM_PROVIDER):
 *
 *   groq     — https://console.groq.com  — RECOMMENDED for students.
 *              Free tier is generous (llama-3.1-8b-instant: 30 RPM,
 *              14,400 requests/day). OpenAI-compatible HTTP API, no SDK
 *              needed. Sign up, create a key, put it in GROQ_API_KEY.
 *              Full 4786-scheme backfill fits comfortably in one day.
 *
 *   gemini   — Google's SDK. Small free tier, but you already have it
 *              wired up. Kept as the fallback / dev default.
 *
 *   ollama   — https://ollama.com — Local, zero-quota, offline. Requires
 *              `ollama pull llama3.1` on your machine and the Ollama
 *              server running. Free forever, no API key.
 *
 * The single function this module exports is generateStructured, which
 * every caller uses the same way regardless of provider. Provider
 * differences (schema encoding, response parsing, error shapes) live
 * inside the adapter that hides them.
 */

const logger = require("../utils/logger");

let disabledForRun = false;

function isQuotaOrRateLimit(err) {
  const m = (err?.message || "").toLowerCase();
  return m.includes("429") || m.includes("quota") || m.includes("rate limit") || m.includes("rate_limit") || m.includes("resource_exhausted");
}
function isPermanentModelError(err) {
  const m = (err?.message || "").toLowerCase();
  return m.includes("404") && (m.includes("model") || m.includes("not found"));
}

/**
 * Time-bound for a provider call.
 *
 * Both fetch() calls below were previously unbounded. A provider that accepts
 * the connection and then stalls would block the caller forever — and the
 * callers here are the collection cycle and the chat request, so a stalled
 * provider could hang a scheduled run indefinitely rather than degrade to the
 * rules-only path this module is designed around.
 *
 * On timeout the fetch rejects, generateStructured catches it and returns null,
 * which is the same "provider unavailable" outcome every caller already
 * handles. Bounding it changes how long that takes, never what it means.
 */
const LLM_TIMEOUT_MS = () => Number(process.env.LLM_TIMEOUT_MS) || 30000;
const callSignal = () =>
  typeof AbortSignal !== "undefined" && AbortSignal.timeout
    ? AbortSignal.timeout(LLM_TIMEOUT_MS())
    : undefined;

function throttle() {
  const delay = Number(process.env.LLM_CALL_DELAY_MS) || 0;
  if (delay > 0) return new Promise((r) => setTimeout(r, delay));
  return Promise.resolve();
}

// ---------------- Groq adapter ----------------
// Groq's Chat Completions API is OpenAI-compatible. For structured JSON
// output we use response_format={type:"json_object"} and put the schema
// in the system prompt. Llama models on Groq honour JSON mode reliably.
async function groqGenerate(systemPrompt, userPrompt, schema, opts = {}) {
  const key = process.env.GROQ_API_KEY;
  if (!key) throw new Error("GROQ_API_KEY not set");
  const model = opts.model || process.env.GROQ_MODEL || "llama-3.1-8b-instant";

  const schemaHint = schema
    ? `\n\nReturn ONLY a JSON object matching this schema (no prose, no markdown):\n${JSON.stringify(schema, null, 2)}`
    : "";

  const body = {
    model,
    messages: [
      { role: "system", content: systemPrompt + schemaHint },
      { role: "user", content: userPrompt },
    ],
    response_format: { type: "json_object" },
    temperature: opts.temperature ?? 0,
  };

  const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    signal: callSignal(),
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${key}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Groq ${res.status}: ${text.slice(0, 300)}`);
    err.status = res.status;
    throw err;
  }
  const data = await res.json();
  const raw = data.choices?.[0]?.message?.content;
  if (!raw) throw new Error("Groq returned empty content");
  return JSON.parse(raw);
}

// ---------------- Ollama adapter ----------------
// Local model server. Free forever. Requires `ollama pull llama3.1` and
// `ollama serve` running (starts automatically on install).
async function ollamaGenerate(systemPrompt, userPrompt, schema, opts = {}) {
  const model = opts.model || process.env.OLLAMA_MODEL || "llama3.1";
  const host = process.env.OLLAMA_HOST || "http://127.0.0.1:11434";

  const schemaHint = schema
    ? `\n\nReturn ONLY a JSON object matching this schema (no prose, no markdown):\n${JSON.stringify(schema, null, 2)}`
    : "";

  const res = await fetch(`${host}/api/chat`, {
    signal: callSignal(),
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt + schemaHint },
        { role: "user", content: userPrompt },
      ],
      format: "json",
      stream: false,
      options: { temperature: opts.temperature ?? 0 },
    }),
  });
  if (!res.ok) throw new Error(`Ollama ${res.status}: ${await res.text().catch(() => "")}`);
  const data = await res.json();
  return JSON.parse(data.message?.content || "{}");
}

// ---------------- Gemini adapter (existing behaviour) ----------------
let geminiClient = null;
async function geminiGenerate(systemPrompt, userPrompt, schema, opts = {}) {
  const { GoogleGenerativeAI } = require("@google/generative-ai");
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === "your_gemini_api_key_here") throw new Error("GEMINI_API_KEY not set");
  if (!geminiClient) geminiClient = new GoogleGenerativeAI(key);

  const model = geminiClient.getGenerativeModel({
    model: opts.model || process.env.GEMINI_MODEL || "gemini-2.5-flash",
    systemInstruction: systemPrompt,
    generationConfig: {
      responseMimeType: "application/json",
      ...(opts.geminiSchema ? { responseSchema: opts.geminiSchema } : {}),
      temperature: opts.temperature ?? 0,
    },
  });
  const result = await model.generateContent(userPrompt);
  return JSON.parse(result.response.text());
}

/**
 * Call whichever provider LLM_PROVIDER points at, get parsed JSON back.
 *
 * @param {string} systemPrompt   — the role instructions
 * @param {string} userPrompt     — the actual query
 * @param {object} [schema]       — descriptive JSON schema (JSON Schema shape;
 *                                   used in the prompt for groq/ollama,
 *                                   ignored by gemini unless you pass
 *                                   opts.geminiSchema in Google's SDK format)
 * @param {object} [opts]
 * @param {string} [opts.model]         override model per call
 * @param {number} [opts.temperature]   default 0
 * @param {object} [opts.geminiSchema]  Google SDK-style responseSchema (SchemaType.*)
 *                                       Passed only to the gemini adapter.
 * @returns {Promise<object|null>} parsed JSON, or null if the provider is
 *   unavailable (missing key, disabled by circuit-breaker, or errored).
 *   Callers treat null as "LLM couldn't help, use rules-only".
 */
async function generateStructured(systemPrompt, userPrompt, schema, opts = {}) {
  if (disabledForRun) return null;
  const provider = (process.env.LLM_PROVIDER || "groq").toLowerCase();

  await throttle();

  try {
    if (provider === "groq")   return await groqGenerate(systemPrompt, userPrompt, schema, opts);
    if (provider === "ollama") return await ollamaGenerate(systemPrompt, userPrompt, schema, opts);
    return await geminiGenerate(systemPrompt, userPrompt, schema, opts);
  } catch (err) {
    if (isPermanentModelError(err) && !disabledForRun) {
      disabledForRun = true;
      logger.error(`LLM (${provider}) model unavailable, disabling for this run`, { error: err.message });
    } else if (isQuotaOrRateLimit(err)) {
      // Do NOT disable for run! Groq rate limits reset quickly.
      // Just log and return null for this specific call, allowing future calls to retry.
      logger.warn(`LLM (${provider}) quota/rate-limit hit, skipping this call only`);
      // Wait 1 second before releasing throttle to give rate limit time to reset
      await new Promise(r => setTimeout(r, 1000));
    } else {
      logger.warn(`LLM (${provider}) call failed, falling back to rules-only`, { error: err.message });
    }
    return null;
  }
}

function _resetDisabled() { disabledForRun = false; }

module.exports = { generateStructured, _resetDisabled };
