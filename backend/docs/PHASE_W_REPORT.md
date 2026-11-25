# PHASE W — Public Response-Surface Confinement

> **Point-in-time report.** Written when the tree ended at this phase. The project now runs **BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y** — see `MERGE_MANIFEST.md`. The findings below stand as recorded; only the forward-looking "not started" notes are superseded.

**Scope: Phase W only.** At the time this Phase W report was produced, Phase X had not started.

---

## A. Overall verdict

**COMPLETE.** A real, reproducible data-exposure defect was found in production
code, fixed, regression-tested and mutation-tested. 957 tests pass, 0 fail. All
13 evaluation and verification scripts exit 0 from a fresh extraction. 0 files
removed.

---

## B. Was there an official Phase W specification?

**NO OFFICIAL PHASE W SPECIFICATION FOUND.**

I searched the whole H→V tree — `docs/` (12 reports), `README.md`,
`MERGE_MANIFEST.md`, `RUN_FINAL.md`, `PROJECT_AUDIT.md`,
`NOTIFICATION_ARCHITECTURE.md`, `INDEX_VERIFICATION.md`, `CHANGES.md`, all
source comments, all tests, all deferred-work notes. The only occurrences of
"Phase W" are the two forward-looking lines in `PHASE_V_REPORT.md` saying it had
not started.

So Phase W was chosen defect-first, as S, T, U and V were.

---

## C. Why Phase W was necessary

Every evaluation phase so far measures **a function**.

| | measures |
|---|---|
| O | retrieval staleness |
| P | guard ablation |
| Q | candidate selection |
| R | notification cost |
| S | schedule arithmetic |
| T | comparator stability |
| U | the eligibility matcher |
| V | the change detector |

All eight call production code in process and inspect what it returns **to other
production code**. Not one of them looks at what leaves the process.

That is not a small blind spot. A field can be correct, well-tested and
exhaustively verified, and still be serialized to a caller who should never have
seen it. No amount of strengthening those eight harnesses reaches it, because
the defect is not in any function's return value — it is in the boundary that
publishes it.

**Measured, not assumed.** With the defect present in the tree:

| Phase O | P | Q | R | S | T | U | V | full suite |
|---|---|---|---|---|---|---|---|---|
| exit 0 | exit 0 | **SOUND** | **MEASURED** | **BOUNDED** | **STABLE** | **AGREE** | **COMPLETE** | **923/923** |

Every harness green. Every one of them correct to be green.

---

## D. Objective

Audit what the API actually publishes, at **field** level, against a policy and
a client that are both independent of the code doing the publishing.

`tests/apiContract.test.js` (K0.3) already does this at **route** level: it
reads endpoint strings out of the frontend and the routers and fails when either
side moves without the other. Phase W is that same check one level deeper, and
it exists for the same reason that one does — nothing was looking at both sides
at once.

---

## E. Architecture examined

Backend: `src/routes/` (4 routers, 20 routes), `src/models/` (7), `src/agents/`
(5), `src/services/` (24), `src/scheduler/`, `src/normalizer/`,
`src/evaluation/` (16), `src/middleware/`, `scripts/` (14), `tests/` (32).
Frontend: 21 source files, 9 routes, the axios client, auth context and
protected routes. Configuration: `package.json`, `.env.example`, jest config,
scheduler and embedding settings.

Verified intact before touching anything: the K0 auth model
(`requireAuth` / `requireSelfOrAdmin` / `requireAdmin` on every
`/users/:email/...` route), `User.toSafeJSON`, `notificationReadService.serialize`,
`chatService.toPublicResponse`, the Phase P guard defaults, the Phase Q
candidate-selection contract, and the Phase V detection fix.

---

## F. The defect

**Four unauthenticated endpoints published the policy pipeline's internal
operational state, including provider error messages.**

`src/routes/schemes.js`:

