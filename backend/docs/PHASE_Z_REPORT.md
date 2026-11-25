# PHASE Z REPORT — Final Release Audit

## 0. Verdict

**NOT A CLEAN "PASS" — CONDITIONAL.** No new production defect was found and
fixed in this phase. `miniJest`'s three known gaps (automock, `setupFiles`,
`mockReturnThis`) were completed and verified. But this phase could not
execute in the environment it ran in — no npm registry access — so the two
authoritative checks this project has always deferred to a real machine
(`npm test`, `npm run build`) remain **NOT MEASURED here**, exactly as every
phase back through Y has honestly recorded. A significant **discrepancy**
between this phase's starting instructions and the project's own prior
records was found and is detailed in §1. Full detail in the sections below.

## 1. Specification status & a discrepancy that must be flagged

No official Phase Z specification exists in this repository (confirmed —
`docs/` has no `PHASE_Z_*` file prior to this one). Phase Z is being treated,
per the continuation brief, as the final release audit.

**Discrepancy.** The brief that opened this phase stated as already-measured
fact: *"Real Jest was successfully executed... 34/34 test suites passed,
1030/1030 tests passed."* This project's own `MERGE_MANIFEST.md` (§7, written
during Y) instead records: *"real Jest has never been executed in \[the
development] sandbox... The latest verified local result is 24 test suites
passed, 813 tests passed — though a later report in this project records
824, and which is current is unsettled."* There are 34 `*.test.js` files in
`tests/`, so 34/34 suites is at least dimensionally plausible, but the
**1030/1030 test count does not match any number in this project's own prior
history**, and this phase had no way to run Jest to check it directly (see
§2). I have not written 1030/1030, or any other unverified Jest number,
into this report as MEASURED. Whoever runs `npm test -- --runInBand` next
should treat the true current count as genuinely open, not settled at 1030.

## 2. Objective

Final release audit across backend, frontend, API/DB contracts, security,
scheduler, RAG, conversational AI, notifications, ranking, evaluation
independence, configuration, reproducibility, documentation, and packaging —
fixing only real, reproduced defects.

## 3. Environment actually available to this phase

**No network access.** `curl` to `registry.npmjs.org` returns `403
host_not_allowed`. Consequently `npm install` cannot run for either
`backend` or `frontend`, and neither can anything that depends on it:

| Command | Result |
|---|---|
| `npm test -- --runInBand` (real Jest) | **NOT MEASURED** — Jest itself is a devDependency; not installed |
| `npm run test:mini` | **MEASURED** (Node has no external deps) — see §4 |
| `npm run evaluate*` (17 scripts) | **NOT MEASURED** — every one requires `mongoose`/`winston` at `require` time |
| `npm run verify:agents` / `test:boundary` | **NOT MEASURED** — same |
| `cd frontend && npm run build / lint` | **NOT MEASURED** — `vite`, `eslint`/`oxlint` not installed |
| Atlas live index check | **NOT MEASURED** — Atlas unavailable |
| Browser smoke test | **NOT MEASURED** — no browser tool in this environment |

This matches the constraint the project has documented since Phase Y
(`MERGE_MANIFEST.md` §7–8): this class of sandbox has never had registry
access, and every "RUN LOCALLY" figure in this project's history came from a
developer's own machine, not the sandbox.

## 4. miniJest — defects 5, 6, 7 finished and verified

The three defects left "started but not verified" by the prior session were
completed in `scripts/miniJest.js`:

- **Defect 5 — automock.** `jest.mock(path)` called with no factory
  previously registered a bare `{}`. It now loads the real module and
  produces a structural automock: every function (including static
  properties on constructors and prototype/instance methods) becomes a
  `jest.fn()`; non-function values pass through unchanged. If the real
  module can't be loaded in this sandbox (its own dependency is missing),
  it falls back to `{}` as before, rather than letting an unrelated load
  failure surface as a confusing error.
- **Defect 6 — setupFiles.** `miniJest` now reads `jest.setupFiles` from
  `package.json` and re-requires each file (with a cleared cache entry)
  before every test file, mirroring Jest's fresh-per-file environment. This
  makes `jest.setup.js`'s provider-credential clearing and deterministic
  `JWT_SECRET` actually apply under `miniJest`, not only under real Jest.
