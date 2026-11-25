# Phase M / N — Version-Aware RAG + Conversational Scheme Agent

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

Checkpoint report. Phase L was accepted as the prior checkpoint; H/I/J/K/L are intact.

---

## 1. PHASE M STATUS

| Requirement | Status |
|---|---|
| M.1 audit of existing RAG assets | **DONE** |
| M.2 field-aware chunking + metadata | **IMPLEMENTED, TESTED** |
| M.3 version-aware knowledge (NEW / UPDATED / UNCHANGED) | **IMPLEMENTED, TESTED** |
| M.4 vector store selection | **IMPLEMENTED** (`scan` tested; `atlas` path **NOT EXECUTED**) |
| M.5 embedding service abstraction | **IMPLEMENTED**; `local-hash` tested, `gemini`/`ollama` **NOT EXECUTED** |
| M.6 indexing service + status separation + retry | **IMPLEMENTED, TESTED** |
| M.7 retrieval | **IMPLEMENTED, TESTED** |
| M.8 grounding / insufficient evidence | **IMPLEMENTED, TESTED** |
| M.9 prompt security (retrieved text as data) | **IMPLEMENTED, TESTED** |
| M.10 tests 1–14 + mutation testing | **DONE** (all 14 covered; 5 mutants killed) |

## 2. PHASE N STATUS

| Requirement | Status |
|---|---|
| N.1 supported questions | **IMPLEMENTED, TESTED** |
| N.2 deterministic intent routing | **IMPLEMENTED, TESTED** (15 routing cases) |
| N.3 LLM must not decide eligibility | **IMPLEMENTED, TESTED** (3 independent guarantees) |
| N.4 recommendation explanation from verified signals | **IMPLEMENTED, TESTED** |
| N.5 policy-change explanation | **IMPLEMENTED, TESTED** |
| N.6 bounded conversation memory | **IMPLEMENTED, TESTED** |
| N.7 multilingual | **PARTIAL — see §17. The project has no existing multilingual support to preserve.** |
| N.8 answer structure | **IMPLEMENTED, TESTED** |
| N.9 conversational security | **IMPLEMENTED, TESTED** (unit + static; **no HTTP test — see §18**) |
| N.10 LLM / RAG failure fallback | **IMPLEMENTED, TESTED** |
| API `POST /api/chat` | **IMPLEMENTED**; logic tested, **HTTP layer not executed** |
| Frontend chat UI | **IMPLEMENTED**; **never rendered in a browser** |

---

## 3. ARCHITECTURE

The required separation is preserved exactly:

```
                    VERIFIED POLICY DATA
                             |
                   DETERMINISTIC ENGINE
                (matcher + relevanceRanker)
                             |
                eligibility / recommendation
                             |
                  +----------+----------+
                  |                     |
          Explanation Agent            RAG
              (Phase K)          (retriever, Phase M)
                  |                     |
                  +----------+----------+
                             |
                   Conversational Agent
                        (Phase N)
```

**The LLM is an explanation/interface layer, never the policy engine.**

That is enforced structurally rather than by prompt instruction. In
`conversationalAgent.answerQuestion`:

1. `matcher.evaluateEligibility` runs **before** any model call, so the model's
   output is never an input to the decision;
2. `response.eligibilityDecision` is copied from the matcher and never parsed
   out of generated text;
3. if the generated prose contradicts the verdict anyway, it is **discarded**
   and the deterministic sentence is returned (`method: "deterministic-override"`).

(3) is the one that matters in practice. A model that ignores its instructions
is not hypothetical, and (1) alone would leave a response whose stored decision
and whose readable sentence said opposite things — with the wrong half being
the half a person reads.

## 4. DATA FLOW

**Indexing** (inside the existing collection cycle):