```js
router.get("/schemes/:schemeId/history", async (req, res) => {
  const history = await SchemeHistory.find({ schemeId: req.params.schemeId })...;
  res.json(history);          // the whole document
});

router.get("/updates/recent", async (req, res) => {
  const updates = await SchemeHistory.find({})...;
  res.json(updates);          // the whole document
});
```

Neither has `requireAuth`. Neither ever had a projection.

### How it grew

It was harmless when written. A history row held a version, an event type and a
diff. Then the model grew:

- **Phase J** added `policyImpactStatus`, `propagationStatus`, `policyRetryable`
  and `policyProcessing`.
- **Phase M** added `ragIndexStatus`, `ragIndexRetryable` and `ragIndexing`.

Both are written by `policyPipeline.persistStatus`. Nobody revisited the routes,
because nothing at the route needed changing: `res.json(doc)` keeps meaning
"everything on the row", so **each new internal field joined the public response
the moment it was added**, with no code change at the boundary and no diff for a
reviewer to notice.

---

## G. Reproduction

```
$ node scripts/runResponseSurfaceAudit.js     # against the pre-W projection

run status : EXPOSED
leaks      : 50

GET /updates/recent             -> 17 internal fields
GET /schemes/:schemeId/history  -> 17 internal fields
GET /schemes                    ->  8 internal fields
GET /schemes/:schemeId          ->  8 internal fields
```

What an anonymous `curl` received from `GET /api/updates/recent`, abridged:

```json
{
  "_id": "665f1c2ab9d4e70012a4c881",
  "policyRetryable": true,
  "policyProcessing": {
    "jobId": "cycle-2026-08-29T03:00:12Z",
    "candidateSelection": "targeted-band",
    "affectedUserCount": 1843,
    "durationMs": 41207,
    "errors": [{
      "stage": "explanation",
      "error": "GoogleGenerativeAI Error: [429] Quota exceeded … for consumer
                'project_number:918273645500'."
    }]
  },
  "ragIndexing": {
    "embeddingDegraded": true,
    "errors": [{ "stage": "embedding", "error": "connect ETIMEDOUT 10.0.4.19:443" }]
  },
  "snapshot": { "contentHash": "9f2c…", "…": "the entire scheme document" },
  "__v": 0
}
```

Every category the project's own standing rules forbid publishing is in there:

| category | what leaked |
|---|---|
| internal IDs | `_id`, `__v`, `policyProcessing.jobId`, `changeId` |
| retry data | `policyRetryable`, `ragIndexRetryable`, three stage statuses |
| provider errors | an LLM quota message carrying a **Google project number**; an embedding failure carrying an **internal IP address** |
| operational fields | `durationMs`, `candidateSelection`, `scannedEveryUser`, `narrowingProven`, `historyCreated` |
| user-base aggregates | **`affectedUserCount`** — how many people on this platform a given policy change moved, published per scheme, to callers with no account |

The scheme endpoints additionally published `contentHash` — the change
detector's own fingerprint, which lets anyone watch from outside the system's
private "nothing material changed" decisions — plus `lastCheckedAt`, which
describes the crawler's schedule rather than the scheme, and the extractor's
self-assessment (`confidence`, `needsReview`, `source`, `extractedAt`).

**`affectedUserCount` is the one that matters most.** It is not a fact about a
government scheme. It is an aggregate about the user base, and it was readable
by anyone with the URL.

---

## H. Root cause

`res.json(mongooseDocument)` is **fail-open by default**. It publishes whatever
the model happens to hold, so the response surface silently tracks the schema:
every field a later phase adds is public until someone notices.

The second-order cause is the one Phase W is really about: **nothing in the
project looked at a serialized response**. Twelve phases of evaluation, eight of
them explicitly research-grade, all stopping one layer short of the wire.

---

## I. The fix

**`src/services/publicProjection.js`** — an explicit allowlist for both
document types, following the project's own established convention
(`User.toSafeJSON`, `notificationReadService.serialize`,
`chatService.toPublicResponse`).