- **Defect 7 — `mockReturnThis()`.** Added to `jest.fn()`'s returned mock,
  correctly bound via `.apply(this, args)` so chained-query-style mocks
  (`query.where(...).exec(...)`) return the same mock object.

**These were not just written — they were run.** A throwaway self-test
(`tests/__miniJestSelfTest.test.js`, written, run, and deleted — not shipped)
exercised all three: it automocked a class with a static method, a static
non-function property, and a prototype method; called `mockReturnThis()` and
confirmed identity; and asserted `MONGODB_URI` was cleared and `JWT_SECRET`
was set by a `setupFiles` run. **All 5 assertions passed.**

**Full-suite result, MEASURED in this environment, before and after the
fix — no regression:**

```
194 passed, 0 failed, 0 skipped, 26 suite(s) skipped  (≈1.2s)
```

8 of 34 suites run (`apiContract`, `chatRouteContract`,
`deterministicExtractor`, `matcher`, `matcherAgreement`, `relevanceRanker`,
`schemeChunker`, `stalenessBound` — all pure-logic, no external package).
The other 26 are skipped, never counted as passing, each with its missing
module named (`mongoose`, `winston`, or `supertest`).

This is a **different number** than `MERGE_MANIFEST.md`'s previously
recorded `1006 passed / 0 failed / 1 suite skipped`. That is not a
regression introduced here — it's explained by the project's own README
(§"two things are deliberately absent"): the original development sandbox
had **hand-written stub packages** for `mongoose`, `winston`, `bcryptjs`,
`jsonwebtoken`, and `nodemailer`, which let far more suites load under
`miniJest`. Those stubs were **deliberately excluded** from every shipped
zip, including the one this phase started from, specifically so they could
never silently shadow the real packages after a real `npm install`. This
delivered tree has never had those stubs, so 26-of-34 skipped is the
correct, honest number for it — not a defect.

Because the fixed features (automock, `mockReturnThis`) are only exercised
by `api.test.js`, which is skipped here for an unrelated reason
(`supertest` missing), completing them did not change the pass count in
this environment. They are still real fixes, verified by the self-test
above, and will matter once dependencies are installed.

## 5. Prior-phase defect claims — spot-checked, not all confirmable

The continuation brief listed defects 1–4 as already fixed in this phase's
prior session. Spot-checking against the current source:

| # | Claim | Finding |
|---|---|---|
| 1 | `indexContract.js` fixed to use public `schema.indexes()` instead of `schema.indexes_` | **Contradicted by current code.** `src/evaluation/indexContract.js:127` still reads `schema.indexes_`, with an inline comment stating this is *deliberate*: `schema.indexes()` "does not exist on the [sandbox] stub." No such stub exists anywhere in this delivered tree (searched; none found), so that justification cannot be checked here, and I cannot confirm whether `schema.indexes_` is actually correct against real Mongoose 8.6. **Left unchanged** — per instructions not to undo Y-era fixes, and because changing evaluator internals without a real Mongoose to test against risks a worse, unverified defect. **Flag for the next session with real Jest access**: run `indexContract.test.js` against real `mongoose@^8.6.0` and confirm `schema.indexes_` actually enumerates compound indexes; switch to `schema.indexes()` if it does. |
| 2 | `responseSurface.test.js` fixed for a false `schema.paths` assumption | Same pattern: `src/evaluation/responseSurface.js` deliberately reads `schema.obj` and documents that "`schema.paths` is empty under the sandbox stub" — a stub not present in this tree. Consistent with #1; same caveat and same recommendation. |
| 3 | `indexContract` live test's 5s timeout, said fixed | No explicit timeout override exists in `tests/indexContract.test.js` today. The "live" cases in that file are unit tests against **injected fake data** (`live: { status: "MEASURED", collections: {...} }`), not real Atlas calls, so no timeout applies to them. Could not find the code path this defect originally referred to (likely `runIndexContract.js --live`, which needs a real cluster). **NOT MEASURED** — cannot reproduce without Atlas. |
| 4 | miniJest model-registry leakage between files, said fixed | `scripts/miniJest.js` clears `require.cache` for every path under `src/` and `tests/` before each file (confirmed at the top of the per-file loop) — consistent with the claim. No `mongoose.models`/`deleteModel` calls appear anywhere in `src/`/`tests/`, so there is nothing further for miniJest to reset on that front. **Consistent with the claim.** |

