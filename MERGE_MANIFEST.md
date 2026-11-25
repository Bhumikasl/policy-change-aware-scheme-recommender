# MERGE MANIFEST — Original Base → Phase Z (FINAL)

## CURRENT STATE OF THIS TREE

```
BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y → Z
```

Z is the terminal phase — final release audit, no phase AA. See
`backend/docs/PHASE_Z_REPORT.md` for the full account of what was verified,
what wasn't, and why.

**One cumulative project. There are no per-phase folders and nothing to merge.**

```
final_project/
├── backend/     Node + Express + MongoDB + node-cron
└── frontend/    React + Vite
```

| Phase | State | Principal files |
|---|---|---|
| BASE | Complete | `collectors/`, `services/matcher.js`, models, routes |
| H | Complete | `services/comparator.js`, `services/pipeline.js` |
| I | Complete | `agents/policyChangeAgent.js`, `agents/policyImpactAgent.js` |
| J | Complete | `services/recommendationPropagation.js`, `services/policyPipeline.js` |
| K0 | Complete | `middleware/auth.js`, `routes/auth.js`, `config/bootstrapAdmin.js` |
| K | Complete | `agents/explanationAgent.js` |
| L / L.1–L.8 | Complete | `agents/notificationAgent.js`, `services/notificationService.js`, `services/notificationReadService.js`, `models/Notification.js` |
| M | Complete | `services/{schemeChunker,ragIndexer,ragRetriever,embeddingService}.js`, `models/SchemeChunk.js` |
| N | Complete | `agents/conversationalAgent.js`, `services/chatService.js`, `routes/chat.js` |
| O | Complete — retrieval quality WITHHELD under local-hash | `evaluation/{harness,staleAnswerExperiment}.js`, `docs/PHASE_O_REPORT.md` |
| P | Complete — primary metric NOT MEASURED (needs real LLM + human labels) | `evaluation/guardAblation.js`, `docs/P_EVALUATION.md` |
| Q | Complete — propagation soundness MEASURED | `evaluation/propagationOracle.js`, `docs/Q_EVALUATION.md` |
| R | Complete — R.1 MEASURED, R.2 NOT MEASURED | `evaluation/notificationCostExperiment.js`, `docs/PHASE_R_REPORT.md` |
| S | Complete — staleness bound DERIVED; scheduler hole fixed | `evaluation/stalenessBound.js`, `docs/PHASE_S_REPORT.md` |
| T | Complete — ranking order-invariance MEASURED; tie-break defect fixed | `evaluation/rankingStability.js`, `docs/PHASE_T_REPORT.md` |
| U | Complete — independent matcher verification; 306,180 cases AGREE | `evaluation/eligibilityReference.js`, `evaluation/matcherAgreement.js`, `docs/PHASE_U_REPORT.md` |
| V | Complete — change-detection completeness MEASURED; `eligibilityType` detection hole fixed | `evaluation/detectionOracle.js`, `evaluation/detectionCompleteness.js`, `docs/PHASE_V_REPORT.md` |
| W | Complete — public response-surface CONFINED; 50-field anonymous exposure fixed | `services/publicProjection.js`, `evaluation/responseSurface.js`, `docs/PHASE_W_REPORT.md` |
| X | Complete — three recommendation surfaces AGREE; audit trail ranked on incomplete candidates, fixed | `services/recommendationPropagation.js` (`buildCandidates`), `evaluation/surfaceAgreement.js`, `docs/PHASE_X_REPORT.md` |
| Y | Complete — index contract CONSISTENT; the operator checklist covered 8 of 47 indexes, now generated and checked | `evaluation/indexContract.js`, `INDEX_VERIFICATION.md`, `docs/PHASE_Y_REPORT.md` |
| Z | In progress — see `backend/docs/PHASE_Z_REPORT.md` §13. Real Jest run locally (by you) surfaced 2 genuine failures (`responseSurface.test.js`, `indexContract.test.js`); root-caused and fixed by source-level reasoning here (evaluator was reading a nonexistent `schema.indexes_`, one test asserted a false sandbox-stub artifact, one test had a too-short Jest timeout for a legitimate 8s connection attempt). **Fixes NOT yet re-verified against real Jest by either party in this thread** — re-run `npm test -- --runInBand` locally to confirm. miniJest itself: 194 passed, 0 failed, no regression. | `scripts/miniJest.js`, `src/evaluation/indexContract.js`, `tests/responseSurface.test.js`, `tests/indexContract.test.js`, `docs/PHASE_Z_REPORT.md` |

**Deletions: none, in any phase.** No file added by any phase has been removed
by a later one.

---

# HISTORICAL RECORD — the Base → P reconstruction

*Everything from here to §4 documents how the tree was originally rebuilt from
your archives, up to Phase P. It is kept because the recovery findings are still
useful — several files exist in no archive at all. It describes the state of the
project **at Phase P**, not its current state, which is the table above.*

Rebuilt from scratch. **No previous merged ZIP was used as a source.**

Method: start from your original archives, apply each phase archive in order,
record every add/modify, then recover in-session work that no archive captured.

```
BASE (backendfixed_8.zip + frontendfixed_2.zip)
 → H/I → J → J-validated → J-integration → K0 → K → L → L-gaps
 → M → N → O → P
```

---

## 0. THE MOST IMPORTANT FINDING — THE PHASE ARCHIVES ARE INCOMPLETE

Applying only BASE + the eight phase archives produces a **broken project**:
**15 unresolvable `require()` calls.**

These files are depended on by the phase code but exist in **no archive**:

| Missing from every archive | Needed by |
|---|---|
| `src/middleware/auth.js` | `routes/users.js`, `routes/schemes.js`, `routes/chat.js` |
| `src/middleware/errorHandler.js` | `routes/users.js` |
| `src/middleware/asyncHandler.js` | `routes/users.js` |
| `src/routes/auth.js` | `app.js` (register/login/me) |
| `src/services/llmClient.js` | `policyChangeAgent`, `explanationAgent`, `conversationalAgent` |
| `src/services/matcher.js` | `policyImpactAgent`, `recommendationPropagation`, `chatService` |
| `src/services/schemeVerifier.js` | `routes/users.js` |
| `src/services/deterministicExtractor.js` | `services/pipeline.js` |
| `src/services/hybridExtractor.js` | `services/pipeline.js` |
| `src/services/schemeChunker.js` | `ragIndexer` |