Allowlist, not denylist, and for a stated reason: a denylist has exactly the
failure mode above — correct the day it is written, wrong the next time the
model grows, because a new field is public by default. Under an allowlist a new
field is withheld until someone decides otherwise, and the audit reports it as
*undeclared* rather than leaking it.

`src/routes/schemes.js` — all four responses now go through it.

Two judgements worth stating rather than burying:

- **`snapshot` is narrowed to `{ name }`, not dropped.** The activity feed
  labels each row with the scheme's name *at that version*, which is not always
  the current name and therefore cannot be recovered from the `Scheme`
  collection.
- **The eligibility rules stay public; the extraction metadata does not.** The
  thresholds, categories and `eligibilityType` are the policy. `confidence`,
  `needsReview`, `source` and `extractedAt` describe our own pipeline's
  uncertainty, and the model comment already says `needsReview` is for an admin
  review queue.

---

## J. Tests

`tests/responseSurface.test.js` — 34 tests, in five groups:

1. **The defect**, named field by field: retry flags, job ids, user-base counts,
   provider error strings, `contentHash`, extraction metadata.
2. **The counterweight** — everything the version timeline and the activity feed
   render is still present. Confinement alone is satisfied by returning `{}`.
3. **Independence** — the policy table classifies fields the projection never
   mentions; the field universe comes from the schema; `schema.paths` is empty
   under the sandbox stub and is deliberately not used.
4. **The audit's other inputs** — the route inventory finds real guards, the
   frontend scan resolves real fields.
5. **Falsifiability** — the audit detects the raw document being published, an
   empty response, an emptied field, a leaking projection, and a route that
   reverts to `res.json(doc)`.

---

## K. Mutation testing

Fifteen mutations — seven of production, eight of the evaluator.

| mutation | audit | tests failed | result |
|---|---|---|---|
| W-M1 route reverts to `res.json(raw)` *(the original defect)* | **EXPOSED** | 2 | killed |
| W-M2 history allowlist gains `policyProcessing` | **EXPOSED** | 7 | killed |
| W-M3 scheme allowlist gains `contentHash` | **EXPOSED** | 5 | killed |
| W-M4 whole snapshot passed through again | **EXPOSED** | 3 | killed |
| W-M5 diffs dropped from the history response | **EXPOSED** | 2 | killed |
| W-M6 scheme `version` dropped | **EXPOSED** | 2 | killed |
| W-M7 extraction metadata published with the rules | **EXPOSED** | 3 | killed |
| W-M8 *(evaluator)* policy derived from the projection's own allowlist | **EXPOSED** | 3 | killed |
| W-M9 *(evaluator)* stops accounting for `_id`/`__v` | CONFINED | 1 | killed |
| W-M10 *(evaluator)* fixture-completeness guard never fires | CONFINED | 1 | killed |
| W-M11 *(evaluator)* frontend demand resolves to nothing | CONFINED | 5 | killed |
| W-M12 *(evaluator)* `flattenPaths` stops recursing | CONFINED | 2 | killed |
| W-M13 *(evaluator)* snapshot members graded PUBLIC | CONFINED | 2 | killed |
| W-M14 *(evaluator)* wiring check accepts *some* projected exits | CONFINED | 1 | killed |
| W-M15 *(evaluator)* sufficiency ignores an emptied field | CONFINED | 1 | killed |

**All fifteen killed — but three survived the first pass, and each exposed a
real weakness rather than a bad mutation.**

**W-M5 survived** *(diffs replaced with `[]`)*. The audit checked that a
required field was *present*, and `diffs: []` is present. The timeline would
render nothing while the audit reported CONFINED. **Fixed in the auditor**, not
the test: sufficiency now asks whether a field the source row carries still
carries something after projection, and W-M5 now fails the audit itself.

**W-M14 survived** *(`every` weakened to `some` in the wiring check)*. Every
handler in the tree has exactly one exit, so the two are indistinguishable on
real input — an *equivalent mutant today*, and a genuine hole tomorrow: a
handler with an early raw exit and a projected one would leak on the path nobody
looked at. **Fixed by extracting the predicate** and testing it directly on a
mixed list, rather than waiting for such a handler to exist.