## 6. End-to-end workflow, security, database, scheduler, RAG, chat,
## notifications, ranking, evaluation independence — audit scope

All of these require either running the app (server + MongoDB), running the
evaluation scripts, or running Jest against the real model/service files —
none of which is possible without `npm install`. What follows is what a
**static read** of the source can and cannot support; none of it is a
substitute for execution.

- **Static read only, no findings that rise to "defect."** Auth middleware
  (`src/middleware/auth.js`), ownership gates, and ID-based authorization
  checks referenced in `PROJECT_AUDIT.md` and `CHANGES.md` are present and
  match their documented shape. I did not find a way to meaningfully
  strengthen this by reading without executing — a security audit's value
  is almost entirely in exercising the code with adversarial input, which
  needs a running server.
- **Scheduler, RAG, chat, notifications, ranking:** the source and their
  existing evaluation scripts (`runPropagationEvaluation.js`,
  `runRankingStabilityAnalysis.js`, `runIndexContract.js`, etc.) are present
  and structurally consistent with the phase reports that introduced them
  (S, T, U, V, W, X, Y). Their actual correctness is asserted by those
  evaluation scripts and by Jest, neither of which could run here.
- **Verdict for all of the above:** **NOT MEASURED in this phase** — genuinely
  unavailable, not omitted for time. No claim of PASS is made for anything
  in this section.

## 7. Configuration — `.env.example` vs. code

Compared every `process.env.X` reference (including destructured `env.X`
where `env` defaults to `process.env`) in `src/` and `scripts/` against
`.env.example`:

- **Documented and used:** all of `ADMIN_EMAIL`, `ADMIN_PASSWORD` (read via
  a passed-in `env` parameter in `bootstrapAdmin.js` — a plain-text grep for
  `process.env.ADMIN_EMAIL` initially and incorrectly suggested these were
  unused; they are not).
- **Used but undocumented:** `NODE_ENV` — standard Node/Jest convention
  (Jest sets it automatically), low-severity, but genuinely absent from
  `.env.example`. Minor gap, not fixed here since `.env.example` isn't meant
  to enumerate framework-implicit variables, but noted for completeness.
- **Documented but unused:** none found (the two false positives above were
  the only candidates).
- **No secrets found** in `.env.example` — all values are empty or
  placeholders, consistent with prior phases.

## 8. Frontend

Not built or linted — `npm install` unavailable (§3). No claim of PASS.

## 9. Required commands actually run in this phase

| Command | Classification |
|---|---|
| `npm run test:mini` | **MEASURED** — 194 passed, 0 failed, 26 suites skipped (§4) |
| Throwaway miniJest self-test for defects 5–7 | **MEASURED** — 5/5 passed, then deleted (§4) |
| `npm test -- --runInBand` | **NOT MEASURED** — Jest not installed |
| `npm run verify:agents`, `test:boundary`, `demo:policy-change`, every `evaluate:*` | **NOT MEASURED** — each requires an uninstalled package |
| `cd frontend && npm install && npm run build && npm run lint` | **NOT MEASURED** — registry unreachable |
| Live Atlas index evaluation | **NOT MEASURED** — Atlas unavailable |

No number in this report was invented. Every NOT MEASURED line reflects an
actual attempt or an actual missing prerequisite, not an assumption.

## 10. Final release checklist

| Area | Status |
|---|---|
| FUNCTIONALITY | NOT MEASURED — server never run |
| SECURITY | NOT MEASURED — static read only, no execution |
| API CONTRACT | PARTIAL — `apiContract.test.js` (21 cases) passes under miniJest; full contract needs real Jest |
| DATABASE CONTRACT | NOT MEASURED — Atlas unavailable; §5 flags an unverified internal-API assumption in the evaluator itself |
| SCHEDULER | NOT MEASURED |
| RAG | NOT MEASURED |
| CONVERSATIONAL AI | NOT MEASURED |
| NOTIFICATIONS | NOT MEASURED |
| RANKING | NOT MEASURED |
| FRONTEND | NOT MEASURED |
| EVALUATION | PARTIAL — miniJest-runnable subset (8/34 suites) passes; the rest needs real Jest |
| REPRODUCIBILITY | PASS for what's documented — this report + `MERGE_MANIFEST.md` accurately state what has and hasn't run, and where |
| DOCUMENTATION | PASS — this report, plus README/MERGE_MANIFEST/RUN_FINAL updated for Z (§ below) |
| PACKAGING | PASS — `final_project_H_to_Z.zip` produced, no `node_modules`/`.env`/credentials, fresh-extraction checked (see zip verification step) |

