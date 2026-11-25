const SchemeChunkModel = require("../models/SchemeChunk");
const { chunkScheme } = require("./schemeChunker");
const { embedBatch } = require("./embeddingService");
const logger = require("../utils/logger");

const { CHUNK_STATUS } = SchemeChunkModel;

/**
 * RAG INDEXER — keeps the knowledge base in step with the scheme versions.
 *
 * ---------------------------------------------------------------------------
 * THE PROBLEM THIS SOLVES
 * ---------------------------------------------------------------------------
 * A RAG index built once and left alone becomes a confident liar. The
 * government raises an income ceiling, the pipeline detects it, the
 * recommendation updates — and the assistant keeps quoting the old figure
 * from a chunk embedded three months ago, with a citation, which makes it
 * more convincing rather than less.
 *
 * So indexing is driven by the SAME change detection that drives everything
 * else. NEW indexes, UPDATED supersedes-then-indexes, UNCHANGED does nothing
 * at all.
 *
 * ---------------------------------------------------------------------------
 * FAILURE ISOLATION
 * ---------------------------------------------------------------------------
 * Indexing runs downstream of policy processing and cannot invalidate it.
 * An embedding provider outage means the knowledge base is stale — bad, and
 * recoverable — while the eligibility decision, the recommendation and the
 * audit trail are all already correct and stored. So this returns counters
 * rather than throwing, and its status is tracked separately from the policy
 * stages.
 *
 * ---------------------------------------------------------------------------
 * WHY SUPERSEDE RATHER THAN DELETE
 * ---------------------------------------------------------------------------
 * Phase K explains a change by citing what the scheme used to say, and a later
 * evaluation must be able to reconstruct what the system knew at the time.
 * Deleting the old chunks would break both. They are marked SUPERSEDED and
 * excluded from ordinary retrieval instead.
 */

const INDEX_STATUS = Object.freeze({
  INDEXED: "INDEXED",
  SKIPPED: "SKIPPED",
  FAILED: "FAILED",
});

/** Deterministic, so re-indexing the same version cannot duplicate a chunk. */
function chunkIdFor(schemeId, version, field, ordinal) {
  return `${schemeId}:v${version}:${field}:${ordinal}`;
}

/**
 * Turn a scheme into indexable chunks with full metadata.
 *
 * Reuses schemeChunker.chunkScheme rather than re-splitting: it is already
 * field-aware and sentence-boundary-aware, and a second chunker would drift
 * from the one the eligibility verifier uses.
 */
function buildChunks(scheme, { language = "en" } = {}) {
  const raw = chunkScheme(scheme) || [];
  const perFieldOrdinal = new Map();

  const chunks = raw.map((c) => {
    const field = c.section;
    const ordinal = perFieldOrdinal.get(field) || 0;
    perFieldOrdinal.set(field, ordinal + 1);
    return {
      chunkId: chunkIdFor(scheme.schemeId, scheme.version, field, ordinal),
      schemeId: scheme.schemeId,
      schemeVersion: scheme.version,
      schemeName: scheme.name || "",
      field,
      ordinal,
      text: c.text,
      language,
      source: scheme.source || scheme.applicationLink || "",
    };
  });

  // Structured facts the free text often omits. Without these, "what is the
  // income limit" has nothing to retrieve on a scheme whose prose never
  // states it numerically — the number lives only in eligibilityRules.
  const rules = scheme.eligibilityRules || {};
  const facts = [];
  if (rules.maxAnnualIncome != null) {
    facts.push(`Maximum annual family income: Rs ${rules.maxAnnualIncome}.`);
  }
  if (rules.minAge != null || rules.maxAge != null) {
    facts.push(
      `Age requirement: ${rules.minAge != null ? `minimum ${rules.minAge}` : "no minimum"}, ${
        rules.maxAge != null ? `maximum ${rules.maxAge}` : "no maximum"
      }.`
    );
  }
  if (rules.minEducationLevel) facts.push(`Minimum education: ${rules.minEducationLevel}.`);
  if ((rules.states || []).length) facts.push(`Applicable states: ${rules.states.join(", ")}.`);
  if (scheme.lastDate) facts.push(`Application deadline: ${scheme.lastDate}.`);

  if (facts.length > 0) {
    chunks.push({
      chunkId: chunkIdFor(scheme.schemeId, scheme.version, "structuredFacts", 0),
      schemeId: scheme.schemeId,
      schemeVersion: scheme.version,
      schemeName: scheme.name || "",
      field: "structuredFacts",
      ordinal: 0,
      text: facts.join(" "),
      language,
      source: "eligibilityRules",
    });
  }

  return chunks;
}

