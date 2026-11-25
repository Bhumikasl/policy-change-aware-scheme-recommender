# Phase M — Version-Aware RAG Knowledge Pipeline

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Report scope: Phase M only.** Phase N is not part of this delivery.

---

## 0. WHAT HAPPENED WITH THE PREVIOUS RESPONSE

You were right that no M/N code reached you, and wrong only about why.

The code was written, wired and tested in my cloud workspace. The only file I
ever **delivered** was `PHASE_M_N_REPORT.md`. Your session has no linked
computer, so my sandbox filesystem is invisible to you — you received a report
describing code you had no copy of. That is a delivery failure on my part, not
a report-instead-of-implementation one, and the distinction only matters because
re-implementing would have discarded working, mutation-tested code.

This delivery contains the actual files. Everything below was executed against
them today.

I also isolated Phase M from Phase N to be certain of what I am handing you: I
copied the repo, **deleted every Phase N artefact**, reverted `app.js`, and ran
the suite. That is the configuration this package reproduces.

---

## 1. PHASE M STATUS

| Requirement | Status |
|---|---|
| 1. Reuse existing `schemeChunker` | **DONE** — `chunkScheme()` reused, not reimplemented |
| 2. No duplicate chunking logic | **DONE** — one chunker in the codebase |
| 3. Field-aware chunks | **DONE, TESTED** |
| 4. Metadata preserved | **DONE, TESTED** |
| 5. Version-aware indexing | **DONE, TESTED** |
| 6. NEW → index current | **DONE, TESTED** |
| 7. UPDATED → invalidate + index | **DONE, TESTED** |
| 8. UNCHANGED → no re-index | **DONE, TESTED** (zero embedding calls, zero writes) |
| 9. Historical versions preserved | **DONE, TESTED** (`SUPERSEDED`, never deleted) |
| 10. Active version preferred in retrieval | **DONE, TESTED + mutation-tested** |
| 11. Embedding service abstraction | **DONE** |
| 12. No hardcoded provider | **DONE** — one module, `EMBEDDING_PROVIDER` |
| 13. Prefer Atlas Vector Search | **IMPLEMENTED, EXPLICITLY UNVERIFIED — see §9** |
| 14. No second vector DB | **DONE** — same Atlas cluster, one new collection |
| 15. RAG indexing service | **DONE, TESTED** |
| 16. RAG failures separate from policy failures | **DONE, TESTED + mutation-tested** |
| 17. Retrieval with metadata | **DONE, TESTED** |
| 18. Grounding | **DONE, TESTED** |
| 19. Insufficient evidence → no hallucination | **DONE, TESTED** |
| 20. Retrieved text as DATA | **DONE** (storage layer; prompt boundary is Phase N) |
| 21. Prompt-injection tests | **DONE** |
| 22. Indexing/versioning/retrieval/grounding/security tests | **DONE** — 65 tests |
| 23. Mutation tests | **DONE** — 6 mutants, 6 killed |
| 24. Instrumentation | **DONE** — recorded, never asserted |
| 25. No fabricated metrics | **DONE** — no performance number is reported anywhere |

## 2. ARCHITECTURE

```
Verified Scheme (post-reconcile)
        |
   Normalization                     [existing]
        |
   Field-aware Chunking              schemeChunker.chunkScheme  [REUSED]
        |
   + structuredFacts chunk           from eligibilityRules      [NEW]
        |
   Metadata                          chunkId, schemeId, schemeVersion,
        |                            field, language, source, updatedAt
   Embedding                         embeddingService (3 providers)
        |
   Vector Store                      MongoDB Atlas, schemechunks collection
        |
   Retriever                         scan | atlas, + score floor
        |
   Grounding                         sufficient / insufficient
```

Placement in the existing pipeline:

```
Collector -> Normalizer -> comparator.reconcile()
  -> [H] Policy Change -> [I] Policy Impact -> [J] Propagation
  -> [K] Explanation -> [L] Notification
  -> [M] RAG Indexer     <-- LAST, and OUTSIDE the policy try/catch
```

