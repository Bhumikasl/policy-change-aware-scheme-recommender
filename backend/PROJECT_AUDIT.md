# PROJECT_AUDIT.md

> **Historical document.** This is a read-only audit of the PRE-PHASE-H
> bundles named below (`backendfixed_14.zip` / `frontendfixed_4.zip`), taken
> on the date shown. It describes that bundle, **not** the current tree,
> which runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q →
> R → S → T → U → V → W → X → Y** — see `../../MERGE_MANIFEST.md`. Its "never executed" and
> test-count statements were true of that bundle and have since been
> superseded: real Jest has been run locally (24 suites, 813 tests passed).

**System:** Dynamic Policy-Aware Government Scheme Monitoring and Personalized Recommendation System
**Audited bundles:** `backendfixed_14.zip`, `frontendfixed_4.zip`
**Audit date:** 2026-08-26
**Scope:** Read-only audit. No source files were modified.

---

## 0. Evidence standard used in this document

Every claim below is tagged with how it was established. This matters because
the sandbox used for the audit **cannot install npm packages** (the registry is
blocked), so the full Jest suite could not be executed here.

| Tag | Meaning |
|---|---|
| `[VERIFIED]` | I executed code and observed the result. Output quoted. |
| `[STATIC]` | Established by reading/grepping the source. Not executed. |
| `[REPORTED]` | From your terminal output earlier in this project. Not re-run by me. |
| `[UNVERIFIED]` | Stated in code comments/docs but not confirmed by execution. |

**What I actually ran:** a smoke harness against the *pure* modules
(`deterministicExtractor`, `matcher`, `normalizer`, `comparator`,
`relevanceRanker`) with `mongoose`/`winston` stubbed.
Result: **12 passed, 1 failed** — the failure is finding **C-1** below.

**What I did NOT run:** `npm test` (Jest), the Express app, MongoDB, any LLM
provider, the frontend build. The last full suite run is **yours**: 129/129
passing `[REPORTED]`, before the v4 additions. Static count of the current tree
is **152 `test(` blocks across 9 files** `[STATIC]` — the 23 new ones
(`relevanceRanker.test.js` ×18, `api.test.js` ×5) have **never been executed by
anyone**. Treat them as unproven until you run `npm test`.

---

## 1. Current architecture (as built)

```
                    myScheme public API (api.myscheme.gov.in)
                                  |
                                  v
                   collectors/mySchemeCollector.js
                   - search endpoint -> slugs (paginated)
                   - detail endpoint -> per-slug content
                   - documents endpoint -> per-_id doc list
                   - retry/backoff/jitter/Retry-After, concurrency 4
                                  |
                                  v
                   services/pipeline.js :: runCollectionCycle()
                                  |
                    +-------------+--------------+
                    v                            v
        maybeEnrichWithHybrid()          normalizer/normalizer.js
        - deterministicExtractor         - clean() whitespace
        - hybridExtractor (det + LLM)    - canonical field set
        - LLM via llmClient adapter      - SHA-256 over COMPARABLE_FIELDS
          (groq | gemini | ollama)                |
                                                  v
                                    services/comparator.js :: reconcile()
                                    - hash equal    -> NO_CHANGE
                                    - hash differs  -> diffFields()
                                    - version++ , SchemeHistory append
                                                  |
                                                  v
                                    services/aiSummary.js (LLM prose blob)
                                                  |
                                                  v
                                    services/notifier.js
                                    :: notifyMatchingUsers()
                                    - User.find({})          <-- FULL SCAN
                                    - filter(isMatch)        <-- "eligible NOW"
                                    - NotificationLog dedup (email,scheme,ver)
                                    - mailer.js (SMTP)
                                                  |
                                                  v
                                               USER EMAIL

    ---- separate, request-time path (no connection to the above) ----

    GET /api/users/:email/matches
        [1] eligibility gate   services/matcher.js
        [2] relevance ranking  services/relevanceRanker.js  (BM25-lite)
        [3] truncate to ?limit
        [4] LLM verify top-K   services/schemeVerifier.js + schemeChunker.js
        -> ranked Top-K + matchExplanation
```

**The structural problem is visible in that diagram:** the change-detection
path (top) and the recommendation path (bottom) **never meet**. A scheme
version bump does not re-rank anybody. That gap *is* the research contribution
and it is not yet built. See §5.

### Tech stack `[STATIC]`