Also absent from every archive: `src/app.js` (auth + chat routers),
`src/routes/schemes.js` (K0 auth), `src/services/comparator.js` (H diffs),
`src/models/User.js` (passwordHash/role), all 15 pre-H and M–P test files, and
every `docs/` report.

All were genuinely implemented during our conversation. As you authorised, they
were **recovered from the workspace**, which is the only surviving source. Each
is listed under its phase below and marked *(recovered)*.

**Consequence:** the phase archives are a partial record. This manifest — and
the shipped tree — are the complete one.

## 1. BASE MANIFEST — what your original contained

53 files: **27 backend, 26 frontend** (`.env` excluded from the count and from
the ZIP).

**Backend (27):** `package.json`, `package-lock.json`, `src/app.js`,
`src/server.js`, `src/config/db.js`, `src/utils/logger.js`,
`collectors/{baseCollector,index,mySchemeCollector}.js`,
`models/{NotificationLog,Scheme,SchemeHistory,User}.js`,
`normalizer/normalizer.js`, `routes/{schemes,users}.js`,
`scheduler/{cron,runOnce}.js`, `scripts/{analyzeMatches,backfillEligibility}.js`,
`services/{aiSummary,comparator,eligibilityExtractor,eligibilityLevels,mailer,notifier,pipeline}.js`

**Frontend (26):** `package.json`, `package-lock.json`, `index.html`,
`vite.config.js`, `.gitignore`, `.oxlintrc.json`, `README.md`,
`public/{favicon,icons}.svg`, `src/{App.jsx,main.jsx,index.css}`,
`src/api/client.js`, `src/assets/{hero.png,react.svg,vite.svg}`,
`src/pages/{Admin,Browse,MyMatches,Register,SchemeDetail}.{jsx,css}`

**Verified after merge: all 53 are present.** Two intentional exceptions —
`backend/.env` (secrets, excluded) and nothing else. `package-lock.json` was
**lost in an earlier merge and has been restored byte-for-byte** from your ZIP.

**No original file was deleted.** `models/NotificationLog.js` is retained
untouched: Phase L added `Notification.js` as a *separate* model rather than
replacing it, and nothing in H–P deletes the original.

## 2. PHASE-BY-PHASE (BASE → P — historical reconstruction record)

Deletions: **none, in any phase.**

*Phases Q, R, S and T were built directly in this tree, not reconstructed from
archives. They are recorded in §2a.*

### Pre-H — security & extraction audit *(recovered; no archive)*
**Added:** `services/{matcher,llmClient,schemeVerifier,deterministicExtractor,hybridExtractor,schemeChunker}.js`,
`tests/{matcher,comparator,deterministicExtractor,hybridExtractor,schemeVerifier,schemeChunker,notifier,relevanceRanker}.test.js`,
`PROJECT_AUDIT.md`, `CHANGES.md`
**Modified:** `config/db.js`, `services/{aiSummary,eligibilityExtractor}.js`,
`collectors/mySchemeCollector.js`, `normalizer/normalizer.js`,
`scripts/backfillEligibility.js`, `frontend/pages/{Browse.jsx,MyMatches.css}`

### H — Policy Change Agent
**Added:** `agents/policyChangeAgent.js`, `scripts/verifyPolicyChangeAgent.js`,
`tests/policyChangeAgent.test.js`, `tests/helpers/fakeUserModel.js`
**Modified:** `services/comparator.js` *(recovered)* — field-level diffs;
`models/Scheme.js` *(recovered)* — `eligibilityRules`
**Preserved:** structured fields decided deterministically; the LLM is consulted
only for genuinely ambiguous prose and never for a direction.

### I — Policy Impact Agent
**Added:** `agents/policyImpactAgent.js`, `scripts/verifyPolicyImpactAgent.js`,
`tests/policyImpactAgent.test.js`
**Preserved:** `candidateSelection` ∈ {targeted-band, targeted-union, full-scan,
none, skipped}; `scannedEveryUser`, `narrowingProven`, `completenessGuaranteed`
all derived from one `contractFor()`; new schemes force `full-scan`.

### J — Recommendation propagation
**Added:** `models/RecommendationHistory.js`,
`services/recommendationPropagation.js`, `scripts/miniJest.js`,
`tests/recommendationPropagation.test.js`
**Modified:** `agents/policyImpactAgent.js`, `tests/helpers/fakeUserModel.js`

### J validation
**Modified:** `agents/policyImpactAgent.js`, `tests/policyImpactAgent.test.js`,
`tests/recommendationPropagation.test.js`
**Conflict resolved:** `exhaustive` was ambiguous; replaced by the explicit
candidate-selection contract. **Preserved:** soundness over optimisation — a
too-wide query is slow, a too-narrow one silently fails to tell someone they
lost a benefit.

### J integration
**Added:** `services/policyPipeline.js`, `services/relevanceRanker.js`,
`constants/recommendationTransitions.js`, `tests/helpers/inMemoryDb.js`,
`tests/pipelineIntegration.test.js`, `scripts/{demoPolicyChange,retryPolicyProcessing}.js`
**Modified:** `services/pipeline.js` (one call site, after `reconcile()`),
`models/{SchemeHistory,RecommendationHistory}.js`,
`services/recommendationPropagation.js`, `scripts/miniJest.js`
**Preserved:** `triggeringChangeId = ${schemeId}:v${version}` — deterministic,
deliberately not an ObjectId; unique index `(userId, schemeId,
triggeringChangeId)` is the idempotency mechanism, the pre-check only an
optimisation. Collection status and policy status stay separate.

### K0 — Auth & product integration
**Added (backend):** `middleware/{auth,errorHandler,asyncHandler}.js` *(recovered)*,
`routes/auth.js` *(recovered)*, `services/recommendationHistoryService.js`,
`tests/{apiContract,endToEndK0,recommendationHistoryApi}.test.js`,
`.env.example`, `INDEX_VERIFICATION.md`
**Added (frontend):** `auth/AuthContext.jsx`, `auth/ProtectedRoute.jsx`,
`pages/Login.jsx`, `pages/History.jsx`
**Modified (backend):** `routes/users.js`, `routes/schemes.js` *(recovered)*,
`models/User.js` *(recovered)*, `app.js` *(recovered)*, `services/pipeline.js`
**Modified (frontend):** `App.jsx`, `api/client.js`, `pages/{MyMatches,Register}.jsx`
**Preserved:** 401 clears the token, **403 does not** — a 403 means the token is
valid and the action is not allowed; clearing it would sign a user out for
opening an admin page.

