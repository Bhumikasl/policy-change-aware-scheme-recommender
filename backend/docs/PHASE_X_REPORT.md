# PHASE X — Cross-Surface Recommendation Agreement

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase X only.** At the time this Phase X report was produced, Phase Y had not started.

---

## 1. Verdict

**COMPLETE.** A live production defect — the audit trail and the notification
emails ranking a user's recommendations differently from the page and the
assistant — was reproduced, root-caused, fixed, regression-tested and
mutation-tested. 981 tests pass, 0 fail. All 14 evaluation and verification
scripts exit 0 from a fresh extraction. 0 files removed.

---

## 2. Official specification

**NO OFFICIAL PHASE X SPECIFICATION FOUND.**

Searched the whole H→W tree: `README.md`, `MERGE_MANIFEST.md`, `RUN_FINAL.md`,
`PROJECT_AUDIT.md`, `NOTIFICATION_ARCHITECTURE.md`, `INDEX_VERIFICATION.md`,
`CHANGES.md`, all 13 phase reports, every evaluation document, all source
comments, all tests, every deferred-work note. The only occurrences of "Phase X"
are the three forward-looking lines in `PHASE_W_REPORT.md` saying it had not
started.

Phase X was therefore chosen defect-first, as S, T, U, V and W were.

---

## 3. Objective

Check that the three independent paths by which the system tells a user their
recommendations agree with each other — and that the thing they agree on is
right.

---

## 4. Why Phase X was necessary

Every prior phase verifies **one mechanism**:

| | verifies |
|---|---|
| Q | candidate selection |
| R | notification cost |
| S | the staleness bound |
| T | the ranker |
| U | the matcher |
| V | the change detector |
| W | the serialization boundary |

The user, however, is told their recommendations by **three** paths, and each
assembled its own candidate list before handing it to the ranker:

1. `GET /users/:email/matches` — the page
2. `chatService` — the assistant
3. `recommendationPropagation` — the audit trail and the notification emails

Every component can be individually perfect while those three disagree.

**Phase T is the near miss.** T proves the ranker is a function of its inputs —
that ranking the same candidates twice gives the same answer. It never asks
whether the three callers hand it the *same inputs*. That is the question Phase
X adds, and the answer was no.

---

## 5. Audit performed

Backend: all 4 routers (20 routes), 7 models, 5 agents, 25 services, the
scheduler, the normalizer, 18 evaluation modules, 15 scripts, 33 test files.
Frontend: 21 source files, 9 routes, the API client, auth context, protected
routes. Configuration: `package.json`, `.env.example`, jest config.

Checked and found sound before looking further: `notifier` re-exports the
matcher's own functions rather than redefining them (verified by identity, not
by reading); the `Scheme` and `SchemeHistory` schemas declare every field the
normalizer writes, so nothing is silently dropped by Mongoose strict mode;
`SchemeHistory.snapshot` is `Mixed`, so the "before" rules a retry reads are not
lossy; the K0 authorization model is intact on every `/users/:email/...` route.

---

## 6. Defects found

### 6.1 The propagation pass ranked on incomplete candidates *(live)*

`relevanceRanker` scores a candidate on seven terms. One of them:

```js
// ---- 5. document readiness ----
const dr = candidate.documentReadiness;
let docs = 0;
if (dr && dr.required > 0) docs = (dr.have / dr.required) * 1.5;   // 0 .. 1.5
```

`GET /matches` and `chatService` both built `{scheme, verdict, documentReadiness}`.
`computeRecommendationState` built `{scheme, verdict}`.

Absent, the term is not an error — it is **silently zero**.

### 6.2 Three copies of the status gate *(latent)*

`recommendationPropagation` exports `isActive` with this comment:

> *"Exported so the chat service can apply the SAME status gate rather than
> reimplementing it … two copies of that rule would drift."*

`GET /matches` was a third copy, written as a Mongo equality: `status: "Active"`.
`isActive` also accepts `"active"` in any casing and a blank status. Today's
single collector emits exactly `"Active"` or `"Closed"`, so this is **latent, not
currently firing** — and it is the shape of defect that appears the day a second
source is added.

### 6.3 The diagnostic disagreed with the thing it diagnoses *(latent)*

`GET /users/:email/matches/stats` exists to explain why the matches count is what
it is. It counted `status: "Active"` exactly, so a scheme with a lowercase or
blank status could be recommended by `/matches` and simultaneously reported as
not active by the endpoint explaining `/matches`.