| Layer | Technology |
|---|---|
| Frontend | React 18, Vite, React Router, Axios |
| Backend | Node.js, Express 4, CommonJS |
| Database | MongoDB Atlas, Mongoose 8 |
| Scheduler | node-cron |
| LLM | Provider-adapter: Groq (default) / Gemini / Ollama |
| Email | Nodemailer (Gmail SMTP) |
| Tests | Jest 29 + Supertest |
| Logging | Winston |

### Codebase size `[VERIFIED]`

41 JS files, 5,537 lines (32 source, 9 test).
Largest: `mySchemeCollector.js` 409, `relevanceRanker.js` 393,
`deterministicExtractor.js` 410, `backfillEligibility.js` 301,
`schemeVerifier.js` 297, `matcher.js` 292, `users.js` 281.

---

## 2. What genuinely works

| Capability | Evidence |
|---|---|
| Strict eligibility gate (AND-of-OR categories) | `[VERIFIED]` plain Student rejected by PwD-student scheme; SC user accepted by SC/ST/OBC scheme |
| "650-matches" regression fix | `[VERIFIED]` zero-constraint constrained scheme does not match |
| Age hard-fail | `[VERIFIED]` age 75 vs `maxAge:50` → `eligible:false`, `failed:[{rule:"age"}]` |
| SHA-256 hash stability | `[VERIFIED]` metadata-only change (confidence, extractedAt) → identical `contentHash` |
| Field-level diff | `[VERIFIED]` income 250000→300000 emits `eligibilityRules.maxAnnualIncome` |
| Deterministic extraction (age/income/category groups) | `[VERIFIED]` "3 lakh"→300000; "SC/ST/OBC"→1 OR-group; "PwD students from OBC"→2 AND-groups |
| Relevance ranking | `[VERIFIED]` scholarship 10.41 > savings 2.00 for a Student profile |
| Stated intent overrides inferred profile | `[VERIFIED]` `intent="business loan"` flips loan above scholarship |
| Collector resilience | `[STATIC]` `requestWithRetry`, exponential backoff, jitter, `Retry-After`, concurrency cap 4, `MYSCHEME_LIMIT` |
| LLM provider abstraction + circuit breaker | `[STATIC]` groq/gemini/ollama adapters; quota/404 trips `disabledForRun` |
| Verifier cannot promote a rules-rejection | `[STATIC]` `decideRecommendation` returns early on `!rulesVerdict.eligible` |
| Notification dedup | `[REPORTED]` your run showed "Dedup: skipped 1 already-notified user" |
| End-to-end email delivery | `[REPORTED]` your run delivered 2 emails to a real inbox |

---

## 3. CRITICAL — Security

### S-1. Live credentials are inside the shipped zip `[VERIFIED]` — SEVERITY: CRITICAL

```
$ unzip -l backendfixed_14.zip | grep .env
      541  backend/.env          <-- REAL SECRETS
     1934  backend/.env.example
```

`backend/.env` contains live values for: `MONGODB_URI` (with password),
`MYSCHEME_API_KEY`, `GEMINI_API_KEY`, `SMTP_USER`, `SMTP_APP_PASSWORD`.

**This is my error** — every bundle I shipped you included your `.env`.

### S-2. MongoDB URI (with password) is logged in plaintext `[VERIFIED]`

`src/config/db.js:8`
```js
logger.info(`MongoDB connected -> ${uri}`);
```
This is why your Atlas password appeared in every terminal paste in this
project, and it is written to `logs/` on disk.

### S-3. Credentials are already burned `[VERIFIED from your own pasted output]`

Visible in this conversation's transcript and screenshots:
Atlas user + password, Groq API key (`gsk_…`), Gemini API key (`AQ.Ab8RN6…`).

**These must be rotated regardless of any code change.** Rotation list in §7.

### S-4. Zero authentication on every route `[VERIFIED]`

All 11 routes are public. The two that matter most:

| Route | Risk |
|---|---|
| `POST /api/collect/run` | Unauthenticated. Anyone can trigger a full ~4,700-scheme collection → DoS on your Atlas free tier, burns myScheme quota, burns LLM quota. |
| `GET /api/users/:email` | **IDOR.** Any email guess returns that user's full profile: state, gender, age, income, caste categories, education, `idLast4`. |
| `GET /api/users/:email/matches` | Same IDOR; also triggers LLM spend per request. |

Caste category, income and age are sensitive personal data under India's DPDP
Act. This is the most serious functional risk in the project.