### K — Explanation Agent
**Added:** `agents/explanationAgent.js`, `services/explanationTemplates.js`,
`tests/explanationAgent.test.js`
**Modified:** `services/recommendationPropagation.js`,
`models/RecommendationHistory.js`, `.env.example`
**Conflict resolved:** explanation failures initially marked propagation FAILED.
Changed to a non-fatal `explanationsFailed` counter — the audit trail is the
guarantee, the sentence is the courtesy.
**Preserved:** grounding check rejects any numeral the record cannot support;
`sufficientEvidence: false` rather than guessing.

### L — Notification Agent
**Added:** `agents/notificationAgent.js`, `models/Notification.js`,
`services/{notificationService,notificationReadService}.js`,
`constants/notificationTypes.js`, `tests/notificationAgent.test.js`
**Modified:** `services/policyPipeline.js` (Stage L, own status),
`routes/users.js`, `tests/helpers/inMemoryDb.js`
**Preserved:** the agent consumes Phase J transitions — **no `User.find({})`**.
Notification failure never marks policy propagation failed.

### L-gap closure
**Added (frontend):** `notifications/{NotificationContext,NotificationBell,NotificationItem}.jsx`,
`pages/Notifications.jsx`; **Added (backend):** `NOTIFICATION_ARCHITECTURE.md`
**Modified:** `agents/notificationAgent.js`, `services/notificationService.js`,
`constants/notificationTypes.js`, `models/{Notification,User}.js`,
`scheduler/cron.js` (**second job, same scheduler**), `App.jsx`, `.env.example`
**Preserved:** lifecycle `PENDING → SENDING → SENT | FAILED_RETRYABLE |
FAILED_PERMANENTLY | SUPPRESSED`, with read-state deliberately **not** in that
enum; disabling email leaves in-app working.

### M — Version-aware RAG *(no archive; from workspace)*
**Added:** `services/{embeddingService,ragIndexer,ragRetriever}.js`,
`models/SchemeChunk.js`, `tests/ragPipeline.test.js`
**Modified:** `services/policyPipeline.js` (Stage M, **separate**
`ragIndexStatus`/`ragRetryable`/`ragErrors`), `models/SchemeHistory.js`
(**required** — Mongoose strict mode silently drops undeclared `$set` fields),
`scheduler/cron.js` (**third job, same scheduler**), `tests/helpers/inMemoryDb.js`
(real `updateMany`), `tests/notificationAgent.test.js`
**Conflict resolved:** the scheduler test pinned `cron.schedule(` to exactly 2.
**Strengthened, not relaxed** — that count would have *passed* two
`require("node-cron")` calls with one schedule each, the actual bug. Now asserts
one cron module, one `startScheduler`, one distinct guard per job.
**Preserved:** embed **before** supersede, so a provider outage leaves the
previous version active-and-stale rather than the scheme with nothing.

### N — Conversational Agent *(no archive; from workspace)*
**Added (backend):** `agents/conversationalAgent.js`, `services/chatService.js`,
`routes/chat.js`, `tests/{conversationalAgent,chatService,chatRouteContract}.test.js`
**Added (frontend):** `chat/{ChatContext,ChatWindow,ChatMessage,EligibilityVerdict}.jsx`,
`pages/Assistant.jsx`
**Modified:** `app.js` (mount `chatRouter`), `App.jsx` (`/assistant` behind
`ProtectedRoute`)
**Preserved:** the verdict is computed **before** the model runs, copied from the
matcher, and contradicting prose is discarded at output.

### O — Research evaluation *(no archive; from workspace)*
**Added:** `evaluation/{metrics,questionSet,harness,staleAnswerExperiment}.js`,
`scripts/runEvaluation.js`, `tests/evaluation.test.js`
**Modified:** `services/chatService.js` — **three real defects**: `hit.reasons`
never existed (ranking reasons were permanently empty); missing `isActive` gate
(a closed scheme could take a rank); missing `documentReadiness` (chat could
order schemes differently from `GET /recommendations`).
`services/recommendationPropagation.js` exports `isActive` so chat imports
rather than copies it.

### P — Adversarial guard evaluation *(no archive; from workspace)*
**Added:** `evaluation/{verdictAgreement,adversarialSet,guardAblation,redact}.js`,
`scripts/runGuardEvaluation.js`, `tests/guardAblation.test.js`,
`docs/P_EVALUATION.md`
**Modified:** `agents/conversationalAgent.js` — `resolveGuards()` + `deps.guards`
(default ON, **no environment path**); grounding-set fix so the scheme's own
thresholds count as evidence.
**Conflict resolved:** that fix corrected a **false positive** — a model
correctly saying "open to students under 25" was rejected as ungrounded. It makes
the guard *more* accurate; a regression test proves invented figures are still
rejected.

### Fixes from YOUR first real Jest run

Your run surfaced two real defects that no offline runner could have found.

**A. Tests were making LIVE Groq/Gemini calls — 157 s and 30 timeouts.**
`pipelineIntegration`, `endToEndK0` and `chatService` mock the models and the
collector but **not** `services/llmClient`, and the real pipeline reaches it
through `eligibilityExtractor` and `schemeVerifier`. With a real API key in your
environment the suite was spending quota and depending on network weather —
results that are not repeatable and prove nothing.

Fixed with `backend/jest.setup.js` (`setupFiles`), which clears the provider
credentials, `MONGODB_URI` and SMTP for the test process, and sets a fake
JWT secret. **This is environment isolation, not mocking:** no module is
replaced and no assertion changes. With no key, `llmClient` throws before
opening a socket, `generateStructured` returns `null`, and callers take their
documented rules-only path — real production behaviour. 39 tests inject their
own `llm` stub through `deps` and are unaffected; **0 tests read a provider
key**. Escape hatch: `ALLOW_REAL_LLM_IN_TESTS=1`.

**B. `llmClient` called `fetch()` with no timeout — a production defect.**
A provider that accepts the connection then stalls would block forever, and the
callers are the scheduled collection cycle and the chat request. Now bounded by
`LLM_TIMEOUT_MS` (default 30 s) via `AbortSignal.timeout`. On timeout the call
rejects, `generateStructured` returns `null`, and every caller takes the path it
already handles — this changes how long failure takes, never what it means.

**C. `tests/api.test.js` was written against the pre-K0 API** (CATEGORY F —
intentional contract migration). It had never executed before, because
`supertest` could not be installed here.

