const SchemeChunkModel = require("../models/SchemeChunk");
const { embed, cosineSimilarity, activeModel } = require("./embeddingService");
const logger = require("../utils/logger");

const { CHUNK_STATUS } = SchemeChunkModel;

/**
 * RAG RETRIEVER — evidence, never answers.
 *
 * This returns retrieved chunks with their provenance. It never generates
 * text, so nothing it produces can be untraceable: every item names the
 * scheme, the version, the field and the score it came from.
 *
 * ---------------------------------------------------------------------------
 * VECTOR STORE CHOICE
 * ---------------------------------------------------------------------------
 * Two strategies behind one interface:
 *
 *   "atlas"  — MongoDB Atlas Vector Search ($vectorSearch aggregation).
 *              Preferred: the project already runs on Atlas, so it adds no
 *              second datastore to operate, secure or keep consistent.
 *              Requires a vector index named by ATLAS_VECTOR_INDEX and an
 *              Atlas tier that supports it.
 *
 *   "scan"   — fetch candidate chunks by metadata and score cosine similarity
 *              in Node. Correct, obvious, and O(chunks): fine for a few
 *              thousand chunks, wrong for a million.
 *
 * Default is "scan", and that default is deliberate: I have NOT been able to
 * verify that the project's Atlas cluster supports $vectorSearch or that the
 * index exists. Shipping "atlas" as the default would mean shipping a code
 * path that has never executed, disguised as the recommended one. "scan" runs
 * anywhere, including in tests with no network, so the version-awareness and
 * grounding logic — which is the research contribution — is exercised
 * regardless of which backend is configured.
 *
 * Switching is one environment variable. Nothing above this file changes.
 */

const VECTOR_STRATEGY = () =>
  (process.env.VECTOR_SEARCH_STRATEGY || "scan").toLowerCase();

const DEFAULT_TOP_K = Number(process.env.RAG_TOP_K) || 6;
/**
 * Below this cosine score a chunk is treated as unrelated rather than
 * "the best of a bad set". Retrieval always returns SOMETHING — the nearest
 * vectors exist whether or not they are relevant — so without a floor the
 * system answers every question with its least-irrelevant chunk.
 */
const MIN_SCORE = Number(process.env.RAG_MIN_SCORE) || 0.25;

/**
 * Build the metadata filter.
 *
 * `includeHistorical` is the version switch. Default false: an ordinary
 * question must never be answered from a superseded chunk, because that is
 * exactly how the assistant ends up quoting an income ceiling the government
 * raised last month, with a citation that makes it sound authoritative.
 */
function buildFilter({ schemeId = null, language = "en", field = null, includeHistorical = false, schemeVersion = null } = {}) {
  const filter = {};
  if (!includeHistorical) filter.status = CHUNK_STATUS.ACTIVE;
  if (language) filter.language = language;
  if (schemeId) filter.schemeId = String(schemeId);
  if (field) filter.field = String(field);
  if (schemeVersion != null) filter.schemeVersion = Number(schemeVersion);
  return filter;
}