### S-5. Wide-open CORS `[VERIFIED]` — `app.js:8` is bare `app.use(cors())`.

### S-6. No `helmet`, no rate limiting, no request-size cap `[VERIFIED]`

### S-7. No Express error middleware `[VERIFIED]`

No 4-arg `app.use((err, req, res, next))` anywhere. `routes/schemes.js` has
6 routes and **1** try-block; `routes/users.js` has 5 routes and 3.
An async throw in an unguarded route → unhandled rejection → process-level
crash risk, and leaks stack traces.

---

## 4. CRITICAL — Correctness regressions in the shipped bundle

### C-1. `backendfixed_14.zip` is MISSING two extractor fixes you validated locally `[VERIFIED]`

I gave you both as copy-paste snippets and **never applied them to my own
working tree**, then built v14 from that tree. Both are absent:

**(a) Tenure-vs-age guard — ABSENT**
```
"at least 20 years of experience, be minimum 50 years of age"
   -> minAge = 20    (WRONG — 20 is years of experience, not an age)
```
This is the National Metallurgist / Dronacharya / President's Medal false-positive
class you found.

**(b) Ministry-typo age range — ABSENT**
```
"not less than 18 years and more than 50 years"
   -> minAge = 18, maxAge = null   (WRONG — maxAge should be 50)
```
This is the Biponi Scheme bug. My earlier grep reported this as "PRESENT" —
that was a **false positive**: the string `not less than` also appears inside
the unrelated `min` regex on line 20 of `extractAge`. Executing the function
proves it does not fire.

> **Do not unzip v14 over your working directory.** You will silently lose both
> fixes. Your local copy is currently *ahead* of the bundle. First action in
> Phase B is to reconcile this — I will diff your local `deterministicExtractor.js`
> against the bundle before touching anything else.

### C-2. `.env.example` documents variable names the code does not read `[VERIFIED]`

| `.env.example` says | Code actually reads | Result if you follow the example |
|---|---|---|
| `MONGO_URI` | `MONGODB_URI` | **DB connection silently falls back to `localhost`** |
| `SMTP_PASS` | `SMTP_APP_PASSWORD` | Email auth fails |
| `SMTP_HOST`, `SMTP_PORT`, `FROM_EMAIL` | *(never read)* | Misleading |

Also **read by code but undocumented**: `BATCH_SIZE`, `DEFAULT_MATCH_LIMIT`,
`LLM_ESCALATE_BELOW`, `LOG_LEVEL`, `OLLAMA_VERIFIER_MODEL`, `RUN_ON_STARTUP`,
`SCHEMES_TO_EXTRACT`.

A new machine following `.env.example` gets a broken install. My error.

---

## 5. THE RESEARCH GAP — policy-change propagation does not exist

This is the honest headline of the audit. Your stated contribution is
*"policy change → user impact → eligibility change → recommendation change"*.
**Only the first arrow is implemented.**

### What `notifyMatchingUsers()` actually does `[VERIFIED by reading src/services/notifier.js]`

```js
const users = await User.find({});                 // (1) full collection scan
const matched = users.filter(u => isMatch(u, scheme));  // (2) "eligible NOW"
// (3) email everyone in `matched`
```

### Gap-by-gap

| # | Gap | Consequence |
|---|---|---|
| R-1 | **No before/after comparison.** Only "is eligible now" is computed. Prior eligibility is never loaded. | The system **cannot distinguish "newly eligible" from "was already eligible"**. Every user eligible after the change is emailed, including those for whom nothing changed. The core research claim is unmeasurable. |
| R-2 | **No targeted user lookup.** `User.find({})` loads every user for every changed scheme. | O(users × changed schemes). With 39 changed schemes in one of your runs, that is 39 full scans. The reviewer's `250000 < income <= 300000` narrowing is entirely absent. |
| R-3 | **No `RecommendationHistory` model.** | No transition record; nothing for the frontend to display; nothing to evaluate Precision/Recall of propagation against. |
| R-4 | **No structured change classification.** `aiSummary` is a free-text blob. | A description punctuation fix and an income-threshold change are treated identically. No `severity`, no `changeType`, no `eligibilityImpact` flag. |
| R-5 | **Notification triggers on eligibility, not on change.** | Wrong trigger semantics for the thesis. |
| R-6 | **Notifier ignores the ranker.** Uses `isMatch` (eligibility only). | Users get emailed about schemes that would never enter their Top-20. |
| R-7 | **No event/job collections.** Pipeline is one synchronous `for` loop. | No replay, no failure isolation per stage, no audit trail. |