- `POST /api/users` returned 404: the anonymous upsert-by-email route was
  **removed in K0**, replaced by `POST /api/auth/register` and
  `PUT /api/users/me`. Before removal, anyone could overwrite anyone's profile.
- `/api/users/:email/*` returned 401: **K0 added authentication**, and the tests
  sent no token.

**The production API was not weakened to make these pass.** The tests were
re-pointed at the secure contract: they now sign a real JWT for the account
being requested. The old coverage is preserved rather than deleted, and four
new security tests were added — no token → 401, invalid token → 401, another
user's data → **403 not 404** (a 404 would leak whether the account exists),
and admin override.

### Phase M RAG escaped the integration suite's model boundary (CATEGORY E — production defect)

Your focused run with `--detectOpenHandles` gave the real stack:
`pipeline.js:205 → policyPipeline.js:309/370 → ragIndexer.js:240 → model.create(doc)`,
then *"import after the Jest environment has been torn down"*.

**Root cause, exactly.** `indexScheme()` has always accepted `deps.model`, but
`policyPipeline` invoked it as `indexSchemeSafely(ragIndex, { scheme,
changeType })` — **no `deps` at all** — so it fell back to the real Mongoose
`SchemeChunk`. `pipeline.js` also passed no deps to the policy stage, and
neither integration suite mocked `SchemeChunk` (they mock four models; this was
the fifth). With no connection mongoose does **not** throw: it BUFFERS
`create()` for `bufferTimeoutMS` (10 s default). The promise never settled
inside the 5 s test timeout, so it surfaced as a timeout; after teardown the
buffered call resumed and threw the import error. **The timeout was the
symptom; the escaped model was the cause.**

**Why miniJest never caught it:** the sandbox `mongoose` stub resolves
`create()` immediately. Real mongoose buffers. The stub masked a genuine
defect — recorded here because it is exactly the failure mode the stub README
warns about.

**Fixed (3 files):**
- `src/services/policyPipeline.js` — accepts `deps.ragChunkModel` and forwards
  it as `deps: { model }` **only when injected**. Absent (production, and every
  existing caller) `indexScheme` uses the real model exactly as before.
- `src/services/pipeline.js` — forwards `deps.ragChunkModel` to the policy
  stage. Passed explicitly, not by spreading the cycle deps, so an unrelated
  cycle dep can never reach an agent.
- `tests/helpers/inMemoryDb.js` — `makeDb()` gains a `SchemeChunk` collection
  with the real unique index on `chunkId`, plus `CHUNK_STATUS` (both
  `ragIndexer` and `ragRetriever` destructure it at import; without it the
  mocked module yields `undefined` and throws on first use).
- `tests/pipelineIntegration.test.js`, `tests/endToEndK0.test.js` — mock
  `../src/models/SchemeChunk` alongside the other four.

**Production behaviour is unchanged**: no injected model means the real model,
which is what the server, the scheduler and the retry script all do.

**8 tests added; 3 mutants introduced, 3 killed:**

| Mutant | Result |
|---|---|
| Remove the `SchemeChunk` mock (indexer escapes) | killed — 3 tests |
| `policyPipeline` stops forwarding `ragChunkModel` | killed — 1 test |
| `pipeline.js` stops forwarding the dep | **survived at first** → a test was added so the seam is load-bearing; now killed |

That third one mattered: the forwarding in `pipeline.js` was initially dead
code, passing only because the suite injects via `jest.mock`. A test that
injects through `runCollectionCycle` with a *distinct* collection now proves
chunks reach the injected model and not the mocked default.

**Also fixed:** `.env.example` documents `LLM_TIMEOUT_MS`.

### Post-merge fixes (this rebuild)
1. **Frontend path in `tests/{apiContract,chatRouteContract}.test.js`** —
   resolved `frontend/frontend/src` (sandbox layout). In the real layout both
   suites gate on `describe.skip`, so **41 tests silently vanished while the run
   reported green**. Fixed to `../../frontend/src`, and a `repository layout`
   test added **outside** the skip guard so it can never hide again. Verified by
   reverting: `apiContract` drops 21 → 1 passing.
2. **`src/utils/logger.js` made test-aware** — Console silenced and File
   transports omitted under `NODE_ENV=test`. The suite exercises failure paths
   deliberately, and the noise buried the result. No test asserts on, spies on,
   or mocks the logger (verified by grep), so no assertion is affected.
   `TEST_LOGS=1` restores output.
3. **`package-lock.json` restored** from your original ZIP.

## 2a. PHASE-BY-PHASE — Q, R, S, T, U, V, W, X, Y (built directly in this tree)

These four were not reconstructed from archives; there are none. Each was
implemented into this same cumulative project. **Deletions: none.**

### Q — Propagation soundness *(inferred; no spec existed)*
**Added:** `evaluation/{propagationCorpus,propagationOracle,propagationHarness,propagationMetrics,queryEvaluator}.js`,
`scripts/runPropagationEvaluation.js`, `tests/propagationEvaluation.test.js`,
`docs/{PHASE_Q_REPORT,Q_EVALUATION}.md`
**Modified:** `package.json` (`evaluate:propagation`, `evaluate:propagation:live`)
**Question:** can the Impact Agent's targeted candidate band miss a user whose
eligibility genuinely moved? Ground truth is the SAME agent with the filter
discarded, so the candidate query is the only variable.
**Measured (SYNTHETIC corpus):** 0 unsound cases, 0 users missed, recall
**100% (1089/1089)**, scan reduction **75.3% (1808/2400)** over 10 banded cases.
**Defect found — in the harness:** the first oracle went blind when the query
classified as `none`, scoring a select-nobody bug as SOUND. Fixed; the oracle's
denominator is now stable under mutation.

### R — Notification cost *(specified in `NOTIFICATION_ARCHITECTURE.md`)*
**Added:** `evaluation/{notificationCostExperiment,notificationCostMetrics}.js`,
`scripts/runNotificationCostEvaluation.js`, `tests/notificationCost.test.js`,
`docs/PHASE_R_REPORT.md`
**Modified:** `services/notifier.js` (`deps` seam — additive, defaults to the
real models), `services/policyPipeline.js` (`notificationDurationMs`),
`evaluation/propagationCorpus.js` (two cases), `package.json`
**R.1 measured (SYNTHETIC):** 36.5% fewer interruptions (627/1716) than the
legacy full-scan notifier — and **570 users the legacy path could not reach**,
because its filter is `isMatch(user, schemeAfter)` and anyone who just LOST
eligibility fails it.
**R.2: NOT MEASURED** — instrumentation exists; no cycle recorded it.
**Defects found:** the legacy notifier had no injection seam; the notification
stage had no clock; two corpus cases declared `constrained` with no constraints.