/** In-process cosine scan. */
async function scanSearch({ model, filter, queryVector, topK }) {
  const rows = await model.find(filter).lean();
  const scored = [];
  for (const row of rows || []) {
    if (!Array.isArray(row.embedding) || row.embedding.length === 0) continue;
    // Vectors from different models are not comparable. Skipping rather than
    // scoring avoids a silently meaningless number after a provider switch.
    if (row.embeddingModel && row.embeddingModel !== activeModel()) continue;
    scored.push({ row, score: cosineSimilarity(queryVector, row.embedding) });
  }
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/** Atlas $vectorSearch. NEVER EXECUTED in this environment — see the header. */
async function atlasSearch({ model, filter, queryVector, topK }) {
  const indexName = process.env.ATLAS_VECTOR_INDEX || "scheme_chunk_vector_index";
  const pipeline = [
    {
      $vectorSearch: {
        index: indexName,
        path: "embedding",
        queryVector,
        numCandidates: Math.max(topK * 20, 100),
        limit: topK,
        filter,
      },
    },
    { $addFields: { __score: { $meta: "vectorSearchScore" } } },
  ];
  const rows = await model.aggregate(pipeline);
  return (rows || []).map((row) => ({ row, score: row.__score ?? 0 }));
}

/**
 * Retrieve evidence for a query.
 *
 * @returns {Promise<{
 *   results: Array<{chunkId,text,schemeId,schemeVersion,schemeName,field,language,score,source,status}>,
 *   sufficient: boolean, strategy: string, embeddingDegraded: boolean,
 *   metrics: {embedMs,searchMs,totalMs,candidatesScored,returned}
 * }>}
 *
 * `sufficient` is the grounding gate. False means the caller must NOT answer
 * from what came back.
 */
async function retrieve({
  query,
  language = "en",
  schemeId = null,
  field = null,
  schemeVersion = null,
  includeHistorical = false,
  topK = DEFAULT_TOP_K,
  minScore = MIN_SCORE,
  deps = {},
} = {}) {
  const { model = SchemeChunkModel, embedFn = embed } = deps;
  const startedAt = Date.now();

  const out = {
    results: [],
    sufficient: false,
    strategy: VECTOR_STRATEGY(),
    embeddingDegraded: false,
    error: null,
    // Instrumentation hooks. Recorded, never asserted — no latency claim is
    // made anywhere from these until they are measured on real hardware.
    metrics: { embedMs: 0, searchMs: 0, totalMs: 0, candidatesScored: 0, returned: 0 },
  };

  if (!query || !String(query).trim()) {
    out.error = "empty query";
    out.metrics.totalMs = Date.now() - startedAt;
    return out;
  }

  let queryVector;
  const embedStart = Date.now();
  try {
    const e = await embedFn(String(query));
    queryVector = e.vector;
    out.embeddingDegraded = !!e.degraded;
  } catch (err) {
    // No vector means no search. Returning insufficient is the honest answer;
    // falling back to a keyword scan here would silently change what
    // "retrieved" means mid-outage.
    out.error = `embedding unavailable: ${err.message}`;
    out.metrics.totalMs = Date.now() - startedAt;
    logger.warn("RAG retriever: embedding failed", { error: err.message });
    return out;
  }
  out.metrics.embedMs = Date.now() - embedStart;

  const filter = buildFilter({ schemeId, language, field, includeHistorical, schemeVersion });

  const searchStart = Date.now();
  let scored = [];
  try {
    scored =
      out.strategy === "atlas"
        ? await atlasSearch({ model, filter, queryVector, topK })
        : await scanSearch({ model, filter, queryVector, topK });
  } catch (err) {
    out.error = `vector search failed: ${err.message}`;
    out.metrics.totalMs = Date.now() - startedAt;
    logger.warn("RAG retriever: search failed", { strategy: out.strategy, error: err.message });
    return out;
  }
  out.metrics.searchMs = Date.now() - searchStart;
  out.metrics.candidatesScored = scored.length;

  const kept = scored.filter((s) => s.score >= minScore);

  out.results = kept.map(({ row, score }) => ({
    chunkId: row.chunkId,
    text: row.text,
    schemeId: row.schemeId,
    schemeVersion: row.schemeVersion,
    schemeName: row.schemeName,
    field: row.field,
    language: row.language,
    source: row.source,
    status: row.status,
    score: Number(score.toFixed(4)),
  }));

  // Sufficiency is a property of the evidence, not of the model's confidence.
  out.sufficient = out.results.length > 0;
  out.metrics.returned = out.results.length;
  out.metrics.totalMs = Date.now() - startedAt;
  return out;
}

/**
 * What a scheme said at a given version — for explaining a change.
 *
 * Deliberately separate from `retrieve`: history is opt-in, so no ordinary
 * question can accidentally be answered from a superseded chunk.
 */
async function retrieveHistorical({ schemeId, schemeVersion, language = "en", deps = {} } = {}) {
  const { model = SchemeChunkModel } = deps;
  const rows = await model
    .find({ schemeId: String(schemeId), schemeVersion: Number(schemeVersion), language })
    .lean();
  return (rows || []).map((row) => ({
    chunkId: row.chunkId,
    text: row.text,
    schemeId: row.schemeId,
    schemeVersion: row.schemeVersion,
    field: row.field,
    status: row.status,
    source: row.source,
  }));
}

module.exports = {
  retrieve,
  retrieveHistorical,
  buildFilter,
  scanSearch,
  atlasSearch,
  VECTOR_STRATEGY,
  DEFAULT_TOP_K,
  MIN_SCORE,
};