`[VERIFIED]` R-1 and R-2 by reading the function; R-3 by `ls src/models/`
(4 models: Scheme, SchemeHistory, User, NotificationLog — no RecommendationHistory).

---

## 6. Other findings

### Data model `[STATIC]`

Canonical fields required by your Phase 2 spec that are **missing** from
`models/Scheme.js`: `sourceId`, `department`, `district`, `applicationProcess`,
`sourceUpdatedAt`, `lastSeenAt`. Present but differently named: `eligibility`
(spec calls it `eligibilityText`), `lastDate` (spec: `deadline`).
`extractionConfidence` exists nested as `eligibilityRules.confidence`.

### Indexes `[VERIFIED]`

Declared: `Scheme.schemeId` (unique), `User.email` (unique),
`SchemeHistory.schemeId`, `NotificationLog.email`, `.schemeId`, and a unique
compound on NotificationLog.

**Missing, given actual query patterns:**

| Query in code | Missing index |
|---|---|
| `Scheme.find({status, "eligibilityRules.eligibilityType"})` (`users.js:88`) | compound `{status:1, "eligibilityRules.eligibilityType":1}` |
| `.sort({lastUpdatedAt:-1})` on every `/matches` call | `lastUpdatedAt: -1` |
| `Scheme.find({state, category})` (`schemes.js`) | `state`, `category` |
| `SchemeHistory.updateOne({schemeId, version})` (`pipeline.js`) | compound `{schemeId:1, version:1}` |

Note: `/matches` currently loads **every active scheme into Node memory** and
filters in JS. At 4,722 active schemes that is the dominant request cost.

### Duplication `[VERIFIED]`

`GENDER_TAGS` / `CATEGORY_TAGS` / `OCCUPATION_TAGS` and the tag→rules mapping
are defined **twice**: `collectors/mySchemeCollector.js:251-283` and
`scripts/backfillEligibility.js:45-66`. They can and will drift.

### Coupling `[VERIFIED]`

`services/comparator.js` is a pure diff function but `require`s
`models/Scheme.js`, which pulls in Mongoose. I had to stub Mongoose just to
unit-test the diff. Pure logic should not import the DB layer.

### Phase-1 ingestion gaps `[VERIFIED]`

Present: retry, backoff, jitter, Retry-After, concurrency, dev limit.
**Absent:** ETag / If-Modified-Since / `sourceUpdatedAt` conditional fetching,
a `SyncRun` collection (success/partial/failed + timings + per-source metrics),
and collector-level checkpointing. Only the *backfill script* checkpoints, not
the collector. Consequence: every cycle refetches all ~4,700 schemes plus 2
follow-up calls each (~14,000 requests) even when nothing changed.

### Not implemented at all `[STATIC]`

Embeddings, vector index, cross-encoder reranking, RAG/Q&A, validation layer +
rejection tracking, data-quality API, admin dashboard, auth, event bus,
evaluation harness, ablation scripts, demo scenario.

`relevanceRanker.js` implements **BM25-lite only** — real BM25 term statistics
over the candidate set, but no dense retrieval and no cross-encoder. The
docstring is accurate about this; no overclaim found.

### Dead / unwired code `[VERIFIED]`

`src/scripts/analyzeMatches.js` (141 lines) — referenced only by the
`analyze:matches` npm script; not imported anywhere. Candidate for deletion or
promotion into the evaluation harness.

---

## 7. Recommended architecture

Keep the modular monolith. Add an event spine (MongoDB collections, not Kafka)
so the change path and the recommendation path finally connect.

```
 COLLECTOR ──> SyncRun{status,counts,timings}          [NEW]
     |
     v
 NORMALIZER ──> VALIDATOR ──> RejectedRecord{reason}   [NEW]
     |
     v
 Scheme + contentHash ──(differs)──> diffFields()
     |                                    |
     |                                    v
     |                        PolicyChangeAgent         [NEW]
     |                        deterministic first;
     |                        LLM only for ambiguity
     |                        -> {changeType, severity,
     |                            eligibilityImpact, ...}
     |                                    |
     |                                    v
     |                        PolicyImpactAgent          [NEW]
     |                        TARGETED Mongo query from
     |                        the changed attribute
     |                        e.g. income 250k->300k =>
     |                        {profile.annualIncome:
     |                          {$gt:250000,$lte:300000}}
     |                                    |
     |                                    v
     |                        For each affected user:
     |                          eligibility(OLD rules)   <-- from SchemeHistory
     |                          eligibility(NEW rules)
     |                          transition = f(old,new)
     |                                    |
     |                                    v
     |                        RecommendationPropagation  [NEW]
     |                        re-rank; compare Top-K
     |                        -> RecommendationHistory   [NEW MODEL]
     |                                    |
     |                                    v
     |                        ExplanationAgent           [NEW]
     |                        grounded in diff+rules+profile
     |                                    |
     |                                    v
     |                        NotificationAgent          [NEW]
     |                        notify only if transition
     |                        != NO_CHANGE and severity
     |                        warrants it
     v
 (unchanged) ──> bump lastSeenAt only, no downstream work
```