### S — Staleness bound *(inferred; no spec existed)*
**Added:** `evaluation/stalenessBound.js`, `scripts/runStalenessAnalysis.js`,
`tests/stalenessBound.test.js`, `docs/PHASE_S_REPORT.md`
**Modified:** `scheduler/cron.js` (**fourth job in the SAME scheduler**),
`.env.example` (`POLICY_RETRY_CRON`, `POLICY_RETRY_LIMIT`), `package.json`,
`tests/ragPipeline.test.js` (two assertions rescoped — see PHASE_S_REPORT §7)
**Defect found — production:** `retryFailedPolicyProcessing` had existed since
Phase J, tested and documented, and was **scheduled by nothing**. A transient
policy-stage failure left affected users holding an invalidated recommendation
with **no bound on how long**. Fixed by scheduling it hourly.
**Result:** UNBOUNDED → **BOUNDED**. Worst-case correction window **25 h,
DERIVED** from cron intervals — explicitly not a measurement.

### T — Ranking order-invariance *(inferred; no spec existed)*
**Added:** `evaluation/rankingStability.js`,
`scripts/runRankingStabilityAnalysis.js`, `tests/rankingStability.test.js`,
`docs/PHASE_T_REPORT.md`
**Modified:** `services/relevanceRanker.js` (final `schemeId` tie-break),
`package.json` (`evaluate:ranking`), `README.md`, this file
**Defect found — production:** the ranking comparator had only two keys, so two
schemes tying on both fell through to the order `Scheme.find()` returned them
in. A swap produced `RANK_DECREASED` → a "moved down your recommendations"
email and a RecommendationHistory row, **for a change that never happened**.
**Measured (SYNTHETIC):** **STABLE** — 40 users × 24 permutations = 960
rankings, 0 unstable, 0 non-total orders; 40/40 users have tie groups (largest
13), so the tie-break is genuinely exercised. Before the fix: UNSTABLE, 40/40
users, 24/24 permutations.

### U — Independent matcher verification *(inferred; no spec existed)*
**Added:** `evaluation/{eligibilityReference,matcherAgreement}.js`,
`scripts/runMatcherAgreement.js`, `tests/matcherAgreement.test.js`,
`docs/PHASE_U_REPORT.md`
**Modified:** `package.json` (`evaluate:matcher`), `README.md`, this file.
**No production code changed.**
**Gap closed:** every harness through T computed ground truth WITH the
production matcher, so a matcher defect moved prediction and truth together.
Demonstrated: two serious matcher mutations left Q **SOUND**, R **MEASURED**,
S **BOUNDED** and T **STABLE**.
**Measured:** 14,580 profiles × 21 scheme shapes = **306,180 verdicts, 0
disagreements** (115,182 eligible / 190,998 ineligible — a non-vacuous mix).
**Mutation:** 6 matcher mutations, all detected by U; U-M4 survived first pass
(the unknown-type scheme had no satisfiable rules) and was killed after the
scheme set was strengthened.

### V — Change-detection completeness *(inferred; no spec existed)*
**Added:** `evaluation/{detectionOracle,detectionCompleteness}.js`,
`scripts/runDetectionCompleteness.js`, `tests/detectionCompleteness.test.js`,
`docs/PHASE_V_REPORT.md`
**Modified:** `normalizer/normalizer.js`, `agents/policyChangeAgent.js`,
`agents/policyImpactAgent.js`, `package.json` (`evaluate:detection`),
`README.md`, `RUN_FINAL.md`, this file, and the phase-chain line in the ten
historical reports.
**Gap closed:** Q, R, S, T and U all begin AFTER a change is detected, so a
detection miss is invisible to every one of them — `reconcile()` returning
NO_CHANGE produces no artefact for a downstream harness to examine.
**Defect found and fixed:** `eligibilityRules.eligibilityType` — the field
`matcher.js` branches on before reading any rule — was absent from
`ELIGIBILITY_RULE_FIELDS`, which drives both the contentHash and the field diff.
A scheme reclassified between unknown/constrained/universal flipped every user's
verdict while `reconcile()` returned NO_CHANGE on the hash gate. Measured with
the defect present: Q **SOUND**, R **MEASURED**, S **BOUNDED**, T **STABLE**,
U **AGREE**, suite **886/886**.
**Measured:** 4 base shapes × 30 document fields = **196 single-field
mutations**, 65 material over a 1,152-profile population; **0 missed, 0
misclassified, 0 unsound bands** — status COMPLETE. Oracle cross-check 451,584
verdicts, 0 divergent.
**Migration:** the widened hash rewrites every stored contentHash once, silently
— `reconcile()`'s no-diff branch stores the new hash without bumping a version.
No backfill.
**Mutation:** 10 mutations (6 production, 4 of the evaluator itself), all killed
on the first pass.

### W — Public response-surface confinement *(inferred; no spec existed)*
**Added:** `services/publicProjection.js`, `evaluation/responseSurface.js`,
`scripts/runResponseSurfaceAudit.js`, `tests/responseSurface.test.js`,
`docs/PHASE_W_REPORT.md`
**Modified:** `routes/schemes.js`, `package.json` (`evaluate:exposure`),
`README.md`, `RUN_FINAL.md`, this file, and the phase-chain line in the eleven
historical reports.
**Gap closed:** every evaluation phase from O to V measures a FUNCTION — what
production code returns to other production code. None of them looks at what is
serialized to a caller, so a field can be correct, exhaustively verified, and
still published to someone who should never see it.
**Defect found and fixed:** four unauthenticated endpoints answered with
`res.json(rawMongooseDocument)`. Harmless when written; then Phase J added the
policy-stage statuses, the retry flag and `policyProcessing`, and Phase M added
the RAG index statuses and `ragIndexing` — so each new internal field joined the
public response with no change at the boundary. Leaked to anonymous callers:
internal ids, retry flags, job ids, `contentHash`, extraction confidence, and
`policyProcessing.errors` / `ragIndexing.errors`, which carry LLM and embedding
**provider error strings** (a Google project number, an internal IP). Worst
single field: `affectedUserCount` — how many platform users a policy change
moved, published per scheme without an account. Measured with the defect
present: O–V all pass, suite **923/923**.
**Measured:** before **EXPOSED, 50 internal fields across 4 endpoints**; after
**CONFINED — 0 leaks, 0 missing, 0 undeclared, 0 unprojected**.
**Method:** three inputs, none of them the projection under test — the field
universe from the Mongoose schema definitions, the INTERNAL/PUBLIC
classification from a declared policy table written from the model files' own
comments, and the required fields parsed from the FRONTEND source. Three
properties: confinement, sufficiency, and wiring (a projection can be correct
and simply not be called).
**Frontend:** unchanged — the projection was built against what the components
actually read, and the sufficiency property asserts it.
**Mutation:** 15 mutations (7 production, 8 of the evaluator). Three survived
the first pass — an emptied-but-present field, `every` weakened to `some` in the
wiring check, and the emptied-field branch itself being unreachable. All three
were real weaknesses; the auditor was strengthened (deeper sufficiency, an
extracted predicate, a DI seam for injecting a broken projection) and all 15 are
now killed.

