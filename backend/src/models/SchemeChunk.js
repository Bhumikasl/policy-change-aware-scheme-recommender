const mongoose = require("mongoose");

/**
 * SCHEME CHUNK — the RAG knowledge base.
 *
 * One row per (scheme, version, field, chunk). The vector lives beside the
 * text and its metadata rather than in a separate store, because the thing
 * that makes this knowledge base version-aware is a JOIN between a vector and
 * a scheme version — and splitting those across two datastores means keeping
 * them consistent through every collection cycle.
 *
 * ---------------------------------------------------------------------------
 * WHY VERSIONS ARE KEPT, NOT OVERWRITTEN
 * ---------------------------------------------------------------------------
 * When a scheme changes, the obvious move is to overwrite its chunks. That
 * would be wrong here for two reasons:
 *
 *   1. Phase K explains changes by citing what a scheme USED to say. Deleting
 *      the old text would leave those explanations ungroundable.
 *   2. Research reproducibility: an evaluation run months later must be able
 *      to reconstruct what the system knew at the time.
 *
 * So chunks are superseded, not deleted. `status` separates the two worlds:
 *
 *   ACTIVE      the current version. Retrieval returns these by default.
 *   SUPERSEDED  a previous version. Retrievable only when a caller explicitly
 *               asks for history, and never mixed into a "what does this
 *               scheme say" answer.
 *
 * A stale ACTIVE chunk is the failure this design exists to prevent: it would
 * let the assistant confidently quote an income ceiling the government raised
 * last month.
 */

const CHUNK_STATUS = Object.freeze({
  ACTIVE: "ACTIVE",
  SUPERSEDED: "SUPERSEDED",
});

const SchemeChunkSchema = new mongoose.Schema(
  {
    // Deterministic: `${schemeId}:v${version}:${field}:${ordinal}`. Derived
    // rather than random so re-indexing the same version is idempotent — the
    // unique index below then rejects a duplicate instead of creating a second
    // copy that would be returned twice by every search.
    chunkId: { type: String, required: true, unique: true, index: true },

    schemeId: { type: String, required: true, index: true },
    schemeVersion: { type: Number, required: true, index: true },
    schemeName: { type: String, default: "" },

    // Which part of the scheme this text came from. Retrieval filters on it,
    // so "what documents do I need" does not surface benefit prose.
    field: { type: String, required: true, index: true },
    ordinal: { type: Number, default: 0 },
    text: { type: String, required: true },

    /**
     * BCP-47 tag. The collector currently produces English only and the
     * project has no translation pipeline, so this is "en" in practice.
     *
     * It is carried anyway because retrieving a Hindi chunk for an English
     * question is a correctness bug, and adding the field later would mean
     * re-indexing everything. Storing it now costs nothing and makes the
     * filter available the moment a second language exists.
     */
    language: { type: String, default: "en", index: true },

    source: { type: String, default: "" },

    // ---- the vector ----
    embedding: { type: [Number], default: [] },
    // Vectors from different models are not comparable. Storing the model
    // means a provider switch can be detected rather than silently producing
    // meaningless similarity scores against the old vectors.
    embeddingModel: { type: String, default: "" },
    embeddingDims: { type: Number, default: 0 },
    // True when the vector is lexical (local-hash) rather than semantic. Any
    // later retrieval-quality measurement must exclude these or say so.
    embeddingDegraded: { type: Boolean, default: false },

    status: {
      type: String,
      enum: Object.values(CHUNK_STATUS),
      default: CHUNK_STATUS.ACTIVE,
      index: true,
    },
    supersededAt: { type: Date, default: null },
    supersededByVersion: { type: Number, default: null },

    indexedAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now },
  },
  { timestamps: false }
);

// The retrieval query: active chunks for a language, optionally one scheme.
SchemeChunkSchema.index({ status: 1, language: 1, schemeId: 1 });
// The invalidation query: every chunk of one scheme version.
SchemeChunkSchema.index({ schemeId: 1, schemeVersion: 1, status: 1 });
// Field-filtered retrieval ("what documents…").
SchemeChunkSchema.index({ status: 1, field: 1 });

module.exports = mongoose.model("SchemeChunk", SchemeChunkSchema);
module.exports.CHUNK_STATUS = CHUNK_STATUS;