/** Mark every ACTIVE chunk of the previous versions superseded. */
async function supersedePreviousVersions({ schemeId, newVersion, model }) {
  const res = await model.updateMany(
    {
      schemeId,
      status: CHUNK_STATUS.ACTIVE,
      schemeVersion: { $lt: newVersion },
    },
    {
      $set: {
        status: CHUNK_STATUS.SUPERSEDED,
        supersededAt: new Date(),
        supersededByVersion: newVersion,
      },
    }
  );
  return res?.modifiedCount || 0;
}

/**
 * Index one scheme version.
 *
 * @param {Object} opts
 * @param {Object} opts.scheme   the scheme AFTER the change
 * @param {string} opts.changeType  "NEW" | "UPDATED" | "NO_CHANGE"
 * @param {Object} [opts.deps]
 * @returns {Promise<Object>} counters and a status; never throws
 */
async function indexScheme({ scheme, changeType, language = "en", deps = {} } = {}) {
  const { model = SchemeChunkModel, embed = embedBatch } = deps;
  const started = Date.now();

  const result = {
    schemeId: scheme?.schemeId,
    schemeVersion: scheme?.version ?? null,
    status: INDEX_STATUS.SKIPPED,
    chunksIndexed: 0,
    chunksSuperseded: 0,
    duplicatesSkipped: 0,
    embeddingModel: null,
    embeddingDegraded: false,
    errors: [],
    durationMs: 0,
  };

  const finish = () => {
    result.durationMs = Date.now() - started;
    return result;
  };

  // UNCHANGED: the whole point of the hash check upstream is that this costs
  // nothing. No embedding calls, no writes, no queries.
  if (changeType === "NO_CHANGE" || !changeType) {
    result.reason = "scheme unchanged";
    return finish();
  }
  if (!scheme?.schemeId || scheme.version == null) {
    result.status = INDEX_STATUS.FAILED;
    result.errors.push({ stage: "input", error: "scheme is missing schemeId or version" });
    return finish();
  }

  const chunks = buildChunks(scheme, { language });
  if (chunks.length === 0) {
    result.reason = "scheme produced no indexable text";
    return finish();
  }

  // ---- embed first, supersede second -----------------------------------
  //
  // Order matters. Superseding before the embeddings succeed would leave the
  // scheme with NO active chunks if the provider is down — the assistant would
  // then answer "I have no information about this scheme" for something it
  // knew about a minute ago. Embedding first means a failure leaves the
  // previous version active and merely stale, which is the better of two bad
  // states and is recoverable by a retry.
  let embedded;
  try {
    embedded = await embed(chunks.map((c) => c.text));
  } catch (err) {
    result.status = INDEX_STATUS.FAILED;
    result.errors.push({ stage: "embedding", error: err.message });
    logger.warn("RAG indexer: embedding failed, previous version left active", {
      schemeId: result.schemeId,
      version: result.schemeVersion,
      error: err.message,
    });
    return finish();
  }

  result.embeddingModel = embedded.model;
  result.embeddingDegraded = !!embedded.degraded;

  try {
    result.chunksSuperseded = await supersedePreviousVersions({
      schemeId: scheme.schemeId,
      newVersion: scheme.version,
      model,
    });
  } catch (err) {
    result.errors.push({ stage: "supersede", error: err.message });
    // Not fatal on its own, but it does mean two versions may both be ACTIVE.
    // Recorded so the retriever's version preference is known to be carrying
    // the weight until a retry fixes it.
    logger.warn("RAG indexer: could not supersede previous version", {
      schemeId: result.schemeId,
      error: err.message,
    });
  }

  for (let i = 0; i < chunks.length; i++) {
    const doc = {
      ...chunks[i],
      embedding: embedded.vectors[i],
      embeddingModel: embedded.model,
      embeddingDims: embedded.dims,
      embeddingDegraded: !!embedded.degraded,
      status: CHUNK_STATUS.ACTIVE,
      indexedAt: new Date(),
      createdAt: new Date(),
    };
    try {
      await model.create(doc);
      result.chunksIndexed++;
    } catch (err) {
      if (err && (err.code === 11000 || /duplicate key/i.test(String(err.message)))) {
        // Same version re-indexed. The deterministic chunkId makes this
        // harmless rather than a second copy that every search would return
        // twice.
        result.duplicatesSkipped++;
        continue;
      }
      result.errors.push({ stage: "write", chunkId: doc.chunkId, error: err.message });
    }
  }

  result.status =
    result.errors.length > 0 && result.chunksIndexed === 0 ? INDEX_STATUS.FAILED : INDEX_STATUS.INDEXED;

  logger.info("RAG indexer: complete", {
    schemeId: result.schemeId,
    version: result.schemeVersion,
    status: result.status,
    chunksIndexed: result.chunksIndexed,
    chunksSuperseded: result.chunksSuperseded,
    embeddingModel: result.embeddingModel,
    degraded: result.embeddingDegraded,
    durationMs: Date.now() - started,
  });

  return finish();
}