### X — Cross-surface recommendation agreement *(inferred; no spec existed)*
**Added:** `evaluation/{surfaceAgreement,surfaceCorpus}.js`,
`scripts/runSurfaceAgreement.js`, `tests/surfaceAgreement.test.js`,
`docs/PHASE_X_REPORT.md`
**Modified:** `services/recommendationPropagation.js` (the shared
`buildCandidates`), `services/chatService.js`, `routes/users.js`,
`package.json` (`evaluate:surfaces`), `README.md`, `RUN_FINAL.md`, this file,
and the phase-chain line in the thirteen historical reports.
**Gap closed:** every phase from Q to W verifies ONE mechanism. The user is told
their recommendations by THREE paths — the matches page, the chat assistant, and
the propagation pass behind the audit trail and the emails — and each assembled
its own candidate list. Phase T is the near miss: it proves the ranker is a
function of its inputs, never that the three callers hand it the same inputs.
**Defect found and fixed (live):** `computeRecommendationState` built
`{scheme, verdict}` while the other two surfaces built
`{scheme, verdict, documentReadiness}`. The ranker's readiness term (0 .. 1.5)
was therefore silently zero in the propagation pass — a missing scoring input is
not an error, it contributes nothing — so `RecommendationHistory` and the
rank-change notifications were computed from a different ordering than the page
and the assistant showed. Reproduced: two schemes tie at 3.5, the Phase T
tie-break correctly orders them alphabetically, and the scheme the user cannot
apply for is recorded at rank 1. Measured with the defect present on the
pristine H→W tree: O–W all pass, suite **957/957**.
**Two latent divergences also fixed:** `/matches` gated status with an exact
`status: "Active"` equality while both other surfaces use the shared `isActive`
(which also accepts "active" and a blank status) — a third copy of a rule whose
own file says two copies would drift; and `/matches/stats`, the endpoint that
exists to explain the matches count, counted a different universe than
`/matches` ranked.
**Fix:** one `buildCandidates` in the file that already owns `isActive`, called
by all three surfaces; the `/matches` database filter reduced to a cheap indexed
superset (`$ne: "Closed"`) with the shared gate deciding.
**Measured:** before **DISAGREE** (24 disagreements — 20 SHAPE, 4 ORDER); after
**AGREE** across 24 comparisons, 4 of them decided by the readiness term.
**Frontend:** unchanged — the `/matches` response contract is identical.
**Mutation:** 12 mutations (6 production, 6 of the evaluator), all killed. X-M1
— the original defect, reintroduced into the shared builder — survived the
harness on the first pass and is the finding worth keeping: once all three
surfaces share one builder they break together and go on agreeing, so
differential testing alone reported AGREE. Fixed by anchoring SHAPE to the
ranker's documented candidate contract as well as to the other surfaces.

### Y — The index contract, made executable *(inferred; no spec existed)*
**Added:** `evaluation/indexContract.js`, `scripts/runIndexContract.js`,
`tests/indexContract.test.js`, `docs/PHASE_Y_REPORT.md`
**Modified:** `INDEX_VERIFICATION.md` (regenerated from the schemas),
`package.json` (`evaluate:indexes`, `evaluate:indexes:live`), `README.md`,
`RUN_FINAL.md`, this file, and the phase-chain line in the fourteen historical
reports. **No production code path changed.**
**Gap closed:** four production paths treat a duplicate-key error as "already
done" — the in-app notification writer, the email notifier, the propagation pass
and the RAG indexer. Each is exactly-once ONLY because a unique index rejects
the second insert, and the services say so explicitly. That guarantee does not
live in the code, so no test in this repository can exercise it: Mongoose's
`unique: true` is a request, indexes build lazily, `autoIndex` is often off in
production, and a unique build over existing duplicates fails silently leaving
no constraint at all.
**Defect found and fixed:** `INDEX_VERIFICATION.md` — the only control on
whether those constraints exist — had drifted from the schemas. It listed **8**
indexes; the models declare **47**. Three of the six UNIQUE indexes were absent
entirely: `notifications.uniq_user_scheme_change_channel` (the whole
exactly-once guarantee for the Phase L inbox), `schemechunks.chunkId_1` (a
re-index not duplicating every chunk) and `schemes.schemeId_1`. The documented
mongosh procedure inspected four of seven collections. An operator following the
page would have verified the wrong set and reported success. Measured with the
defect present on the pristine H→X tree: O–X all pass, suite **981/981**.
**Fix:** the contract is now executable. `evaluate:indexes` compares three
inputs — declared (the schemas), documented (the checklist) and required (the
production code that catches E11000) — and asserts three properties: every
declared index is documented, every uniqueness the code depends on is declared
unique, and (with `--live`) the cluster actually has them. `INDEX_VERIFICATION.md`
was regenerated from the schemas, its procedure extended to all seven
collections, and its "what to check" step now names all six unique indexes.
**Independence:** the *required* input is read from the code that DEPENDS on a
constraint, not from the code that DECLARES one — so removing `unique: true`
from a schema and from the checklist together still fails.
**Measured:** before **INCONSISTENT — 39 undocumented, 3 of 6 unique omitted**;
after **CONSISTENT — 47/47 documented, 4/4 dependencies backed**.
**NOT MEASURED:** whether any index exists on a real cluster. Y.3 needs
`MONGODB_URI`; it reports NOT MEASURED with the exact reason and is never
reported as passing.
**Mutation:** 14 mutations (6 production, 8 of the evaluator), all killed. Y-M10
survived the first pass on an unreachable branch — the third consecutive phase
to hit that shape (W-M15, X-M1) — and was killed by adding an injection seam.
Y-M14 initially appeared to survive and was an INVALID mutation that evaluated
to the original array; rewritten and killed. Both recorded rather than quietly
replaced.