---

## 7. Reproduction

Two schemes, identical in every ranking signal except the documents they demand.
The user holds the papers for one and not the other.

```
$ node repro_x.js          # against the pristine H→W tree

A/B  page + assistant     : 1. papers-ready (relevance 5)   2. papers-missing (relevance 3.5)
C    propagation + history: 1. papers-missing (relevance 3.5)   2. papers-ready (relevance 3.5)

*** RANKS DISAGREE ***
  history row for papers-missing: rank 1, relevance 3.5
  history row for papers-ready: rank 2, relevance 3.5
```

The two tie at 3.5 in the propagation pass because the readiness term was
dropped, and the **Phase T tie-break — working exactly as designed** — then
orders them alphabetically. The scheme the user cannot apply for is recorded at
rank 1.

### Blindness of every prior phase — MEASURED on the pristine H→W tree

| O | P | Q | R | S | T | U | V | W | full suite |
|---|---|---|---|---|---|---|---|---|---|
| ran | ran | **SOUND** | **MEASURED** | ran | **STABLE** | **AGREE** | **COMPLETE** | **CONFINED** | **957/957** |

Nine evaluations and 957 tests, all green, while the audit trail and the page
disagreed about which scheme was the user's best option.

### Why the tests missed it — the detail worth recording

`chatService.test.js` contains:

```js
it("DEFECT 3: documentReadiness feeds the ranker, as it does at the other call sites", …)
```

Someone found this exact bug in the chat service, fixed it there, and wrote a
test whose **name asserts the invariant holds at the other call sites** — while
its body checks only one. The propagation copy kept the bug. A test that names a
cross-cutting invariant and checks a single site is worse than no test: it reads
like coverage.

---

## 8. Root cause

**Three hand-assembled copies of one candidate shape**, with the invariant
recorded in comments rather than in code. Both `chatService` and
`recommendationPropagation` carry comments saying the shape must match the other
call sites. A comment is a hope; nothing enforced it.

The second-order cause is why it stayed hidden: **a missing candidate field is
not an error anywhere.** It scores zero. So the divergence is invisible except
where that term is the deciding signal — and no corpus in the project, not Q's,
not R's, not T's, happened to contain such a case.

---

## 9. Fix

**One assembly, called by all three surfaces.**
`recommendationPropagation.buildCandidates(user, universe, { allowUnknown })`
applies the status gate, runs the matcher, and attaches `documentReadiness`. It
lives in the file that already owns `isActive`, for the same stated reason.

- `computeRecommendationState` — calls it (this is the live fix)
- `chatService.loadRecommendationContext` — calls it
- `GET /users/:email/matches` — calls it

The scheme object is passed through **exactly as supplied**, because `/matches`
calls `.toObject()` on it afterwards.

**6.2** — `/matches` now prefilters with the cheap indexed superset
`{ status: { $ne: "Closed" } }` (the same prefilter `GET /api/schemes` already
uses) and lets the shared gate decide. Keeping the query broad rather than exact
is what makes the JS gate authoritative instead of decorative.

**6.3** — `/matches/stats` counts the same universe.

Fixing one copy is what created this situation in the first place, so the fix is
structural: there is now one place to fix, and a test asserts no surface builds
its own.

---

## 10. Tests

`tests/surfaceAgreement.test.js` — 24 tests in five groups: the defect (the
field is present, matches `getDocumentReadiness` exactly, produces the right
order, reaches the history state, and the readiness term really is what decides
that order); one-assembly-not-three (every surface routes through the builder,
no surface hand-rolls a candidate, the status gate is shared, the scheme object
survives untouched); independence; falsifiability; and the sweep result.

---

## 11. Mutation testing

Twelve mutations — six of production, six of the evaluator. **All twelve killed.**

| mutation | harness | tests failed | result |
|---|---|---|---|
| X-M1 builder drops `documentReadiness` *(the original defect)* | **DISAGREE** | 11 | killed |
| X-M2 builder drops the status gate | **DISAGREE** | 4 | killed |
| X-M3 builder ignores `allowUnknown` | **DISAGREE** | 2 | killed |
| X-M4 `/matches` reverts to an exact status equality | AGREE | 1 | killed |
| X-M5 propagation rebuilds its own list again | AGREE | 2 | killed |
| X-M6 builder converts the scheme, breaking `.toObject()` | AGREE | 1 | killed |
| X-M7 *(evaluator)* `shapeOf` always reports the full contract | AGREE | 3 | killed |
| X-M8 *(evaluator)* the independent membership check is skipped | AGREE | 1 | killed |
| X-M9 *(evaluator)* the reference status rule is replaced by production's | AGREE | 1 | killed |
| X-M10 *(evaluator)* the evidence-strength counter never fires | AGREE | 1 | killed |
| X-M11 *(evaluator)* surfaces are never compared to each other | AGREE | 3 | killed |
| X-M12 *(evaluator)* `orderOf` reports nothing | AGREE | 5 | killed |

