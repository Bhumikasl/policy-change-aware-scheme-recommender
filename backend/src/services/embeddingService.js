const crypto = require("crypto");
const logger = require("../utils/logger");

/**
 * EMBEDDING SERVICE — provider abstraction.
 *
 * One place decides who computes embeddings, so swapping providers is a config
 * change rather than a search-and-replace. Every stored vector records the
 * model that produced it, because vectors from different models are not
 * comparable and mixing them silently produces nonsense similarity scores.
 *
 * ---------------------------------------------------------------------------
 * PROVIDERS
 * ---------------------------------------------------------------------------
 *   gemini      text-embedding-004, 768 dims. Free tier, already a project
 *               dependency (@google/generative-ai), so no new package.
 *   ollama      nomic-embed-text, 768 dims. Local, no quota, no network egress.
 *   local-hash  NOT SEMANTIC. See below.
 *
 * ---------------------------------------------------------------------------
 * ABOUT local-hash — read before trusting any number it produces
 * ---------------------------------------------------------------------------
 * `local-hash` projects hashed word tokens into a fixed-width vector. Two texts
 * sharing words score highly; two texts saying the same thing in different
 * words score near zero. It captures LEXICAL overlap only.
 *
 * It exists so the indexing and retrieval pipeline can be built and tested
 * deterministically with no network and no API key — every structural property
 * (versioning, invalidation, filtering, metadata) is provider-independent and
 * can be verified with it.
 *
 * It is NOT a substitute for a real embedding model, and no retrieval-quality
 * claim may be made from it. Anything measured under local-hash measures the
 * plumbing, not the semantics.
 */

const PROVIDERS = Object.freeze({
  GEMINI: "gemini",
  OLLAMA: "ollama",
  LOCAL_HASH: "local-hash",
});

const LOCAL_HASH_DIMS = 256;

function activeProvider() {
  return (process.env.EMBEDDING_PROVIDER || PROVIDERS.LOCAL_HASH).toLowerCase();
}

/** Model identifier stored alongside every vector. */
function activeModel() {
  const p = activeProvider();
  if (p === PROVIDERS.GEMINI) return process.env.GEMINI_EMBEDDING_MODEL || "text-embedding-004";
  if (p === PROVIDERS.OLLAMA) return process.env.OLLAMA_EMBEDDING_MODEL || "nomic-embed-text";
  return `local-hash-${LOCAL_HASH_DIMS}`;
}

function tokenize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length > 1);
}

/**
 * Deterministic lexical projection. Same text always gives the same vector,
 * which is what makes the pipeline tests reproducible.
 */
function localHashEmbed(text) {
  const vec = new Array(LOCAL_HASH_DIMS).fill(0);
  const tokens = tokenize(text);
  for (const token of tokens) {
    const digest = crypto.createHash("sha256").update(token).digest();
    const bucket = digest.readUInt32BE(0) % LOCAL_HASH_DIMS;
    // Signed, so unrelated tokens can cancel instead of only ever adding.
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vec[bucket] += sign;
  }
  return normalize(vec);
}

/** Unit length, so cosine similarity reduces to a dot product. */
function normalize(vec) {
  let sum = 0;
  for (const v of vec) sum += v * v;
  const mag = Math.sqrt(sum);
  if (mag === 0) return vec;
  return vec.map((v) => v / mag);
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return 0;
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  if (magA === 0 || magB === 0) return 0;
  return dot / (Math.sqrt(magA) * Math.sqrt(magB));
}

let geminiClient = null;
async function geminiEmbed(texts) {
  const key = process.env.GEMINI_API_KEY;
  if (!key || key === "your_gemini_api_key_here") throw new Error("GEMINI_API_KEY not set");
  if (!geminiClient) {
    const { GoogleGenerativeAI } = require("@google/generative-ai");
    geminiClient = new GoogleGenerativeAI(key);
  }
  const model = geminiClient.getGenerativeModel({ model: activeModel() });
  const out = [];
  for (const text of texts) {
    const res = await model.embedContent(text);
    const values = res?.embedding?.values;
    if (!Array.isArray(values)) throw new Error("gemini returned no embedding values");
    out.push(values);
  }
  return out;
}

async function ollamaEmbed(texts) {
  const base = process.env.OLLAMA_URL || "http://127.0.0.1:11434";
  const out = [];
  for (const text of texts) {
    const res = await fetch(`${base}/api/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: activeModel(), prompt: text }),
    });
    if (!res.ok) throw new Error(`ollama embeddings HTTP ${res.status}`);
    const json = await res.json();
    if (!Array.isArray(json.embedding)) throw new Error("ollama returned no embedding");
    out.push(json.embedding);
  }
  return out;
}

/**
 * Embed a batch of texts.
 *
 * @returns {Promise<{vectors: number[][], model: string, dims: number,
 *                    provider: string, degraded: boolean}>}
 *
 * On provider failure this does NOT silently fall back to local-hash: a
 * lexical vector stored beside real semantic vectors would be indexed as
 * though comparable and would quietly poison every later similarity score.
 * It throws, and the indexer records the failure for retry.
 */
async function embedBatch(texts, { provider = activeProvider() } = {}) {
  const list = Array.isArray(texts) ? texts : [texts];
  if (list.length === 0) return { vectors: [], model: activeModel(), dims: 0, provider, degraded: false };

  const started = Date.now();
  let vectors;
  if (provider === PROVIDERS.GEMINI) vectors = await geminiEmbed(list);
  else if (provider === PROVIDERS.OLLAMA) vectors = await ollamaEmbed(list);
  else vectors = list.map(localHashEmbed);

  const dims = vectors[0]?.length || 0;
  // A provider returning inconsistent dimensions would break similarity
  // silently; better to fail the batch.
  if (vectors.some((v) => v.length !== dims)) {
    throw new Error("embedding provider returned inconsistent dimensions");
  }

  logger.debug("Embedding batch complete", {
    provider,
    model: activeModel(),
    count: list.length,
    dims,
    durationMs: Date.now() - started,
  });

  return {
    vectors,
    model: activeModel(),
    dims,
    provider,
    // True when the vectors are lexical rather than semantic. Stored on every
    // chunk so a later evaluation cannot mistake plumbing for retrieval
    // quality.
    degraded: provider === PROVIDERS.LOCAL_HASH,
  };
}

async function embed(text, opts) {
  const { vectors, ...rest } = await embedBatch([text], opts);
  return { vector: vectors[0], ...rest };
}

module.exports = {
  embed,
  embedBatch,
  cosineSimilarity,
  normalize,
  tokenize,
  localHashEmbed,
  activeProvider,
  activeModel,
  PROVIDERS,
  LOCAL_HASH_DIMS,
};