---

## 3. API CONTRACT

**20 routes. 0 orphan frontend calls. Every personal-data route authenticated.**

| METHOD | ROUTE | AUTH |
|---|---|---|
| POST | `/api/auth/register` | public by design |
| POST | `/api/auth/login` | public by design |
| GET | `/api/auth/me` | YES |
| POST | `/api/chat` | YES |
| GET | `/api/chat/suggestions` | YES |
| GET | `/api/schemes`, `/api/schemes/:id`, `/api/schemes/:id/history`, `/api/schemes/meta/filters`, `/api/updates/recent` | public by design (browsing needs no account) |
| POST | `/api/collect/run` | **YES + ADMIN** |
| PUT | `/api/users/me` | YES |
| GET | `/api/users/me/recommendation-history` | YES |
| GET | `/api/users/me/notifications` | YES |
| POST | `/api/users/me/notifications/:id/read` | YES |
| POST | `/api/users/me/notifications/read-all` | YES |
| GET | `/api/users/:email` | **YES + ownership** |
| GET | `/api/users/:email/matches` | **YES + ownership** |
| GET | `/api/users/:email/matches/stats` | **YES + ownership** |
| GET | `/api/users/:email/why/:schemeId` | **YES + ownership** |

Frontend consumers: `AuthContext` (register/login/me/profile), `MyMatches`,
`History`, `NotificationContext` (list/read/read-all), `ChatContext` +
`ChatWindow`, `Browse`, `SchemeDetail`, `Admin`.

**Audit note, recorded because it nearly became a false report:** my first pass
flagged `/api/users/:email*` as unauthenticated and 5 scheme routes as orphans.
Both were regex artefacts — those routes use a spread `...ownData`
(`[requireAuth, requireSelfOrAdmin("email")]`), and the scheme routes use plain
async handlers rather than `asyncHandler`. Verified against source before
reporting. **No authentication was weakened anywhere.**

## 4. NOT MERGED, AND WHY

| Item | Reason |
|---|---|
| `backend/.env` | Live Atlas / Gemini / SMTP credentials. `.env.example` ships instead. **Rotate them** — exposed during development, not rotated. |
| `node_modules/` | The sandbox held **hand-written stubs** for mongoose, winston, bcryptjs, jsonwebtoken, nodemailer. `bcryptjs` throws on every call; `nodemailer` always rejects. Shipping them would override the real packages after `npm install`. |
| `logs/`, `phase-p-review.json` | Runtime/generated output |
| Previous merged ZIPs | Not trusted as input, per your instruction |

## 4a. PHASE CHAIN IN THIS TREE

*Repeats the CURRENT STATE table at the top of this file. If the two ever
disagree, the top table is the one to trust — it is the first thing a reader
sees. They drifted apart once, at Phase U, because an edit matched only this
copy.*

One cumulative project. There are no per-phase folders and nothing to merge.

| Phase | State | Where |
|---|---|---|
| BASE | Complete | collectors, matcher, models, routes |
| H | Complete | `services/comparator.js`, `services/pipeline.js` |
| I | Complete | `agents/policyChangeAgent.js`, `agents/policyImpactAgent.js` |
| J | Complete | `services/recommendationPropagation.js`, `services/policyPipeline.js` |
| K0 | Complete | `middleware/auth.js`, `routes/auth.js`, `config/bootstrapAdmin.js` |
| K | Complete | `agents/explanationAgent.js` |
| L / L.1–L.8 | Complete | `agents/notificationAgent.js`, `services/notificationService.js`, `services/notificationReadService.js`, `models/Notification.js` |
| M | Complete | `services/schemeChunker.js`, `ragIndexer.js`, `ragRetriever.js`, `embeddingService.js`, `models/SchemeChunk.js` |
| N | Complete | `agents/conversationalAgent.js`, `services/chatService.js`, `routes/chat.js` |
| O | Complete — retrieval quality WITHHELD under local-hash | `evaluation/harness.js`, `staleAnswerExperiment.js`, `docs/PHASE_O_REPORT.md` |
| P | Complete — primary metric NOT MEASURED (needs real LLM + human labels) | `evaluation/guardAblation.js`, `docs/P_EVALUATION.md` |
| Q | Complete — propagation soundness MEASURED | `evaluation/propagationOracle.js`, `docs/Q_EVALUATION.md` |
| R | Complete — R.1 MEASURED, R.2 NOT MEASURED | `evaluation/notificationCostExperiment.js`, `docs/PHASE_R_REPORT.md` |
| S | Complete — staleness bound MEASURED as DERIVED; scheduler hole fixed | `evaluation/stalenessBound.js`, `docs/PHASE_S_REPORT.md` |
| T | Complete — ranking order-invariance MEASURED; tie-break defect fixed | `evaluation/rankingStability.js`, `docs/PHASE_T_REPORT.md` |
| U | Complete — independent matcher verification; 306,180 cases AGREE | `evaluation/eligibilityReference.js`, `evaluation/matcherAgreement.js`, `docs/PHASE_U_REPORT.md` |
| V | Complete — change-detection completeness MEASURED; `eligibilityType` detection hole fixed | `evaluation/detectionOracle.js`, `evaluation/detectionCompleteness.js`, `docs/PHASE_V_REPORT.md` |
| W | Complete — public response-surface CONFINED; 50-field anonymous exposure fixed | `services/publicProjection.js`, `evaluation/responseSurface.js`, `docs/PHASE_W_REPORT.md` |
| X | Complete — three recommendation surfaces AGREE; audit trail ranked on incomplete candidates, fixed | `services/recommendationPropagation.js` (`buildCandidates`), `evaluation/surfaceAgreement.js`, `docs/PHASE_X_REPORT.md` |
| Y | Complete — index contract CONSISTENT; the operator checklist covered 8 of 47 indexes, now generated and checked | `evaluation/indexContract.js`, `INDEX_VERIFICATION.md`, `docs/PHASE_Y_REPORT.md` |
| Z+ | Not started | — |

## 5. DEPENDENCIES

**None added or removed.** Verified programmatically — every non-builtin module
reached by `require()`/`import` in `src/`, `scripts/`, `tests/` is declared.