/**
 * Re-index schemes whose last indexing attempt failed.
 *
 * Detected structurally rather than from a status column: a scheme whose
 * current version has no ACTIVE chunks was either never indexed or failed
 * mid-way. Contacts no government source.
 */
async function findUnindexedSchemes({ schemeModel, chunkModel = SchemeChunkModel, limit = 50 }) {
  const schemes = await schemeModel.find({}).limit(limit).lean();
  const stale = [];
  for (const scheme of schemes || []) {
    const count = await chunkModel.countDocuments({
      schemeId: scheme.schemeId,
      schemeVersion: scheme.version,
      status: CHUNK_STATUS.ACTIVE,
    });
    if (count === 0) stale.push(scheme);
  }
  return stale;
}

/**
 * Re-index every scheme whose current version has no ACTIVE chunks.
 *
 * The recovery path for a provider outage. Contacts no government source: the
 * scheme documents are already stored, so this is purely "embed what is
 * already here", and it is safe to run repeatedly — the deterministic chunkId
 * plus the unique index make a re-run of an already-indexed version a no-op
 * counted as duplicatesSkipped.
 *
 * Detection is STRUCTURAL rather than status-column-based: "has no active
 * chunks" is the condition that actually matters, and it stays true whether
 * the scheme was never indexed, failed halfway, or had its status row lost.
 * A status column can disagree with reality; this cannot.
 */
async function reindexStaleSchemes({
  schemeModel,
  chunkModel = SchemeChunkModel,
  limit = 25,
  deps = {},
} = {}) {
  const started = Date.now();
  const stale = await findUnindexedSchemes({ schemeModel, chunkModel, limit });

  const out = { attempted: 0, indexed: 0, failed: 0, chunksIndexed: 0, durationMs: 0 };
  for (const scheme of stale) {
    out.attempted++;
    // NEW rather than UPDATED: there are no active chunks to supersede, so
    // claiming otherwise would run an invalidation query against nothing.
    const res = await indexScheme({
      scheme,
      changeType: "NEW",
      deps: { model: chunkModel, ...deps },
    });
    if (res.status === INDEX_STATUS.INDEXED) {
      out.indexed++;
      out.chunksIndexed += res.chunksIndexed;
    } else if (res.status === INDEX_STATUS.FAILED) {
      out.failed++;
    }
  }

  out.durationMs = Date.now() - started;
  if (out.attempted > 0) logger.info("RAG indexer: stale sweep complete", out);
  return out;
}

module.exports = {
  indexScheme,
  buildChunks,
  chunkIdFor,
  supersedePreviousVersions,
  findUnindexedSchemes,
  reindexStaleSchemes,
  INDEX_STATUS,
  CHUNK_STATUS,
};