**Why last and outside.** The policy decision, the audit trail and the
notification are what a person acts on, and none of them read the vector index.
Outside, because the point of a separate status is that this stage cannot reach
`record.errors`, `record.retryable` or `record.status` — if it could, an
embedding-provider outage would mark a perfectly good propagation as needing a
retry.

## 3. DATA FLOW

**Indexing**

```
indexScheme({scheme, changeType})
  changeType NO_CHANGE  -> return SKIPPED. No embed, no query, no write.
  changeType NEW/UPDATED:
     buildChunks()                    field-aware + structuredFacts
     embedBatch(texts)                <-- EMBED FIRST
       on failure -> FAILED, previous version left ACTIVE and stale, return
     supersedePreviousVersions()      <-- INVALIDATE SECOND ($lt newVersion)
     create() each chunk              deterministic chunkId; 11000 -> duplicatesSkipped
  -> {status, chunksIndexed, chunksSuperseded, duplicatesSkipped,
      embeddingModel, embeddingDegraded, errors[], durationMs}
```

**Retrieval**

```
retrieve({query, language, schemeId, field, includeHistorical, topK, minScore})
  embed(query)                    on failure -> insufficient. NO keyword fallback.
  buildFilter()                   status=ACTIVE unless includeHistorical
  scanSearch | atlasSearch        skips vectors from a different embeddingModel
  filter score >= minScore        the floor
  -> {results[{chunkId,text,schemeId,schemeVersion,schemeName,field,language,
               source,status,score}],
      sufficient, strategy, embeddingDegraded, error,
      metrics{embedMs,searchMs,totalMs,candidatesScored,returned}}
```

**Recovery**

```
reindexStaleSchemes()   hourly, third job on the EXISTING scheduler
  findUnindexedSchemes()   structural: current version with 0 ACTIVE chunks
  indexScheme(NEW)         contacts no government source, re-runs no policy agent
```

## 4. FILES CREATED

| File | Lines | Purpose |
|---|---|---|
| `src/services/embeddingService.js` | 205 | Provider abstraction, cosine, local-hash |
| `src/models/SchemeChunk.js` | 105 | Vector + metadata + ACTIVE/SUPERSEDED |
| `src/services/ragIndexer.js` | 347 | Index / invalidate / skip / stale sweep |
| `src/services/ragRetriever.js` | 236 | scan + atlas, score floor, provenance |
| `tests/ragPipeline.test.js` | 1171 | 65 tests |

## 5. FILES MODIFIED

| File | Change |
|---|---|
| `src/services/policyPipeline.js` | Stage M with separate `ragIndexStatus`/`ragRetryable`/`ragErrors`; `scheme` hoisted out of the Stage-I try. **No H/I/J/K/L logic altered.** |
| `src/models/SchemeHistory.js` | Declared `ragIndexStatus`, `ragIndexRetryable`, `ragIndexing` + index. **Required**: Mongoose strict mode silently drops undeclared fields in `$set` — the status would have appeared in the log and never reached the row, with no error. |
| `src/scheduler/cron.js` | Third job, same scheduler, own overlap guard |
| `tests/helpers/inMemoryDb.js` | Real `updateMany` + `state.failUpdateMany` |
| `tests/notificationAgent.test.js` | One assertion **strengthened** — §14 |
| `.env.example` | Phase M config + three pre-existing gaps closed |

## 6. DATABASE CHANGES

**New collection `schemechunks`:**

`chunkId` (unique), `schemeId`, `schemeVersion`, `schemeName`, `field`,
`ordinal`, `text`, `language`, `source`, `embedding`, `embeddingModel`,
`embeddingDims`, `embeddingDegraded`, `status`, `supersededAt`,
`supersededByVersion`, `indexedAt`, `createdAt`.

Indexes: `chunkId` unique; `(status, language, schemeId)`;
`(schemeId, schemeVersion, status)`; `(status, field)`.