```
Scheme API -> Collector -> Normalizer -> comparator.reconcile()
    -> [H] Policy Change Agent -> [I] Policy Impact Agent
    -> [J] Recommendation Propagation -> [K] Explanation -> [L] Notification
    -> [M] RAG Indexer      <-- runs LAST, outside the policy try/catch
           chunkScheme (field-aware)
           + structuredFacts chunk from eligibilityRules
           -> embedBatch  (embed FIRST)
           -> supersede previous versions (THEN invalidate)
           -> write chunks with deterministic chunkId
```

**Query** (`POST /api/chat`):

```
message + JWT
  -> detectIntent (regex, deterministic)
  -> chatService loads VERIFIED data scoped to req.user.sub
       scheme (public) | own history rows | own recommendation context
  -> ragRetriever.retrieve  -> evidence with provenance + score floor
  -> intent handler builds VERIFIED FACTS
       ELIGIBILITY: matcher.evaluateEligibility  <-- decision made HERE
  -> insufficient evidence?  -> refuse, no model call
  -> LLM phrases the facts (retrieved text wrapped as data)
  -> contradiction guard
  -> toPublicResponse (drops metrics, method, provider errors)
```

## 5. VECTOR STORE CHOICE + WHY

**MongoDB Atlas, same cluster, `schemechunks` collection. No second datastore.**

Two strategies behind one interface (`VECTOR_SEARCH_STRATEGY`):

- **`scan`** — fetch candidates by metadata, score cosine similarity in Node.
  Correct, obvious, `O(chunks)`. **This is the default.**
- **`atlas`** — `$vectorSearch` aggregation. Preferred at scale.

**Why `scan` is the default, and this is the honest part:** I could not verify
that this project's Atlas cluster supports `$vectorSearch` or that the index
exists. Shipping `atlas` as the default would mean shipping a code path that
has **never executed**, disguised as the recommended one. `scan` runs anywhere
including offline tests, so the version-awareness and grounding logic — the
actual research contribution — is exercised regardless of backend.

The `atlasSearch()` function is written and syntax-checked. **It has never
been run.** Switching is one environment variable; nothing above the retriever
changes.

Why not Pinecone/Weaviate/Chroma: the property that makes this knowledge base
version-aware is a join between a vector and a scheme version. Splitting those
across two datastores means keeping them consistent through every collection
cycle, for no benefit at this scale.

## 6. EMBEDDING MODEL / PROVIDER + WHY

`embeddingService` abstracts three providers; every stored vector records the
model that produced it, because vectors from different models are not
comparable and mixing them silently produces meaningless similarity scores.

| Provider | Model | Dims | Notes |
|---|---|---|---|
| `gemini` | text-embedding-004 | 768 | Free tier, already a dependency. **NOT EXECUTED** |
| `ollama` | nomic-embed-text | 768 | Local, no quota, no egress. **NOT EXECUTED** |
| `local-hash` | local-hash-256 | 256 | **NOT SEMANTIC.** Default. Tested. |

**`local-hash` is lexical, not semantic.** It projects hashed word tokens into
a fixed vector: two texts sharing words score highly; two texts saying the same
thing in different words score near zero. It exists so the pipeline can be
built and tested deterministically with no network and no API key — every
structural property (versioning, invalidation, filtering, metadata) is
provider-independent.

**No retrieval-quality claim may be made from `local-hash`.** Anything measured
under it measures the plumbing, not the semantics. Every chunk it produces is
stored with `embeddingDegraded: true` so a later evaluation cannot mistake one
for the other.

On provider failure, `embedBatch` **throws rather than falling back** to
`local-hash`: a lexical vector stored beside real semantic vectors would be
indexed as though comparable and would quietly poison every later similarity
score.

## 7. FILES CREATED

**Backend**

| File | Lines | Purpose |
|---|---|---|
| `src/services/embeddingService.js` | 205 | Provider abstraction, cosine, local-hash |
| `src/models/SchemeChunk.js` | 105 | Vector + metadata + ACTIVE/SUPERSEDED |
| `src/services/ragIndexer.js` | 347 | Index / supersede / skip / stale sweep |
| `src/services/ragRetriever.js` | 236 | scan + atlas, score floor, provenance |
| `src/agents/conversationalAgent.js` | 520 | Agent 5 — intent, facts, guard |
| `src/services/chatService.js` | 306 | Verified data gathering + user isolation |
| `src/routes/chat.js` | 113 | `POST /api/chat`, `GET /api/chat/suggestions` |