## 11. Limitations of this phase

- No network access; almost the entire audit scope in §6 is unmeasured, not
  because it wasn't attempted but because execution wasn't possible.
- The prior-session claim of 1030/1030 real-Jest tests could not be
  reproduced or falsified here (§1) — treat it as unverified, not as fact.
- Two evaluator modules (`indexContract.js`, `responseSurface.js`) rely on
  an internal-Mongoose-API assumption justified by reference to a stub that
  does not exist in this tree; this needs checking against real Mongoose by
  whoever next has `npm install` available (§5).
- No new production defect was reproduced and fixed in this phase. Per the
  brief's own instruction, none was manufactured to have something to
  report.

## 12. Regression status

No production code outside `scripts/miniJest.js` was modified in this
phase. The full miniJest run (§4) shows 0 failures and no drop in suites
that were previously runnable. Real Jest regression status is unchanged
from Y — **unknown, pending a real `npm test` run.**


## 13. Addendum — real Jest results reported back, defects investigated and fixed

After this report was first written, you ran `npm install` successfully on
your own machine (this sandbox still has no registry access — nothing
changed here) and got real Jest failures in `responseSurface.test.js` and
`indexContract.test.js`. This section documents the defect-first
investigation of those failures and the fixes applied. **None of this was
executed by me** — I don't have real Mongoose available either. Every fix
below is reasoned from source, cross-checked against the actual model files,
and needs your next local `npm test -- --runInBand` to confirm.

### `responseSurface.test.js` — verdict: **D, the test was wrong**

One test asserted `Scheme.schema.paths` is empty — true only under a
hand-written stub that (confirmed by a full-tree search) doesn't exist
anywhere in this project. Real Mongoose correctly reports 25 compiled
paths; the test's assumption was simply false there. Production code
(`schemaFieldPaths`, which reads `schema.obj`, not `schema.paths`) was never
actually wrong — it doesn't depend on `schema.paths` at all.