**`schemehistories` gains:** `ragIndexStatus`, `ragIndexRetryable`,
`ragIndexing`, index `(ragIndexRetryable, createdAt)`.

**No PII in the RAG layer.** Chunks hold public scheme text only — no user id,
no profile value. No migration needed: the collection is new and the
`SchemeHistory` additions default cleanly on existing rows.

**Indexes are declared in schema and have NOT been created or verified against
a live Atlas cluster.**

## 7. EMBEDDING APPROACH

One module decides who computes embeddings. Every stored vector records the
model that produced it, because vectors from different models are not
comparable and mixing them silently yields meaningless similarity scores. The
retriever **skips** rows whose `embeddingModel` differs from the active one
rather than scoring them.

| Provider | Model | Dims | Executed? |
|---|---|---|---|
| `gemini` | text-embedding-004 | 768 | **NO** |
| `ollama` | nomic-embed-text | 768 | **NO** |
| `local-hash` | local-hash-256 | 256 | Yes — default |

### `local-hash` is NOT semantic embedding quality

Stated as plainly as I can. It projects hashed word tokens into a fixed vector:
two texts **sharing words** score highly; two texts **meaning the same thing in
different words** score near zero. It captures lexical overlap only.

It exists so the pipeline can be built and tested deterministically with no
network and no API key. Every structural property this phase is about —
versioning, invalidation, filtering, metadata, failure isolation — is
provider-independent and is fully exercised by it.

**No retrieval-quality claim may be made from it.** Anything measured under
`local-hash` measures the plumbing, not the semantics. Every chunk it writes is
stamped `embeddingDegraded: true` so a later evaluation cannot mistake one for
the other, and the retriever surfaces the flag on every response.

On provider failure `embedBatch` **throws rather than falling back** to
`local-hash`: a lexical vector stored beside semantic ones would be indexed as
though comparable and would quietly poison every later score.

## 8. VECTOR STORE APPROACH

**MongoDB Atlas, the same cluster, one new collection. No second vector DB.**

The property that makes this knowledge base version-aware is a join between a
vector and a scheme version. Splitting those across two datastores means keeping
them consistent through every collection cycle, for no benefit at this scale.

Two strategies behind one interface, switched by `VECTOR_SEARCH_STRATEGY`:

- **`scan`** — fetch by metadata, score cosine in Node. `O(chunks)`. **Default.**
- **`atlas`** — `$vectorSearch` aggregation. Preferred at scale.

### Atlas is implemented and EXPLICITLY UNVERIFIED

`atlasSearch()` is written, syntax-checked, and **has never executed**. I cannot
reach your Atlas cluster from this environment, so I cannot confirm the tier
supports `$vectorSearch` or that an index exists. Shipping it as the default
would mean shipping a never-run code path disguised as the recommended one.

To enable it: create a vector index named by `ATLAS_VECTOR_INDEX` on
`schemechunks`, over `embedding`, with the dimension your provider emits (768
for gemini/ollama), filter fields `status`, `language`, `schemeId`. Then set
`VECTOR_SEARCH_STRATEGY=atlas`. Nothing above the retriever changes.

## 9. VERSIONING STRATEGY

| Change type | Action |
|---|---|
| `NEW` | chunk → embed → index, all ACTIVE |
| `UPDATED` | chunk → **embed** → **then** supersede previous → index new |
| `NO_CHANGE` | nothing at all |

Three decisions carry the weight, and all three are mutation-tested:

**Supersede, never delete.** Phase K explains a change by citing what a scheme
*used to say*, and research reproducibility requires reconstructing what the
system knew at a past time. `status ∈ {ACTIVE, SUPERSEDED}` separates current
from historical. Ordinary retrieval filters to ACTIVE; history is reachable only
through the explicit `retrieveHistorical()` call, so no ordinary question can be
accidentally answered from a superseded chunk — proven by a test that queries
the OLD text word-for-word and gets nothing.