**W-M15 survived** *(the emptied-field check disabled)* — the branch it disables
is one no correct projection reaches, so nothing exercised it. **Fixed by adding
a dependency-injection seam** (`runResponseSurfaceAudit({ surfaces })`, matching
the Phase R `deps` convention) so a test can hand the audit a deliberately
broken projection. Two tests now do exactly that: one that empties a field, one
that leaks.

Recorded rather than quietly patched: a check that has never been shown to fail
is not evidence.

---

## L. Frontend impact

**None. No frontend file was modified.**

That is a result, not an omission. The projection was designed against what the
components actually read, and the audit's W.2 property asserts it: `SchemeDetail`
(version timeline), `Admin` (activity feed) and `Browse` (scheme cards) all
receive every field they render. `npm run build` and `npm run lint` are
**NOT EXECUTED** — `npm install` returns HTTP 403 in this sandbox, so `vite` and
`oxlint` are not installed. **No browser verification was performed.**

---

## M. Backend impact

Two files changed, one added. Every `.js` in `src/`, `scripts/` and `tests/`
parses under `node --check`. No route was renamed, removed or reguarded; the
route inventory is unchanged at 20 routes, 7 unauthenticated. Server startup,
middleware order, scheduler and logging are untouched.

---

## N. Database impact

**None.** No schema, index, migration or query changed. The projection is applied
after the read, in the route. Existing data is untouched and unaffected;
`MONGODB_URI` compatibility is unchanged. No credentials anywhere, no real
`.env` in the ZIP.

---

## O. Security impact

**Strictly improved, nothing weakened.**

Unchanged and verified: JWT authentication, `requireAuth` / `requireSelfOrAdmin`
/ `requireAdmin`, IDOR protection on every `/users/:email/...` route, user
isolation, the Phase P grounding and contradiction guards, guard production
defaults, raw LLM output preservation, the collection-run rate limit, CORS
allowlist, helmet, and the body-size cap.

Improved: 50 internal field exposures across four unauthenticated endpoints,
removed. Two of the leaked strings carried infrastructure detail — a Google
Cloud project number and an internal IP address.

The route inventory is asserted by test: `/collect/run` still requires auth and
admin, and every `/users/:email/...` route is still guarded.

---

## P. Research contribution

**Problem.** Evaluation of data-driven systems concentrates on whether functions
compute the right values. The published interface — what is serialized, to whom
— is treated as configuration rather than as something with a measurable
correctness property. In an append-to-the-model architecture, that boundary
degrades *silently*: each field added to a schema joins every response built by
reflection, with no diff at the boundary for a reviewer to see.

**Research question.** Can the exposure surface of an API be audited
automatically, without asking the serializer to grade itself?

**Method.** Three inputs, none of them the projection under test:

1. **what can be emitted** — enumerated from the Mongoose schema definitions
   (`schema.obj`, recursing into sub-schemas), plus the `_id` and `__v` Mongoose
   adds unasked;
2. **what is internal** — a declared policy table, written from each field's own
   documentation in the model files, with a stated reason per field;
3. **what is needed** — parsed from the *frontend* source: the property accesses
   the components perform on each response. The client is the authority on what
   the client needs.

The projection is then run over a **fully-populated** fixture and its output
judged against (2) and (3), under three properties: **confinement** (nothing
internal escapes), **sufficiency** (nothing needed is lost), and **wiring**
(every audited route actually calls its projection).

**Finding.** A system that passes eight research-grade evaluation harnesses
published 50 internal fields — including provider error strings carrying
infrastructure identifiers, and an aggregate count of how many of its own users
each policy change affected — on four endpoints requiring no authentication.

**Contribution.** Three transferable results.

First, **the "measure the function" paradigm has a structural blind spot at the
serialization boundary**, and it is invisible to every harness on the inside.