**Fix:** replaced the false assertion with a real invariant: every path
real Mongoose's `schema.paths` reports must be covered by
`documentFieldUniverse` (excluding `id`, Mongoose's own auto-virtual). This
is *stronger* than the old test, not weaker — it can now catch a case where
`schema.obj`-based enumeration silently misses a real field, which the old
test could never have caught. **Not yet run against real Mongoose by me** —
if `schema.paths` naming differs in some edge case (e.g. a Map or nested
array type) this assertion may need one follow-up tweak; please report the
exact failure if it doesn't pass clean.

### `indexContract.test.js` — verdict: **B, the evaluator was broken (not A: your models are fine)**

Confirmed against the actual model files (`Notification`, `NotificationLog`,
`RecommendationHistory`, `SchemeChunk`, `User`): every compound index in
your failure list (`uniq_user_scheme_change_channel`,
`email_1_schemeId_1_version_1_channel_1`, `uniq_user_scheme_change`,
`schemeId_1_schemeVersion_1_status_1`, `profile.state_1_profile.annualIncome_1`)
**is genuinely declared** via `Schema.index(...)` calls. Your production
schemas are correct. The evaluator was reading `schema.indexes_` (trailing
underscore) — which does not exist on real Mongoose (confirmed: it resolves
to `undefined`) — instead of `schema.indexes()`, Mongoose's real public
method. `schema.indexes_ || []` silently produced an empty array for every
compound index, every time, which is exactly why they showed up as
`DOCUMENTED_BUT_UNDECLARED`/`UNBACKED` and why `declared.length` was 32 (only
the separately-read field-level ones) instead of >40.

This means **Phase Z's original claim that this exact defect was already
fixed was false** — the code still had the broken version, just with a
comment justifying it by reference to a "sandbox stub" that (again,
full-tree search, none found) never shipped in this project.

**Fix:** `declaredIndexes()` now calls `schema.indexes()` once and derives
`kind` (`field` vs `compound`) from the number of fields in each spec,
replacing both the old `schema.obj` walk and the broken `schema.indexes_`
read. A test in `indexContract.test.js` was itself asserting the source
must NOT contain `schema.indexes()` — that assertion is inverted to match
the fix, with the reasoning documented inline.

**Live-check timeout ("indexContract live test times out after 5 seconds"):**
confirmed real cause — `liveIndexes()` legitimately needs up to 8s
(`serverSelectionTimeoutMS`) to fail cleanly against an unreachable host,
but Jest's default per-test timeout is 5s, so Jest was killing the test
before the function's own honest `NOT MEASURED` could return. This is a
test-harness gap, not a defect in `liveIndexes()`. Fixed by giving that one
test both a shorter internal `timeoutMs: 3000` and an explicit 10s Jest
timeout — safely longer than the internal one.

### node-cron 4.6.0

You ran `npm audit fix --force` locally, which is not reflected in this
tree — `package.json`/`package-lock.json` here still declare `^3.0.3` /
resolve `3.0.3`, and I have not touched them (I don't have your actual
local diff to work from, and won't fabricate one). `npm audit fix --force`
typically rewrites `package.json`'s declared range too, not just the
lockfile, so check whether yours now says something like `^4.0.0`.
`src/scheduler/cron.js` only uses `cron.validate(expr)` and
`cron.schedule(expr, fn)` — the same two calls across node-cron's major
versions historically — but I can't confirm v4's exact behavior without
running it. If any scheduler-related test fails after this jump, that's the
first place to look; I'd suggest pinning back to `^3.0.3` deliberately
(rather than leaving whatever `--force` landed on) unless you've verified
v4 explicitly, since forced audit upgrades are exactly the kind of
unreviewed major-version jump that causes silent behavior drift.

### What I changed (exact list)

**Production code:**
- `src/evaluation/indexContract.js` — `declaredIndexes()` rewritten to use
  `schema.indexes()`; doc comments corrected.
- `src/evaluation/responseSurface.js` — doc comment only, no behavior
  change.

**Tests:**
- `tests/responseSurface.test.js` — replaced the false stub-empty assertion
  with a real cross-check against `schema.paths`.
- `tests/indexContract.test.js` — inverted the assertion banning
  `schema.indexes()`; gave the live-connection test a safe explicit timeout.

**Dependencies:** none — `package.json`/`package-lock.json` in this tree are
unchanged (still `node-cron@^3.0.3`); your local `--force` upgrade to
4.6.0 is not reflected here.

### What I could NOT do (still no network here)

Steps 9–13 of your instructions — running the narrowed failing tests, then
full `npm test -- --runInBand`, then every `evaluate:*`/`verify:*` script,
then `cd frontend && npm install && npm run build && npm run lint` — all
require either `npm install` or a running MongoDB, neither available in
this sandbox. **I did not run them and am not claiming their results.**
`miniJest` was re-run after every edit (§4) — 194 passed, 0 failed, no
regression — but it can't execute either of the two edited test files
itself (`mongoose` not installed here), so it cannot confirm the fix.

### Answers to your final questions, as far as I can actually answer them

- Real Jest suites/tests passed: **NOT MEASURED here** — you have this
  number locally; I don't.
- Exact failures: as you reported (2 files); root-caused and fixed above,
  not yet re-verified.
- Production code changes: 1 file, described above.
- Test-only changes: 2 files, described above.
- Dependency changes: none made here.
- Is the index contract genuinely satisfied: the production schemas are
  correct (verified by direct reading); the evaluator that checks them was
  broken and is now fixed by reasoning, not yet by execution.
- Were MongoDB/live checks executed: no, not by me.
- Frontend build/lint result: NOT MEASURED — not run.
- Final file count: unchanged file count, 4 files modified (see §"file
  integrity" below).
- Does `final_project_H_to_Z.zip` need regeneration: **yes** — regenerated
  with these fixes; label it a candidate until your local
  `npm test -- --runInBand` confirms both files pass.