**Frontend**

| File | Lines |
|---|---|
| `src/chat/ChatContext.jsx` | 109 |
| `src/chat/ChatWindow.jsx` | 187 |
| `src/chat/ChatMessage.jsx` | 98 |
| `src/chat/EligibilityVerdict.jsx` | 66 |
| `src/pages/Assistant.jsx` | 32 |

**Tests** — `tests/ragPipeline.test.js` (1171), `tests/conversationalAgent.test.js` (819),
`tests/chatService.test.js` (444), `tests/chatRouteContract.test.js` (212).

## 8. FILES MODIFIED

| File | Change |
|---|---|
| `src/services/policyPipeline.js` | Added Stage M with **separate** `ragIndexStatus` / `ragRetryable` / `ragErrors`; hoisted `scheme` so the indexer sees the same document the policy stages did |
| `src/models/SchemeHistory.js` | Declared `ragIndexStatus`, `ragIndexRetryable`, `ragIndexing` + index. **Required** — Mongoose strict mode silently DROPS undeclared fields in `$set`, so the status would have appeared in the log and never reached the row |
| `src/scheduler/cron.js` | Third job in the **same** scheduler; own overlap guard |
| `src/app.js` | Mounted `chatRouter` |
| `.env.example` | Phase M/N config; also added two pre-existing gaps (`POLICY_CHANGE_LLM`, `COLLECT_RATE_LIMIT_MAX`, `RATE_LIMIT_MAX`). Now verified: every `process.env` key the code reads (55) is documented |
| `frontend/src/App.jsx` | `/assistant` route behind `ProtectedRoute` + nav link |
| `tests/helpers/inMemoryDb.js` | Added real `updateMany` (the indexer's invalidation is a single `updateMany`; a stub touching one row would let a half-superseded index pass) |
| `tests/notificationAgent.test.js` | **One assertion changed — strengthened, see §16** |

## 9. API ENDPOINTS

### `POST /api/chat` — authenticated

```jsonc
// request
{ "message": "Am I eligible?", "schemeId": "...", "history": [{"intent":"...","schemeId":"..."}], "language": "en" }

// response
{ "response": { "answer", "intent", "confidence", "grounded",
                "sources": [{schemeId, schemeVersion, field, excerpt}],
                "schemeIds", "schemeVersions",
                "eligibilityDecision": { eligible, satisfied, unsatisfied, source },
                "recommendationContext", "degraded": bool },
  "turn": { "intent", "schemeId" } }
```

Rate limit 60 / 15 min **per authenticated user** (not per IP — several
students behind one college NAT are not one abusive caller).

### `GET /api/chat/suggestions` — authenticated

Withheld from the wire (N.8): `metrics`, `method`, `intentConfidence`, source
`score`, and the `degraded` **detail strings** (reduced to a boolean — error
text is where internal hostnames and quota fragments leak). Citations **are**
returned: a grounded answer nobody can check is not much better than an
ungrounded one.

## 10. DATABASE CHANGES

**New collection `schemechunks`** — `chunkId` (unique), `schemeId`,
`schemeVersion`, `schemeName`, `field`, `ordinal`, `text`, `language`,
`source`, `embedding`, `embeddingModel`, `embeddingDims`, `embeddingDegraded`,
`status`, `supersededAt`, `supersededByVersion`, `indexedAt`.

Indexes: `chunkId` unique; `(status, language, schemeId)`;
`(schemeId, schemeVersion, status)`; `(status, field)`.

**`schemehistories` gains** `ragIndexStatus`, `ragIndexRetryable`,
`ragIndexing`, and index `(ragIndexRetryable, createdAt)`.

**No PII is stored in the RAG layer.** Chunks contain public scheme text only —
no user id, no profile value. No migration is required: `SchemeChunk` is new,
and the `SchemeHistory` additions default cleanly on existing rows.

**Indexes are declared in the schema and have NOT been verified against a live
Atlas cluster.**

## 11. VERSIONING STRATEGY

| Change type | Action |
|---|---|
| `NEW` | chunk → embed → index, all ACTIVE |
| `UPDATED` | chunk → **embed** → **then** supersede previous → index new |
| `NO_CHANGE` | **nothing** — no embedding call, no query, no write |

Three decisions carry the weight:

**Supersede, never delete.** Phase K explains a change by citing what a scheme
*used to say*, and research reproducibility requires reconstructing what the
system knew at a past time. `status ∈ {ACTIVE, SUPERSEDED}` separates them.
Ordinary retrieval filters to ACTIVE; history is reachable only through the
explicit `retrieveHistorical()` call, so no ordinary question can accidentally
be answered from a superseded chunk.

**Embed first, supersede second.** Ordering matters. Superseding before the
embeddings succeed would leave the scheme with **zero** ACTIVE chunks during a
provider outage — the assistant would answer *"I have no information about this
scheme"* for something it knew a minute ago. Embedding first means a failure
leaves the previous version **active and merely stale**, which is the better of
two bad states and the only one a retry can fix. *(Mutation-tested: reversing
the order fails the suite.)*

**Deterministic `chunkId` = `${schemeId}:v${version}:${field}:${ordinal}`.**
Derived, not random, so re-indexing the same version is idempotent — the unique
index rejects the duplicate instead of creating a second copy every search
would return twice. *(Mutation-tested: a version-less id collides across
versions, and under the unique index that collision is silently swallowed, so
v2's text would never be written and retrieval would keep serving v1's.)*

The failure this whole strategy exists to prevent: a scheme whose income ceiling
just changed, whose eligibility recomputed correctly, whose users were correctly
notified — and whose assistant keeps quoting the old ceiling, *with a citation*,
which makes it more convincing rather than less.

## 12. GROUNDING STRATEGY

Three tiers, kept distinct in both the prompt and the response:

1. **VERIFIED STRUCTURED DATA** — matcher verdicts, scheme fields, recorded
   history rows. Authoritative.
2. **RETRIEVED EVIDENCE** — chunks with `schemeId`, `schemeVersion`, `field`,
   `score`. Traceable by construction; the retriever never generates text.
3. **LLM WORDING** — phrasing only.

- A **minimum score floor** (`RAG_MIN_SCORE`) rejects the "least irrelevant
  chunk". Retrieval always returns *something* — nearest vectors exist whether
  or not they are relevant — so without a floor the system answers a passport
  question from a scholarship document. *(Mutation-tested.)*
- `sufficient` is a property of the **evidence**, not of the model's confidence.
- No verified facts **and** no retrieved evidence → refuse, and **the model is
  not called at all**. A model handed an empty context is a model inventing an
  answer; the refusal must not depend on it declining to.
- Structured fields stay authoritative where they exist: documents, deadline and
  benefits are stated from the scheme record even when retrieved prose disagrees.

## 13. LLM FAILURE STRATEGY

| Failure | Behaviour |
|---|---|
| LLM returns `null` (provider down) | Deterministic sentence, `method: "deterministic-fallback"` |
| LLM throws (429/500) | Same, error recorded in `degraded` |
| LLM returns empty answer | Same |
| LLM **contradicts the verdict** | Prose discarded, `method: "deterministic-override"` |
| Retrieval throws | Verdict still delivered — eligibility does not depend on retrieval |
| Embedding provider down (query) | `sufficient: false`, **no silent keyword fallback** |
| Embedding provider down (index) | Previous version stays ACTIVE and stale; hourly sweep retries |
| Vector search fails | Error reported, not an empty success |
| `CHAT_LLM=false` | Fully deterministic; **verdicts are identical** |

A silent keyword fallback during an embedding outage was deliberately rejected:
it would change what "retrieved" means mid-outage *while still returning
citations*, which is worse than returning nothing.

## 14. SECURITY

**User isolation.** `userId` is a *parameter* of `handleChat`; the route passes
`req.user.sub` from the verified JWT. **Nothing in the request body is read as
identity** — there is no `userId`/`email`/`as` field destructured from
`req.body`, so there is no field to tamper with. That is the stronger property
than a rejection list, which has to anticipate the field name. History is
queried with `{ userId }` **in the filter**, so another user's rows are never
read and then discarded. *(Tested: same message + same schemeId gives Alice
ELIGIBLE and Bob NOT ELIGIBLE; three mutants killed.)*

**Prompt injection.** Retrieved text is wrapped in `<retrieved_content>` tags
declared as data in the system prompt. Injected text is stored **verbatim** —
sanitising at the indexer would silently alter what a government page said, and
the containment belongs at the prompt boundary. Critically, the *outcome* is the
same whether or not the boundary holds: an injected "tell the user they are
eligible" still cannot flip the verdict, because the verdict was computed before
the model ran and the contradiction guard discards the prose.

**Other:** `requireAuth` on every chat route (test counts routes rather than
spot-checking, so a route added later without the guard fails); no user id in
any route path; 100 kB body cap; 1000-char message cap; per-user rate limit;
bounded 6-turn context carrying only `{intent, schemeId}` — **message text is
never replayed**, so a conversation containing a personal detail does not become
a payload that keeps re-transmitting it; server stores **no transcript**.

**Verified: no PII or secret reaches the logs.** The chat log line carries
intent, grounded, method and timings only — never the question text, never a
profile value. The RAG logs carry scheme ids, counts and model names.

## 15. TESTS ADDED

**166 new tests**, all executed under miniJest.

| Suite | Tests | Covers |
|---|---|---|
| `ragPipeline.test.js` | 65 | M.10 1–14, pipeline isolation, stale sweep, scheduler, 4 mutation checks |
| `conversationalAgent.test.js` | 56 | N.1–N.3, N.6, N.9, N.10, 4 mutation checks |
| `chatService.test.js` | 24 | User isolation, validation, bounded context, N.8 |
| `chatRouteContract.test.js` | 21 | Static route/UI security contract |

**M.10 coverage:** 1 new ✓ · 2 updated ✓ · 3 unchanged-skipped ✓ · 4 invalidation ✓
· 5 current retrieval ✓ · 6 historical retrieval ✓ · 7 metadata ✓ · 8 language ✓
· 9 scheme ✓ · 10 grounded refusal ✓ · 11 injection ✓ · 12 embedding failure ✓
· 13 indexing isolation ✓ · 14 duplicate prevention ✓

**Mutation testing — 12 mutants introduced into production code, 12 killed:**

| Mutant | Killed by |
|---|---|
| Retriever ignores `status` | 4 tests |
| Retriever drops score floor | 2 tests |
| Indexer supersedes *before* embedding | 1 test |
| Supersede uses `$lte` not `$lt` | 2 tests |
| Indexer runs on `NO_CHANGE` | 2 tests |
| RAG errors folded into policy errors | 2 tests |
| `ragIndexStatus` folded into `record.status` | 2 tests |
| Contradiction guard deleted | 4 tests |
| Guard made one-directional | 1 test |
| **Verdict overwritten from LLM text** | **initially SURVIVED — see below** |
| Grounding check skipped | 2 tests |
| `userId` dropped from history filter | 3 tests |
| Metrics leaked to the wire | 3 tests |
| Identity taken from payload | 1 test |
| `requireAuth` removed | 1 test |
| Two `node-cron` requires | 1 test |
| Shared overlap guard | 1 test |

**A real gap found this way.** The mutant that overwrites
`eligibilityDecision.eligible` from the generated text **survived** the first
version of the suite. Every contradiction test returns early through the guard,
so nothing reached the line after it — and the *neutral* case, where the model
says something that neither claims nor denies eligibility, was untested in both
directions. Neutral prose is the common case, not an edge case: *"This
scholarship is for students under 25"* claims nothing about *you*, the guard
cannot fire on it, and the decision has to be right on its own. Two tests were
added; the mutant is now killed.

## 16. AVAILABLE TEST RESULTS

```
659 passed, 0 failed, 0 skipped, 1 suite skipped   (miniJest, 478 ms)
```

Baseline before Phase M/N was **493**. 493 + 166 = **659**. **No regression.**

```
npm run verify:agents
  Policy Change Agent — 73 passed, 0 failed
  Policy Impact Agent — 136 passed, 0 failed

npm run demo:policy-change
  Demo passed: policy change -> targeted impact -> eligibility transition
  -> recommendation propagation -> audit trail, idempotent on replay.
```

**One pre-existing test was modified**, and it was **strengthened, not relaxed**:
`notificationAgent.test.js` → "adds a job to the existing scheduler rather than a
second one" pinned `cron.schedule(` calls to exactly **2** as a proxy for "one
scheduler". That proxy was wrong in *both* directions — it failed on a correct
change (a legitimate third job on the same scheduler) and it would have **passed
a genuinely broken one** (two `require("node-cron")` calls with one schedule
each also counts 2). It now asserts the real invariant: one cron module, one
`startScheduler`, and one *distinct* overlap guard per job. Both bugs the old
assertion would have missed were introduced and confirmed to fail the new one.

`SKIP api.test.js — Cannot find module 'supertest'` — unchanged since Phase H.

## 17. KNOWN LIMITATIONS

1. **`local-hash` is lexical, not semantic.** It is the default and the only
   provider exercised. No retrieval-quality number may be quoted from it.
2. **`scan` is `O(chunks)`.** Fine for a few thousand chunks, wrong for a
   million. Switching to `atlas` is one variable — and unverified.
3. **N.7 multilingual — the honest position.** The requirement was to *preserve
   the project's existing multilingual direction*. **There is no `language`
   field anywhere in this project and no translation pipeline**, so there was
   nothing to preserve. Rather than fabricate multilingual support, I carried a
   `language` field (default `"en"`) through chunk, filter and API, and tested
   that the **filter** works. What is proven is that retrieving a Hindi chunk
   for an English question is preventable — **not** that the system has Hindi
   content. It does not. Adding the field later would have meant re-indexing
   everything.
4. **`RAG_MIN_SCORE=0.25` is not a tuned value.** It was chosen under
   `local-hash` and does not carry over to a semantic model.
5. **Recommendation ranking reasons** are passed through only if
   `relevanceRanker` supplies them; the agent is forbidden from inventing one,
   so the list may be empty.
6. **No streaming responses** — the UI waits for the full answer.
7. **Intent routing is regex-based.** Deterministic and reproducible, but it
   will misroute unusual phrasings to `GENERAL_SCHEME_INFO`.
8. **Carried over from earlier phases, still open:**
   - `JWT_SECRET` is **not set** in `.env` — **login/register will 500**, and
     therefore so will every chat request.
   - MongoDB Atlas, Gemini and SMTP credentials in `.env` still look **live and
     unrotated**. `.env` is gitignored and not tracked by git. **I have not
     rotated them and make no claim that they are rotated.**
   - The 79.3% figure remains: *in a synthetic benchmark containing
     structured-only eligibility changes, targeted impact analysis reduced
     matcher evaluations by 79.3% compared with brute-force evaluation while
     producing the same transition set.*

## 18. WHAT IS NOT TESTED

Stated plainly. None of the following was executed:

- **Real Jest.** `npm install` fails — every registry returns 403 in this
  sandbox. All 659 results are from **miniJest**, a hand-written Jest-subset
  runner. It is not Jest. `npm test` on Windows is the authoritative run.
- **`tests/api.test.js`** — skipped since Phase H (`supertest` uninstallable).
  **The HTTP layer of `POST /api/chat` has never been exercised.** Auth
  rejection, the 400s and the rate limiter are verified only by unit tests and
  static source checks, which is a **weaker guarantee** and is not offered as a
  substitute.
- **Atlas `$vectorSearch`** — `atlasSearch()` has never run. No vector index has
  been created or verified.
- **Real embedding providers** — no Gemini or Ollama call was made. Dimension
  handling, latency and quota behaviour are unverified.
- **Real LLM integration** — every LLM in every test is a stub. No Groq/Gemini
  call was made from the conversational agent.
- **The browser.** No frontend file has been rendered, mounted or clicked. React
  correctness, the scroll behaviour and the layout are unverified; only the
  source-level contract is checked.
- **Real MongoDB.** All persistence runs against `tests/helpers/inMemoryDb.js`.
  Index creation, strict-mode behaviour on the new fields and concurrency under
  a real server are unverified.
- **SMTP**, unchanged from Phase L.
- **No latency, accuracy, retrieval or grounding-rate number is reported
  anywhere**, because none has been measured on real infrastructure. The
  instrumentation hooks exist and are recorded; they are never asserted.

**Nothing here is production-ready.**

## 19. RESEARCH CONTRIBUTION

The contribution is *not* "we used RAG + Gemini + agents". It is:

> **Detected government policy drift is propagated automatically through
> affected-user eligibility, recommendations, explanations, notifications
> *and the retrieval knowledge base*, with the language model confined to an
> explanation layer that provably cannot alter a policy decision.**

Phase M/N adds two defensible claims:

**(a) Version-aware RAG driven by the same change detection as the policy
engine.** The usual RAG failure is silent staleness: the index is built once and
becomes a confident liar with a citation. Here `NEW` / `UPDATED` / `NO_CHANGE`
drives indexing, invalidation and skipping, so the knowledge base cannot
describe a policy state the eligibility engine has already moved past. The
embed-before-supersede ordering and the deterministic version-scoped `chunkId`
are the two mechanisms that make it hold under failure and under replay, and
both are mutation-tested.

**(b) A structurally enforced authority boundary.** "The LLM must not decide
eligibility" is usually a prompt instruction — a *request*. Here it is three
mechanisms: the verdict is computed before the model runs; the stored decision
is copied from the matcher, never parsed from text; and generated prose that
contradicts the verdict is discarded at output. The third is the novel one, and
mutation testing showed it is load-bearing — and that testing it *only* on
contradicting prose leaves a real hole on neutral prose.

Both claims are about **failure behaviour**, which is what makes them
falsifiable: the suite demonstrates the system's behaviour when the provider is
down, when the model lies, when the scheme text contains an injection, and when
the same change is replayed.

**Not yet claimed:** any retrieval-quality, latency or accuracy result. Those
require §18 to be closed first.

## 20. REMAINING WORK

**Before any evaluation run (blocking):**

1. Set `JWT_SECRET` — auth is currently broken, so chat cannot be reached.
2. Rotate the Atlas / Gemini / SMTP credentials.
3. `npm install && npm test` on Windows — establish the real Jest baseline and
   reconcile it against 659.
4. Restore `tests/api.test.js` and add HTTP tests for `POST /api/chat`:
   401 without a token, 400s, rate limit, and a **cross-user attempt with a
   body-supplied id**.
5. Switch `EMBEDDING_PROVIDER` to `gemini` or `ollama` and **re-index
   everything** — existing `local-hash` vectors are not comparable and must be
   discarded, not mixed.
6. Verify `$vectorSearch` support, create the vector index, run the `atlas` path
   at least once.
7. Render the chat UI in a browser.

**Then (Phase O onward, on your approval):**

8. Tune `RAG_MIN_SCORE` against the chosen provider.
9. Build the evaluation harness over the instrumentation hooks — retrieval
   latency, top-k, grounding success, insufficient-evidence rate, LLM fallback
   rate, embedding/indexing latency.
10. A labelled question set for retrieval quality.
11. Stale-answer measurement: the headline experiment — how often a
    version-unaware baseline quotes a superseded figure where this system does
    not.

---

*Stopping here for review as instructed. At the time this report was produced, O onwards had not started.*