Second, **a one-sided exposure check is not a specification.** Confinement is
satisfied by returning `{}`; sufficiency by returning the raw document. Only the
pair constrains a projection, and the pair is what makes the audit safe to gate
CI on — a developer cannot pass it by deleting fields.

Third, and most transferable: **auditing the projection is not enough, because
the projection can be correct and not called.** W-M1 reverts one route to
`res.json(doc)` and the projection stays perfect. The wiring property is what
fails, and it is the cheapest of the three to implement.

**Limitations.** The audit is STATIC — the projection is exercised in process
over a fixture; no HTTP request is made and no server is started. It covers the
four scheme and history surfaces; the user, auth, notification and chat routes
have their own projections and their own tests. It cannot tell you whether the
*classification* is right: the policy table is a stated judgement read from the
model files' documentation, not a measurement. Sufficiency is judged from static
property reads, so a field reached by computed access (`obj[key]`) would not be
seen.

---

## Q. Measured results

| | |
|---|---|
| routes declared / unauthenticated | **20 / 7** |
| surfaces audited | **4** |
| fields a `SchemeHistory` row can carry | **16** (9 internal) |
| fields a `Scheme` row can carry | **39** (8 internal) |
| **before the fix** | **EXPOSED — 50 internal fields across 4 endpoints** |
| **after the fix** | **CONFINED — 0 leaks, 0 missing, 0 undeclared, 0 unprojected** |
| internal fields withheld | 9/9 and 8/8 on every surface |
| frontend fields still satisfied | 7, 5, 8 and 15 per surface |
| prior harnesses under the defect | O–V all pass, suite **923/923** |

All MEASURED, on a SYNTHETIC fixture built to mirror what
`policyPipeline.persistStatus` writes. Nothing DERIVED, nothing SIMULATED.
NOT MEASURED: real HTTP responses, real Atlas data, real provider errors.

---

## R. Limitations

**MEASURED** — the audit result before and after, the mutation outcomes, all
suite and script results, the route inventory, the prior-harness blindness.
**SYNTHETIC** — the fixtures. Real rows will carry different values; they carry
the same *fields*, which is what the audit examines.
**NOT MEASURED** — real Jest (`npm install` → HTTP 403 here), frontend build and
lint, browser behaviour, Atlas, live HTTP responses, and whether a real
deployment's provider errors are worse than the fixture's. Nothing here is
converted from NOT MEASURED to 0.

---

## S. Regression results

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

`npm run test:mini` → **957 passed, 0 failed, 1 suite skipped** (`api.test.js`,
which needs `supertest`). Every prior phase's headline figure is unchanged.

---

## T. File-integrity reconciliation

```
H→V : 193 files      H→W : 198 files
Added : 5      Modified : 18      Removed : 0      Missing : 0
```

**Added (5):** `src/services/publicProjection.js`,
`src/evaluation/responseSurface.js`, `scripts/runResponseSurfaceAudit.js`,
`tests/responseSurface.test.js`, `docs/PHASE_W_REPORT.md`.

**Modified (18):** `src/routes/schemes.js`, `package.json`, `README.md`,
`MERGE_MANIFEST.md`, `RUN_FINAL.md`, `PROJECT_AUDIT.md`, and the phase-chain
line in the twelve historical phase reports.

---

## U. Current phase chain

```
BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y
```

---

## V. Final status

Phase W complete. One cumulative ZIP, `final_project_H_to_W.zip`, verified from
a fresh extraction. **Phase X not started.**

### Reproducibility

```bash
npm run evaluate:exposure
npm run evaluate:exposure -- --verbose      # what is withheld, and why; route inventory
npm run evaluate:exposure -- --out w.json
```

Deterministic: fixed fixtures, static parsing, no sampling, no seed. Exits
non-zero on a leak, a missing field, an unclassified field, or a route that does
not call its projection — all four are defects, not settings, so CI can gate on
it.

---

*Phase W complete. At the time this report was produced, Phase X had not started.*