**Key design decision:** `SchemeHistory.snapshot` already stores the **full
normalized doc per version** `[VERIFIED]` — including `eligibilityRules`. That
means old-vs-new eligibility is computable **today** without any schema
migration. This is the single most important enabling fact in the audit: the
research contribution is unblocked by existing data.

---

## 8. Implementation plan

Ordered by dependency and risk. Each phase ends with a green test run.

### Phase B — Stop the bleeding (do first, ~half a day)

| # | Task | Why |
|---|---|---|
| B-1 | **Reconcile C-1**: diff your local `deterministicExtractor.js` vs bundle; re-apply tenure guard + ministry-typo range; add regression tests for both | You currently have fixes I would otherwise overwrite |
| B-2 | Remove `.env` from all bundles; add `.gitignore`; rewrite `.env.example` with the **real** variable names | S-1, C-2 |
| B-3 | Redact URI in `db.js` (log host+db only, never credentials) | S-2 |
| B-4 | **Rotate**: Atlas password, Groq key, Gemini key, Gmail app password | S-3 — do this yourself, I cannot |
| B-5 | Add `helmet`, restrict CORS to `FRONTEND_ORIGIN`, add `express-rate-limit`, add 4-arg error middleware, wrap async routes | S-5/6/7 |
| B-6 | Baseline: run `npm test`, record the number | Regression guard for everything after |

### Phase C — Ingestion hardening
`SyncRun` model; conditional fetch via `sourceUpdatedAt`/ETag when the API
supports it; per-source metrics; collector checkpointing; failure isolation so
one malformed scheme cannot abort a cycle.

### Phase D — Validation + canonical schema
Validator with typed rejection reasons; `RejectedRecord` collection;
add missing canonical fields; `/api/admin/data-quality`.
De-duplicate the tag→rules logic into one shared module.

### Phase E — **PolicyChangeAgent** (research core, part 1)
Deterministic classifier first: map each diffed field to
`{changeType, severity, eligibilityImpact, benefitImpact, deadlineImpact,
documentImpact}`. LLM **only** when the deterministic rule is inconclusive.
Strict JSON schema out. Fully unit-testable with synthetic diffs — no network.

### Phase F — **PolicyImpactAgent** (research core, part 2)
Targeted Mongo query derived from the changed attribute + direction. For each
affected user: evaluate against `SchemeHistory` old snapshot rules **and** new
rules; classify the transition
(`BECAME_ELIGIBLE` / `BECAME_INELIGIBLE` / `STILL_ELIGIBLE_RANK_CHANGED` /
`NO_CHANGE`). This is where the thesis lives.

### Phase G — Propagation + `RecommendationHistory`
New model per your spec. Re-rank affected users; diff Top-K; persist
transitions with `triggeringChangeId` for the audit trail.

### Phase H — Explanation + Notification agents
Explanation grounded strictly in `{diff, oldRules, newRules, userProfile}` —
template-first, LLM for phrasing only. Notification decides on
`transition ≠ NO_CHANGE && severity ≥ threshold`, replacing today's
"eligible now" trigger.

### Phase I — Event spine
`Event` + `Job` collections; emit `SchemeChanged`, `PolicyChangeDetected`,
`AffectedUsersIdentified`, `RecommendationChanged`, `NotificationRequired`.
Convert the pipeline loop into event handlers. Enables replay and per-stage
failure isolation.

### Phase J — `npm run demo:policy-change`
Fixture scheme v1 `maxIncome=250000`, user income `280000` → NOT eligible.
Mutate to v2 `maxIncome=300000`. Run the real pipeline against a **mock
collector** (no live API, no LLM required). Assert the full chain including the
`RecommendationHistory` row. One command, deterministic, offline.