**X-M1 survived the harness on the first pass, and the reason matters more than
the fix.** Once all three surfaces share one builder, a defect *in that builder*
breaks them identically — and they go on agreeing perfectly. Differential
testing reported AGREE for exactly the bug the phase was created to fix. Killed
only by tests.

That is a structural limit of the method, not a slip, so it was fixed in the
harness: `SHAPE` is now **also** compared against `relevanceRanker`'s documented
candidate contract, not only between surfaces. X-M1 now fails the harness itself.

A second finding from that change: the first version of the contract check
reported a violation for users who qualify for nothing — an empty candidate set
has no shape. A check that cries wolf on correct behaviour gets switched off, so
the empty case is exempted, with a test.

**A third detail, recorded because it repeats a Phase W lesson:** the structural
status-gate test initially failed against correct code, because the route's own
comment *explains* the defect by quoting the old filter and the check read that
quotation as live code. Fixed by reusing Phase W's `stripComments` helper — the
same false alarm, in a different file, caught by a tool the previous phase had
already built.

---

## 12. Backend impact

Four files changed, three added. All `.js` parse under `node --check`. No route
renamed, removed or reguarded; the route inventory is unchanged at 20 routes,
7 unauthenticated. Server startup, middleware, scheduler and logging untouched.

One behavioural change beyond the fix: `/matches` now considers schemes whose
status is not exactly `"Active"` but which the shared gate accepts. That is the
point of the fix — those schemes were already being recommended by the other two
surfaces.

---

## 13. Frontend impact

**None. No frontend file was modified.** The response contract of `/matches` is
unchanged: same array, same fields, same `matchExplanation`, same funnel
headers. `npm run build` and `npm run lint` are **NOT EXECUTED** — `npm install`
returns HTTP 403 in this sandbox, so `vite` and `oxlint` are not installed. **No
browser verification was performed.**

---

## 14. Database impact

**None.** No schema, index, migration or query shape change beyond broadening
one filter from `status: "Active"` to `status: { $ne: "Closed" }` — which reads
the same field and is equally indexable. No data touched, no migration needed,
`MONGODB_URI` compatibility unchanged. No credentials, no real `.env`.

---

## 15. Security impact

**Nothing weakened.** JWT authentication, `requireAuth` / `requireSelfOrAdmin` /
`requireAdmin`, IDOR protection, user isolation, the Phase P grounding and
contradiction guards, guard defaults, raw LLM output preservation, rate limits,
CORS, helmet, secret handling — all unchanged. `/matches` remains
`requireAuth` + `requireSelfOrAdmin`; the Phase W response projections are
untouched and `evaluate:exposure` still reports CONFINED.

---

## 16. Research contribution

**Problem.** Component-wise verification is the default in evaluated systems,
and it is silent about *composition*. When several user-facing paths reconstruct
the same derived state, each can be individually correct while the system speaks
with several voices — and the harnesses, which examine components, all pass.

**Research question.** Can the agreement of several production paths over the
same derived state be checked without reimplementing the derivation?

**Method.** Differential comparison across the real paths on three properties —
the *shape* of the input handed to the shared scorer, the *membership* of the
candidate set, and the resulting *order* — over a corpus built so that a dropped
input is decisive rather than merely present. Reimplementing the ranker was
deliberately rejected: a second 300-line scorer drifts for reasons that say
nothing about correctness, and Phase T already owns the ranker's own properties.

**Finding.** A system passing nine research-grade evaluations and 957 tests had
its audit trail and its notification emails ranking a user's recommendations
differently from its own page — with the scheme the user could not apply for
recorded at rank 1.

**Contribution.** Three transferable results.

First, **an optional-looking input is the ideal hiding place for a composition
bug.** A missing required field throws on the first request; a missing scoring
term contributes zero and produces a plausible wrong answer forever.