**Embed first, supersede second.** Reversing this would leave a scheme with
**zero** ACTIVE chunks during a provider outage — the assistant would answer *"I
have no information about this scheme"* about something it knew a minute ago.
Embedding first means a failure leaves the previous version **active and merely
stale**: the better of two bad states, and the only one a retry fixes.

**Deterministic `chunkId` = `${schemeId}:v${version}:${field}:${ordinal}`.**
Derived, not random, so re-indexing a version is idempotent — the unique index
rejects the duplicate rather than creating a second copy every search returns
twice. A version-less id would collide across versions, and under the unique
index that collision is *silently swallowed as a duplicate*, so v2's text would
never be written and retrieval would keep serving v1's.

The failure the whole strategy prevents: a scheme whose income ceiling changed,
whose eligibility recomputed correctly, whose users were correctly notified —
and whose knowledge base still returns the old ceiling, with a citation, which
makes it more convincing rather than less.

## 10. GROUNDING STRATEGY

At the Phase M layer, grounding means: **retrieval returns evidence, never
answers.** `ragRetriever` generates no text, so nothing it produces can be
untraceable — every item names the scheme, version, field, source and score.

- `sufficient` is a property of the **evidence**, not of any model's confidence.
- A **minimum score floor** (`RAG_MIN_SCORE`) rejects the "least irrelevant
  chunk". Retrieval always returns *something* — nearest vectors exist whether
  or not they are relevant — so without a floor the system answers a passport
  question from a scholarship document. Mutation-tested: removing the floor
  makes the same unrelated query report itself as sufficient.
- Empty knowledge base, empty query, or nothing over the floor → `sufficient:
  false`, `results: []`. No guess, no nearest-miss.
- An embedding outage returns insufficient **rather than falling back to a
  keyword scan**: a silent fallback would change what "retrieved" means
  mid-outage *while still returning citations*, which is worse than nothing.

The prompt-side half of grounding (facts vs. retrieved text vs. generated
wording) belongs to Phase N and is not claimed here.

## 11. PROMPT-INJECTION PROTECTION

Two tests cover the storage layer.

Injected scheme text is **stored verbatim**. Sanitising at the indexer would be
the wrong layer: it would silently alter what a government page actually said,
and the project's own change detection would then diff against edited text.
Containment belongs at the prompt boundary.

What is asserted here: injected text receives **no special status, ranking or
privilege**. It is a chunk like any other, carrying the same provenance, and
retrievable through the same filters. Nothing in the indexing or retrieval path
interprets chunk text as an instruction, because nothing in that path interprets
chunk text at all — it is data being moved and scored.

**The prompt boundary itself is Phase N** (`<retrieved_content>` delimiters, a
system prompt declaring them data, and the eligibility-authority guard). Not
claimed in this delivery.

## 12. FAILURE HANDLING

| Failure | Behaviour |
|---|---|
| Embedding provider down (indexing) | `FAILED`; previous version left **ACTIVE and stale**; hourly sweep retries |
| Embedding provider down (retrieval) | `sufficient: false`, error reported; **no keyword fallback** |
| Vector search throws | Error reported, not an empty success |
| Some chunk writes fail | Partial `INDEXED` — successful chunks kept, errors recorded |
| All chunk writes fail | `FAILED` |
| Supersede fails | Non-fatal, recorded; two versions may be ACTIVE until retry |
| Duplicate chunk (replay) | `duplicatesSkipped`, no second copy |
| Indexer throws unexpectedly | Caught in the pipeline; policy status untouched |
| `RAG_INDEXING=false` | `SKIPPED`; everything else exactly correct |

**Isolation, both directions — the core of requirement 16:**

- A `FAILED` index leaves `record.status = SUCCEEDED`, `retryable = false`, and
  `record.errors` **empty**. RAG errors go only to `ragErrors`.
- A failed propagation leaves `ragIndexStatus = SUCCEEDED`.
- The two retry sweeps key off two different flags (`policyRetryable` vs
  `ragIndexRetryable`) and two different indexes.