- **Backend used (14):** `@google/generative-ai`, `axios`, `bcryptjs`, `cors`,
  `dotenv`, `express`, `express-rate-limit`, `helmet`, `jsonwebtoken`,
  `mongoose`, `node-cron`, `nodemailer`, `supertest`, `winston`.
  Also declared: `cheerio`, `jest`, `nodemon`.
- **Frontend used (4):** `axios`, `react`, `react-dom`, `react-router-dom`.
  Also declared: `vite`, `@vitejs/plugin-react`, `oxlint`, `@types/react`,
  `@types/react-dom`.

## 6. VALIDATION PERFORMED (current tree, H→Y)

```
BASE preservation          53/53 original files present
files removed since P      0
broken-require scan        0
relative imports           all resolve (checked across backend)
syntax                     all backend .js parse (node --check)
merge markers              0
backend/backend            0     frontend/frontend  0     src/src  0
phase-* folders in ZIP     0
.env / node_modules in ZIP 0 / 0
env-var audit              0 documented-but-unread, 0 read-but-undocumented
route registration         4 routers under /api, 20 routes, every one guarded
frontend routes            9 registered, all imports resolve
miniJest                   1006 passed, 0 failed, 1 suite skipped
verify:agents              73/73 and 136/136
test:boundary              PASS — 0 real-Mongoose operations
demo:policy-change         PASS
evaluate:propagation (Q)   SOUND — 0 missed, 100% recall (1089/1089)
evaluate:notification-cost (R)  MEASURED — 36.5% (627/1716); R.2 NOT MEASURED
evaluate:staleness (S)     BOUNDED — 25 h DERIVED
evaluate:ranking (T)       STABLE — 960 rankings, 0 unstable
evaluate:matcher (U)       AGREE — 306,180 verdicts, 0 disagreements
evaluate:detection (V)     COMPLETE — 196 mutations, 65 material, 0 missed
evaluate:exposure (W)      CONFINED — 4 public surfaces, 0 leaks (50 before the fix)
evaluate:surfaces (X)      AGREE — 3 surfaces, 24 comparisons, 0 disagreements
evaluate:indexes (Y)       CONSISTENT — 47/47 documented, 4/4 dependencies backed;
                           Y.3 (live cluster) NOT MEASURED — no database reachable
evaluate / evaluate:stale (O)   ran; retrieval quality WITHHELD (local-hash)
evaluate:guards (P)        ran offline; guards default ON; no env path
npm install (backend)      FAILED in sandbox — registry HTTP 403 (succeeds locally)
npm install (frontend)     FAILED in sandbox — registry HTTP 403 (succeeds locally)
```

## 7. TEST RESULTS

### REAL JEST — **RUN LOCALLY; never run in the sandbox**

`npm install` fails **in the development sandbox** with HTTP 403 from
`registry.npmjs.org`, for both backend and frontend. Jest cannot be installed
there, so **real Jest has never been executed in that sandbox** — not in the
original rebuild, not at any point since.

**It HAS been executed locally.** The latest verified local result is **24 test
suites passed, 813 tests passed** — though a later report in this project
records **824**, and which is current is unsettled. **No projection is given
from an unsettled baseline.** The measured figure for this tree is the miniJest
one below.

### miniJest — 1006 passed / 0 failed / 1 suite skipped (historical, Phase Y)

`scripts/miniJest.js` is a **hand-written Jest subset**, written because the
registry was unreachable. **It is not Jest and must not be reported as one.**
`api.test.js` is skipped here — `supertest` is uninstallable in this sandbox —
though it does run on your machine.

*This Phase-Y figure came from a sandbox that had hand-written stub
`node_modules` for `mongoose`, `winston`, `bcryptjs`, `jsonwebtoken`, and
`nodemailer` (see "two things are deliberately absent" in the README) —
those stubs let far more suites load, and were never shipped in any zip.*

### miniJest — Phase Z re-run, this tree, no stub node_modules present

```
194 passed, 0 failed, 0 skipped, 26 suite(s) skipped  (≈1.2s)
```

8/34 suites run (pure-logic, no external package); 26 skipped, each with its
missing module named (`mongoose`, `winston`, or `supertest`), never counted
as passing. This is the correct, honest number **for a tree with no
node_modules at all** — real or stubbed — which is what every shipped zip,
including this one, has always contained. Phase Z also finished and
verified miniJest's `automock`, `setupFiles`, and `mockReturnThis` support
(see `docs/PHASE_Z_REPORT.md` §4); this did not change the pass count here
because the only test that exercises them (`api.test.js`) is skipped for an
unrelated reason.

**Real Jest count is still open.** Phase Z's own brief asserted 34/34
suites, 1030/1030 tests as an already-measured fact. That does not match
any number recorded above (813, 824-unsettled) and could not be run or
checked in this environment. Treat it as unverified, not as the current
figure, until someone with npm registry access runs `npm test
-- --runInBand` and reports the real result.

### Frontend build — **NOT RUN IN THE SANDBOX** (`npm install` 403 there, so no `vite build`)

Frontend files were syntax-checked with the TypeScript parser (21 files, 0
errors) and every relative import was resolved, but **no bundle was produced and
no linter ran**.

## 8. EXTERNAL VALIDATION — what the SANDBOX could not perform

*Scope: the development sandbox. Items marked RUN LOCALLY were executed on the
developer's machine and reported back.*

| | |
|---|---|
| Real Jest | **RUN LOCALLY** — 24 suites / 813 tests passed. Never run in the sandbox (npm 403). |
| Frontend build / dev server | **NOT RUN IN THE SANDBOX** — npm 403. Reported building locally. |
| Browser | **NOT RUN** |
| MongoDB | **NOT RUN IN THE SANDBOX** — all sandbox tests use `tests/helpers/inMemoryDb.js`. Reported connected locally against Atlas. |
| Atlas `$vectorSearch` | **NOT VERIFIED — REQUIRES ATLAS VECTOR SEARCH.** `atlasSearch()` is implemented and has never executed; default strategy is `scan`. |
| Gemini / Groq / Ollama | **NOT RUN** — every LLM in every test is a stub |
| SMTP | **NOT RUN** |

**Phase O/P research integrity:** the stale-answer result (0/5 vs 5/5) is
**SYNTHETIC** — 5 constructed version-pairs under the **lexical** `local-hash`
provider — and ships with a scope paragraph stating so. Phase P's primary
metric reads **REAL LLM RESULT: NOT MEASURED**; its offline figures are labelled
`provider: "stub"` in every output row.