Second, **differential testing degrades exactly as you fix it.** Consolidating
three copies into one shared function removes the drift — and simultaneously
removes the harness's ability to see a defect in that function, because the
surfaces now break together. A differential harness must therefore carry at
least one anchor outside the surfaces. Mutation X-M1 demonstrates both halves:
it reported AGREE before the contract anchor existed, and DISAGREE after.

Third, and cheapest to adopt: **a test whose name asserts a cross-cutting
invariant must check every site, or say in its name which one it checks.** The
test that named this invariant, and checked one of three places it had to hold,
is the reason it survived a phase that was explicitly hunting ranking defects.

**Limitations.** SYNTHETIC and bounded, and it says nothing about whether the
ranking is *good* — only that the three surfaces tell the user the same story.
The LLM verifier stage of `/matches` is outside the compared assembly and needs a
real LLM run to evaluate. The surfaces are exercised in process through the
functions the routes call, not through a running HTTP server.

---

## 17. Measurements

| | |
|---|---|
| surfaces compared | **3** |
| users × universes | 4 × 6 = **24 comparisons** |
| comparisons where readiness decides the order | **4/24** |
| **before the fix** (pristine H→W) | **DISAGREE** — ranks contradict on the readiness corpus |
| pre-fix harness signal | **24 disagreements: 20 SHAPE, 4 ORDER** |
| **after the fix** | **AGREE** — 0 disagreements on all five properties |
| prior harnesses under the defect | O–W all pass, suite **957/957** |
| mutants killed | **12/12** (1 after strengthening the harness) |

All MEASURED on a SYNTHETIC corpus. Nothing DERIVED, nothing SIMULATED.
The 20-vs-4 split is worth keeping: **SHAPE catches the dropped field five times
more often than ORDER does**, because ORDER only fires where the term changes
the result. The sensitive property is the one that would have caught this before
it ever produced a wrong ranking.

---

## 18. Limitations

**MEASURED** — the before/after harness result, all mutation outcomes, every
suite and script result, the prior-phase blindness table.
**SYNTHETIC** — the corpus: 4 users, 6 universes, built to make divergence
decidable rather than to be large.
**LATENT, NOT MEASURED AS FIRING** — defects 6.2 and 6.3. Today's single
collector emits exactly `"Active"` or `"Closed"`, so the status-gate divergence
does not currently occur on real data. It is reported as latent and fixed
because the project's own comment says two copies of that rule would drift.
**NOT MEASURED** — real Jest, frontend build and lint, browser behaviour, Atlas,
real HTTP responses, the LLM verifier stage, and ranking quality. Nothing here
is converted from NOT MEASURED to 0.

---

## 19. Regression

| Phase | Result |
|---|---|
| BASE, H, I, J, K0, K, L/L.1–L.8, M, N | **PASS** |
| O | **PASS** — ran; retrieval quality still WITHHELD under local-hash |
| P | **PASS** — guards default ON, no env path |
| Q | **PASS** — SOUND, 100% recall (1089/1089) |
| R | **PASS** — MEASURED, 36.5% (627/1716); R.2 still NOT MEASURED |
| S | **PASS** — BOUNDED, 25 h DERIVED |
| T | **PASS** — STABLE, 0 unstable, 40/40 tie groups |
| U | **PASS** — AGREE, 306,180 verdicts, 0 disagreements |
| V | **PASS** — COMPLETE, 196 mutations, 0 missed |
| W | **PASS** — CONFINED, 0 leaks |
| X | **PASS** — AGREE, 24 comparisons, 0 disagreements |

`npm run test:mini` → **981 passed, 0 failed, 1 suite skipped** (`api.test.js`,
which needs `supertest`). Every prior phase's headline figure is unchanged.

---

## 20. File integrity

```
H→W : 198 files      H→X : 203 files
Added : 5      Modified : 21      Removed : 0      Missing : 0
```

**Added:** `src/evaluation/surfaceAgreement.js`,
`src/evaluation/surfaceCorpus.js`, `scripts/runSurfaceAgreement.js`,
`tests/surfaceAgreement.test.js`, `docs/PHASE_X_REPORT.md`.

---

## 21. Current phase chain

```
BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y
```

### Reproducibility

```bash
npm run evaluate:surfaces
npm run evaluate:surfaces -- --verbose     # every comparison, per surface
npm run evaluate:surfaces -- --out x.json
```

Deterministic: fixed corpus, no sampling, no seed. Exits non-zero on any
disagreement — a disagreement means at least one surface is telling the user
something the others contradict, so CI can gate on it.

---

*Phase X complete. At the time this report was produced, Phase Y had not started.*