`indexScheme` never throws. The pipeline also wraps it in a try/catch anyway,
because "written not to throw" is a claim about today's code and the cost of
being wrong is a failed policy cycle.

## 13. TESTS ADDED

**65 tests in `tests/ragPipeline.test.js`**, all executed.

| Group | Tests |
|---|---|
| Embedding provider (determinism, unit length, degraded flag, dim mismatch) | 6 |
| Indexing by change type (NEW / UPDATED / UNCHANGED / bad input) | 5 |
| Version invalidation | 4 |
| Version-aware retrieval (current, historical, pinned, old-text-wins case) | 5 |
| Metadata preservation + structuredFacts | 3 |
| Filtering (scheme, language, field, model mismatch) | 4 |
| Grounded refusal + ordering + topK | 5 |
| Prompt injection | 2 |
| Embedding failure | 4 |
| Indexing failure isolation | 4 |
| Stale re-index sweep | 3 |
| Duplicate prevention | 4 |
| Pipeline isolation (`processSchemeChange`) | 7 |
| Scheduler (one scheduler, distinct guards) | 5 |
| Mutation checks | 4 |

Instrumentation (requirement 24) is recorded on every call — `embedMs`,
`searchMs`, `totalMs`, `candidatesScored`, `returned` on retrieval;
`durationMs`, `chunksIndexed`, `chunksSuperseded`, `duplicatesSkipped` on
indexing; `ragDurationMs` on the pipeline record. **Never asserted, never
reported as a result.**

## 14. TEST RESULTS

Phase M applied alone, with every Phase N artefact deleted and `app.js`
reverted:

```
558 passed, 0 failed, 0 skipped, 1 suite skipped   (miniJest, 505 ms)
```

Prior baseline **493** + 65 new = **558**. **No regression.**

```
npm run verify:agents
  Policy Change Agent — 73 passed, 0 failed
  Policy Impact Agent — 136 passed, 0 failed

npm run demo:policy-change  -> passed
```

**Mutation testing — 6 mutants introduced into production code, 6 killed:**

| Mutant | Result |
|---|---|
| Retriever ignores `status` (superseded becomes retrievable) | killed — 4 tests |
| Score floor removed | killed — 2 tests |
| Supersede uses `$lte` (kills the version just written) | killed — 2 tests |
| Indexer runs on `NO_CHANGE` | killed — 2 tests |
| Supersede **before** embed | killed — 1 test |
| RAG failure marks policy retryable | killed — 2 tests |

## 15. REGRESSIONS FOUND / FIXED

**One regression, found and fixed.**

Adding the RAG sweep broke `notificationAgent.test.js` → *"adds a job to the
existing scheduler rather than a second one"*, which pinned `cron.schedule(`
calls to exactly **2**.

I did not relax it. The count was a **proxy** for "one scheduler" and was wrong
in both directions: it failed on a correct change, and it would have **passed a
genuinely broken one** — a file with two `require("node-cron")` calls and one
schedule each also counts 2, which is exactly the bug the test exists to catch.

It now asserts the real invariant: one cron module, one `startScheduler`, and
one **distinct** overlap guard per job. I then introduced both bugs the old
version would have missed (a duplicate `node-cron` require; a shared overlap
guard) and confirmed each fails the new assertion.

**Two latent bugs found and fixed during development:**

- `tests/helpers/inMemoryDb.js` had **no `updateMany`**. The indexer's
  invalidation is a single `updateMany`, so this was implemented for real rather
  than stubbed — a stub touching one row would let a half-superseded index pass.
- `.env.example` claimed completeness but omitted `POLICY_CHANGE_LLM`,
  `RATE_LIMIT_MAX` and `COLLECT_RATE_LIMIT_MAX` (all pre-existing). Now
  verified: all 55 `process.env` keys the code reads are documented.

## 16. WHAT WAS ACTUALLY EXECUTED