### Phase K — Retrieval upgrade (optional for the thesis)
Embeddings + vector search + cross-encoder. **Deliberately last** — BM25-lite
already carries a 4.7k corpus, and Phases E–G are the novel part. Do not spend
time here at the cost of the contribution.

### Phase L — Auth + RBAC
JWT, bcrypt, USER/ADMIN roles. Protect `/collect/run`, all `/admin/*`, and fix
the IDOR so a user can only read their own profile.

### Phase M — Evaluation + ablations
Labelled synthetic change set → Precision/Recall/F1 for change detection, diff,
eligibility, affected-user identification, propagation correctness,
notification precision. Ablations A–H per your spec. CSV/JSON out.
**Numbers must come from real runs.**

### Phase N — Docs + final validation
`README`, `ARCHITECTURE`, `RESEARCH_CONTRIBUTION`, `EVALUATION`, `API`,
`THREAT_MODEL`, `CHANGELOG`, `FINAL_STATUS` — the last one evidence-backed only.

---

## 9. Research contribution — honest positioning

**Not novel:** using Gemini/Groq, BM25, RAG, agents, hash-based change
detection. All standard.

**Genuinely novel and defensible:** the closed loop
`policy change → structured change classification → targeted affected-user
identification → old-vs-new eligibility re-evaluation → recommendation
transition → grounded explanation → impact-gated notification`,
with a per-user audit trail.

The literature has plenty on scheme recommendation and on document change
detection. What is thin is **recommendation staleness under policy drift** —
treating the recommendation set as a *live* object that must be re-derived when
the underlying policy changes, and being able to state *why* a user's
recommendations changed.

**Measurable claim to make in the paper:** given a labelled set of synthetic
policy changes, the system identifies affected users with precision/recall X/Y
and correctly propagates recommendation transitions at rate Z — versus a static
baseline that never updates. Phase M produces those numbers. They must be
measured, never asserted.

**Current honest status:** the loop's first arrow (change → diff → version)
works. Arrows 2–7 do not exist yet. Phases E–G are the contribution.

---

## 10. Testing plan

| Layer | What | Tooling |
|---|---|---|
| Unit | Extractors (incl. **both C-1 regressions**), matcher, ranker, comparator, PolicyChangeAgent classifier | Jest, pure |
| Integration | reconcile→history→propagation | `mongodb-memory-server` |
| API | All routes + authz (401/403 paths) | Supertest |
| Agent | Each agent: fixed input → asserted JSON, LLM mocked | Jest |
| **Synthetic policy-change** | Your TEST 1–8, each an isolated fixture | Jest, offline |
| E2E | `demo:policy-change`, asserted end-to-end | Node script |
| Evaluation | Metrics over the labelled set | Script → CSV/JSON |

Non-negotiables: no test may require network; LLM always mocked in tests;
every agent needs a deterministic-fallback test proving LLM-unavailable still
produces a correct verdict.

---

## 11. Top 10 risks, ranked

| # | Risk | Sev | Fix in |
|---|---|---|---|
| 1 | Live credentials in zip + logs; already exposed | CRITICAL | B-2/3/4 |
| 2 | IDOR — anyone reads any user's caste/income/age by email | CRITICAL | B-5, L |
| 3 | v14 bundle silently regresses two validated fixes | HIGH | B-1 |
| 4 | Unauthenticated `POST /collect/run` (DoS + quota burn) | HIGH | B-5, L |
| 5 | Research contribution not implemented | HIGH | E, F, G |
| 6 | `.env.example` wrong var names → broken fresh install | MEDIUM | B-2 |
| 7 | `User.find({})` per changed scheme | MEDIUM | F |
| 8 | No error middleware → crash risk, stack leaks | MEDIUM | B-5 |
| 9 | Missing indexes; full scheme scan per `/matches` | MEDIUM | D |
| 10 | Duplicated tag→rules logic will drift | LOW | D |

---

## 12. Immediate next step

Before I change any code I need to resolve **C-1**, because your local tree and
the shipped bundle have diverged and I must not overwrite your fixes.

Please send me your **current local** `src/services/deterministicExtractor.js`
(or just the `extractAge` function and any guard you added). I will diff it
against the bundle, merge both fixes forward, add regression tests for each,
and use that merged file as the baseline for Phase B.

If you would rather I proceed without it, I will re-apply both patches from the
snippets I gave you earlier and add tests — but then please re-check that
nothing else you edited locally is missing.

**Awaiting your go-ahead before modifying any code.**