- `node scripts/miniJest.js` — 558 passed, 0 failed, on the Phase-M-only tree.
- `node scripts/verifyPolicyChangeAgent.js` — 73/73.
- `node scripts/verifyPolicyImpactAgent.js` — 136/136.
- `node scripts/demoPolicyChange.js` — passed.
- `node --check` on every created and modified file.
- 6 mutation runs against production code, each reverted after.
- Isolation run: Phase N deleted, `app.js` reverted, suite re-run.
- `local-hash` embeddings computed for real throughout.
- Static audit confirming no PII or secret reaches the RAG logs.

## 17. WHAT WAS **NOT** EXECUTED

- **Real Jest.** `npm install` fails — every registry returns 403 in this
  sandbox. All 558 results come from **miniJest**, a hand-written Jest-subset
  runner. It is not Jest. `npm test` on Windows is the authoritative run.
- **`tests/api.test.js`** — skipped since Phase H (`supertest` uninstallable).
- **Atlas `$vectorSearch`** — never run. No vector index created or verified.
- **Gemini and Ollama embeddings** — never called. Dimension handling, latency
  and quota behaviour unverified.
- **Real MongoDB.** All persistence runs against `tests/helpers/inMemoryDb.js`.
  Index creation, strict-mode behaviour on the new `SchemeHistory` fields, and
  concurrency under a real server are unverified.
- **No LLM call of any kind** was made in Phase M — the phase does not contain
  one.
- **No latency, accuracy, retrieval or grounding-rate number is reported
  anywhere**, because none has been measured on real infrastructure.

**Nothing here is production-ready.**

## 18. LIMITATIONS

1. `local-hash` is lexical, not semantic, and is the only provider exercised.
2. `scan` is `O(chunks)` — fine for a few thousand, wrong for a million.
3. Atlas path unverified (§8).
4. `RAG_MIN_SCORE=0.25` is **not tuned**. It was chosen under `local-hash` and
   does not carry over to a semantic model.
5. **No multilingual support is claimed.** The project has no `language` field
   anywhere and no translation pipeline. I carried a `language` field
   (default `"en"`) through chunk, filter and API, and tested that the **filter**
   works — so retrieving a Hindi chunk for an English question is *preventable*.
   **The system has no Hindi content and no multilingual processing.** The field
   is carried because adding it later would mean re-indexing everything.
6. Chunking inherits `schemeChunker`'s existing sections. The requirements list
   *application process*, *contact information* and *FAQs*; the collector does
   not produce those fields, so no chunk is created for them.
7. Retrieval currently scores the whole active set per query; no caching.
8. **Carried over, still open:** `JWT_SECRET` unset (login/register will 500);
   Atlas / Gemini / SMTP credentials in `.env` still look live and **unrotated**
   — `.env` is gitignored and untracked, but **I have not rotated them and make
   no claim that they are rotated**.

## 19. RESEARCH CONTRIBUTION

Phase M's contribution is not "we added RAG". It is:

> **A retrieval knowledge base driven by the same change detection that drives
> the policy engine, so the corpus cannot describe a policy state the
> eligibility engine has already moved past.**

The ordinary RAG failure mode is silent staleness: an index built once becomes a
confident liar *with a citation*, which makes it more persuasive rather than
less. It produces no exception, no log line, and a plausible answer. Here
`NEW` / `UPDATED` / `NO_CHANGE` drives indexing, invalidation and skipping, so
staleness is a detectable, recoverable state rather than an invisible one.

Two mechanisms make it hold under failure and under replay, and both are
mutation-tested:

- **embed-before-supersede**, so an outage degrades to *stale* rather than
  *absent*, and
- a **deterministic version-scoped `chunkId`**, so replay is idempotent and two
  versions cannot collide.

The claim is about **failure behaviour**, which is what makes it falsifiable:
the suite demonstrates what the system does when the provider is down, when a
write fails midway, when the same change is replayed, and when a query matches
superseded text better than current text.

**Not yet claimed:** any retrieval-quality, latency or accuracy result. Those
require §17 to be closed first — specifically a real embedding provider and a
labelled question set.

---

*Phase M complete. At the time this report was produced, Phase N had not started.*
