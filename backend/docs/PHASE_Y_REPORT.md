# PHASE Y — The Index Contract, Made Executable

**Scope: Phase Y only.** At the time this Phase Y report was produced, Phase Z had not started.

---

## 1. Verdict

**COMPLETE.** A real defect was found in the operational contract between the
code and the database it depends on, reproduced, root-caused, fixed
structurally, regression-tested and mutation-tested. **1,006 miniJest tests
pass, 0 fail** — a figure measured on this tree, not carried forward. All 15
evaluation and verification scripts exit 0 from a fresh extraction. 0 files
removed.

---

## 2. Official specification

**NO OFFICIAL PHASE Y SPECIFICATION FOUND.**

Searched the whole H→X tree: `README.md`, `MERGE_MANIFEST.md`, `RUN_FINAL.md`,
`PROJECT_AUDIT.md`, `NOTIFICATION_ARCHITECTURE.md`, `INDEX_VERIFICATION.md`,
`CHANGES.md`, all 14 phase reports, every evaluation document, all source
comments, all tests, every deferred-work note. The only occurrences of "Phase Y"
are the two forward-looking lines in `PHASE_X_REPORT.md` saying it had not
started.

Phase Y was therefore chosen defect-first, as S, T, U, V, W and X were.

---

## 3. Objective

Verify the contract between the code and the database it depends on — the only
correctness guarantee in this system that no test in this repository can
exercise, because the mechanism is not in the process.

---

## 4. Why Phase Y was necessary

Four production paths treat a MongoDB duplicate-key error as "already done" and
carry on:

| file | collection | what breaks without the constraint |
|---|---|---|
| `notificationService.js` | `notifications` | a second in-app notification for the same change |
| `notifier.js` | `notificationlogs` | a second email for the same scheme version |
| `recommendationPropagation.js` | `recommendationhistories` | a second history row for the same change |
| `ragIndexer.js` | `schemechunks` | a second copy of a chunk, which every search then returns twice |

Each is exactly-once **only because a unique index rejects the second insert**.
The services say so, and say why the pre-check cannot be the guarantee:

> *"The pre-check avoids the write on the common replay path. The duplicate-key
> catch is what actually guarantees uniqueness, because two concurrent runs can
> both pass a pre-check before either inserts — only the unique index …"*

So the guarantee does not live in the code. It lives in the database. And a
Mongoose `unique: true` is a **request**, not a fact: indexes build lazily in
the background, `autoIndex` is commonly disabled in production, and a unique
build over a collection that already contains duplicates **fails silently and
leaves no constraint at all**.

**Q through X all verify code.** No test in this repository can verify this one,
which is exactly why it needed a phase of its own — and why the only honest
answer to "does the constraint hold?" without a database is NOT MEASURED.

### Composition check, as the brief asks

Can every phase pass while the system is still wrong? **Yes, and it was.** With
the defect present on the pristine H→X tree:

| O | P | Q | R | S | T | U | V | W | X | full suite |
|---|---|---|---|---|---|---|---|---|---|---|
| ran | ran | **SOUND** | **MEASURED** | ran | **STABLE** | **AGREE** | **COMPLETE** | **CONFINED** | **AGREE** | **981/981** |

---

## 5. Audit performed

Authentication, eligibility, policy change, ranking, notifications, scheduler,
RAG, conversational AI, API, frontend, database, observability, configuration
and evaluation — the full list in the brief.

Checked and found **sound**, recorded so the absence of a finding is not mistaken
for an absence of looking:

- `notifier` re-exports the matcher's own functions rather than redefining them
  (verified by identity: `notifier.evaluateEligibility === matcher.evaluateEligibility`).
- Every code path relying on a duplicate-key error **does** have a `unique: true`
  declaration behind it — all four. Y.2 passes. There is no missing-constraint
  defect, and this report does not manufacture one.
- The notification a user receives and the `RecommendationHistory` row are built
  from the same record, so they cannot contradict each other by construction.
- `db.js` redacts credentials from both connection logs and driver errors.
- The K0 authorization model and the Phase W response projections are intact.

The finding was in the one place nothing executable was looking.

---

## 6. Defect found

**The operator's index checklist had drifted from the schemas, and the three
indexes it omitted included the constraints behind three of the four exactly-once
guarantees.**

`INDEX_VERIFICATION.md` is the document that tells a human what to verify against
the real cluster. It is the *only* control on whether the declared constraints
actually exist. It listed **8** indexes. The models declare **47**.

Of the six declared UNIQUE indexes, **three were absent from the checklist
entirely**:

| missing from the checklist | what depends on it |
|---|---|
| `notifications.uniq_user_scheme_change_channel` | the entire exactly-once guarantee for the in-app inbox |
| `schemechunks.chunkId_1` | a re-index not duplicating every chunk |
| `schemes.schemeId_1` | scheme identity — the comparator looks every scheme up by it |

An operator following the page would have run `getIndexes()` on four collections
out of seven, confirmed the eight rows listed, and reported success — while the
`notifications` collection, the whole Phase L inbox, went unexamined.

---

## 7. Reproduction

```
$ node scripts/runIndexContract.js       # against the pristine H→X tree

run status : INCONSISTENT

collections            : 7
indexes declared       : 47   (6 unique)
indexes documented     : 8

findings: { UNDOCUMENTED: 39 }

UNIQUE indexes absent from the checklist:
  notifications.uniq_user_scheme_change_channel
  schemes.schemeId_1
  schemechunks.chunkId_1
```

The documented procedure also inspected only four collections:

```js
db.recommendationhistories.getIndexes()
db.schemehistories.getIndexes()
db.notificationlogs.getIndexes()
db.users.getIndexes()
```

`notifications`, `schemes` and `schemechunks` are not there.

---

## 8. Root cause

**A hand-maintained document describing generated structure.**

The checklist was written when the tree ended around Phase K/L and was correct
then. Phase J added the propagation statuses, Phase L added the `notifications`
collection and its unique index, Phase M added `schemechunks` and the RAG sweep
index. Each phase added indexes to a schema; none updated the page, because
nothing connected the two. A markdown table cannot fail.

The second-order cause is the one that makes it dangerous rather than untidy:
**this document is the last line of defence for a guarantee that has no other
check.** A stale test is caught by the suite. A stale checklist is caught by
nothing, and it fails in the direction that produces a false "verified".

---

## 9. Fix

**Make the contract executable**, as the brief prescribes for configuration
defects — not merely correct the table, which would rot again.

`src/evaluation/indexContract.js` compares three inputs:

| input | source |
|---|---|
| **declared** | the Mongoose schema definitions (`schema.obj`, `schema.indexes_`) |
| **documented** | parsed out of `INDEX_VERIFICATION.md`'s table |
| **required** | scanned from the production code that catches a duplicate-key error |

and asserts three properties:

- **Y.1 DOCUMENTED** — every declared index is on the checklist, and the
  checklist asks for nothing the schemas do not declare.
- **Y.2 BACKED** — every uniqueness the code depends on has a `unique: true`
  declaration behind it.
- **Y.3 LIVE** — with `--live` and a reachable `MONGODB_URI`, the declared
  indexes exist, are unique where required, and have finished building.

`INDEX_VERIFICATION.md` was regenerated from the schemas (47 rows, unique flags
carried through), its procedure extended to all seven collections, and its
"what to check" step now names all six unique indexes rather than one. The page
carries a note explaining what drifted and that the check now guards it.

`schema.indexes()` is deliberately **not** used: it does not exist on the
sandbox stub, so an audit built on it would enumerate nothing in the one
environment where it can be run offline — the same trap Phase W avoided with
`schema.paths`.

### Why Y.2's input is the independent one

Y.1 compares documentation against declarations — both artifacts a developer
edits. Y.2's requirement is read from **the code that DEPENDS on a constraint**,
not from the code that declares one. Deleting `unique: true` from a schema *and*
from the checklist together still leaves `notificationService.js` catching
E11000 and calling it "already done", so Y.2 still fails. That is the anchor
outside the two things being compared.

---

## 10. Tests

`tests/indexContract.test.js` — 25 tests in five groups: the checklist matches
the schemas (including the three unique indexes by name); the independent anchor
(the dependency table still describes the code, and no *fifth* service depends
on a constraint without being recorded); reading the schemas (all seven
collections, field-level and compound, no stub-incompatible API, Mongoose's
collection naming asserted against every real model); the live check's honesty;
and falsifiability.

---

## 11. Mutation testing

Fourteen mutations — six of production, eight of the evaluator. **All fourteen
killed.**

| mutation | audit | tests failed | result |
|---|---|---|---|
| Y-M1 unique dropped from the in-app notification index | **INCONSISTENT** | 6 | killed |
| Y-M2 unique dropped from the propagation idempotency index | **INCONSISTENT** | 4 | killed |
| Y-M3 `chunkId` stops being unique | **INCONSISTENT** | 5 | killed |
| Y-M4 a new index added to a model but not the checklist | **INCONSISTENT** | 2 | killed |
| Y-M5 the checklist loses the inbox unique row | **INCONSISTENT** | 4 | killed |
| Y-M6 the row stays but the unique marking is dropped | CONSISTENT | 2 | killed |
| Y-M7 *(evaluator)* field-level declarations ignored | **INCONSISTENT** | 8 | killed |
| Y-M8 *(evaluator)* compound declarations ignored | **INCONSISTENT** | 10 | killed |
| Y-M9 *(evaluator)* the undocumented check never fires | CONSISTENT | 1 | killed |
| Y-M10 *(evaluator)* a non-unique declaration is accepted | CONSISTENT | 2 | killed |
| Y-M11 *(evaluator)* an unmeasured live read treated as measured | **INCONSISTENT** | 2 | killed |
| Y-M12 *(evaluator)* `liveIndexes` claims MEASURED with no database | CONSISTENT | 1 | killed |
| Y-M13 *(evaluator)* the live check ignores a missing unique flag | CONSISTENT | 1 | killed |
| Y-M14 *(evaluator)* a dependency silently dropped from the table | CONSISTENT | 4 | killed |

**Y-M10 survived the first pass.** Disabling the UNBACKED branch changed
nothing, because with every model correct that branch is unreachable — the tests
asserted the finding list was empty (trivially true) and re-derived the match
themselves. **This is the third time this project has hit the same shape**
(Phase W's W-M15, Phase X's X-M1): a check on a branch that only correct code
never reaches. Fixed the same way: an injection seam. `runIndexContract({
declared })` lets a test hand the audit a schema set with the unique flag
stripped, and two new tests assert UNBACKED fires — one for a non-unique
declaration, one for no declaration at all.

**Y-M14 first appeared to survive and did not.** The mutation
(`Object.freeze([].concat([]) && [...])`) evaluated to the original array — an
**invalid mutation**, not a survivor. Rewritten to point a dependency at a file
that does not exist; it is then killed by four tests. Recorded rather than
quietly replaced, because a mutation that does not mutate is a silent false
negative in the mutation testing itself.

**Y-M6 is worth noting** for what it says about the split: dropping the *unique
marking* from a checklist row leaves the audit CONSISTENT (the row is present,
so Y.1 is satisfied) and is caught by the test that cross-checks declared-unique
against documented-unique. The audit and the tests cover different halves.

---

## 12. Backend impact

One file added to `src/evaluation/`, one script, one test file, one document
regenerated, one `package.json` entry pair. **No production code path changed** —
no model, no route, no service, no scheduler, no middleware. All `.js` parse
under `node --check`. The route inventory is unchanged at 20 routes.

---

## 13. Frontend impact

**None. No frontend file was modified**, and none needed to be: this phase
concerns the database contract. `npm run build` and `npm run lint` are
**NOT EXECUTED** — `npm install` returns HTTP 403 in this sandbox, so `vite` and
`oxlint` are not installed. **No browser verification was performed.**

---

## 14. Database impact

**No schema, index, migration or query was changed.** Phase Y adds no index and
removes none; it verifies that what is declared is documented and that what the
code depends on is declared. Existing data is untouched. `MONGODB_URI`
compatibility is unchanged, and `evaluate:indexes:live` opens a read-only
connection (`listCollections`, `indexes()`) and disconnects.

**Operationally**, the phase makes one thing possible that was not: an operator
can now run one command against the real cluster and get a per-index verdict,
instead of following a prose procedure against a stale table.

---

## 15. Security impact

**Nothing weakened.** JWT authentication, `requireAuth` / `requireSelfOrAdmin` /
`requireAdmin`, IDOR protection, user isolation, the Phase W response
projections, the Phase P grounding and contradiction guards, rate limits, CORS,
helmet and secret handling are all untouched — no production file changed.

The live check inherits `db.js`'s discipline in spirit: it reports connection
failures by message and never echoes the connection string. `evaluate:exposure`
still reports CONFINED.

There is a security-adjacent *improvement*: a silently absent unique index on
`notifications` would let a retried cycle deliver duplicate notifications, which
is an integrity failure in the audit trail this project treats as evidence.

---

## 16. Research contribution

**Problem.** Systems increasingly place correctness guarantees outside the
process — in database constraints, message-broker semantics, scheduler
configuration. Test suites verify the code; the guarantee is elsewhere, and the
usual substitute is a written checklist. Checklists cannot fail, so they drift,
and they drift in the direction that produces a false "verified".

**Research question.** Can such an out-of-process guarantee be checked without a
database — and can the check be independent of the declarations it is checking?

**Method.** Triangulate three inputs. Declared (schemas), documented
(checklist), and required (**the code that depends on the constraint**). The
third is the anchor: it is derived from consumption rather than declaration, so
deleting a constraint from both the schema and the document still leaves the
dependency behind. Whatever is not decidable in process — does the index
actually exist on the cluster — is reported as NOT MEASURED with the exact
reason, never as absent and never as fine.

**Finding.** A checklist that was the sole control on four exactly-once
guarantees covered 8 of 47 indexes and omitted three of the six unique ones,
including the constraint behind the entire in-app inbox. Fourteen evaluation
harnesses and 981 tests passed throughout, correctly: none of them can reach a
database index.

**Contribution.** Three transferable results.

First, **the artifact that verifies an out-of-process guarantee must itself be
verified.** A checklist is code that never runs. Deriving it from the schemas
and failing the build on drift costs a few dozen lines and removes an entire
class of false assurance.

Second, **"depends on it" is a better independence anchor than "declares it".**
Both a schema and its documentation are edited by the same person in the same
change; the code that consumes a constraint usually is not.

Third — and this is the third consecutive phase to produce it — **a check whose
branch only incorrect code reaches will survive being deleted.** W-M15, X-M1 and
Y-M10 are the same finding in three different subsystems. The remedy each time
was an injection seam that lets a test hand the evaluator something broken. That
regularity is itself a result: mutation testing an evaluator is not optional
polish, because the unreachable-branch failure is invisible to every other
technique here.

**Limitations.** Y.1 and Y.2 are static: they compare code, documentation and
code. **Y.3 — the only property that can confirm the guarantee actually holds —
is NOT MEASURED in this environment.** Nothing here demonstrates that two racing
inserts collide; that is a property of a real cluster.

---

## 17. Measurements

| | |
|---|---|
| collections | **7** |
| indexes declared by the models | **47** (**6** unique) |
| **before**: indexes on the checklist | **8** |
| **before**: run status | **INCONSISTENT — 39 undocumented** |
| **before**: unique indexes omitted | **3 of 6** — inbox, scheme identity, RAG chunks |
| **after**: indexes on the checklist | **47** |
| **after**: run status | **CONSISTENT — 0 findings** |
| constraint dependencies found in production code | **4**, all backed |
| prior harnesses under the defect | O–X all pass, suite **981/981** |
| mutants killed | **14/14** (one after adding a seam; one invalid mutation rewritten) |
| **miniJest on this tree** | **1,006 passed, 0 failed, 1 suite skipped** |

All MEASURED except where stated. **Y.3 is NOT MEASURED** — no database was
reachable. It is not reported as 0 and not reported as passing.

---

## 18. Limitations

**MEASURED** — every count above, the before/after audit, all 14 mutation
outcomes, all suite and script results, the prior-phase blindness table.
**DERIVED** — nothing new in Y.
**SYNTHETIC** — the fabricated live-cluster responses used in the falsifiability
tests. They exercise the comparison logic; they are not readings from a database
and are never reported as such.
**SIMULATED** — none.
**NOT MEASURED** — **whether any declared index exists on a real cluster**; real
Jest; frontend build and lint; browser behaviour; Atlas; query plans (an index
existing is not an index being used); whether the declared index set is the
right one for the workload; and concurrency itself.

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
| T | **PASS** — STABLE, 0 unstable |
| U | **PASS** — AGREE, 306,180 verdicts, 0 disagreements |
| V | **PASS** — COMPLETE, 0 missed |
| W | **PASS** — CONFINED, 0 leaks |
| X | **PASS** — AGREE, 24 comparisons, 0 disagreements |
| Y | **PASS** — CONSISTENT, 47/47 documented, 4/4 dependencies backed |

`npm run test:mini` → **1,006 passed, 0 failed, 1 suite skipped**
(`api.test.js`, which needs `supertest`). Every prior phase's headline figure is
unchanged.

---

## 20. File integrity

```
H→X : 203 files      H→Y : 207 files
Added : 4      Modified : 20      Removed : 0      Missing : 0
```

**Added:** `src/evaluation/indexContract.js`, `scripts/runIndexContract.js`,
`tests/indexContract.test.js`, `docs/PHASE_Y_REPORT.md`.

---

## 21. Final phase chain

```
BASE → H → I → J → K0 → K → L/L.1–L.8 → M → N → O → P → Q → R → S → T → U → V → W → X → Y
```

### Reproducibility

```bash
npm run evaluate:indexes                  # Y.1 and Y.2, offline
npm run evaluate:indexes -- --verbose     # every declared index, every finding
npm run evaluate:indexes -- --print-table  # the checklist the schemas imply
MONGODB_URI=... npm run evaluate:indexes:live   # adds Y.3
```

Deterministic offline: the same schemas and the same checklist give the same
answer, no sampling, no seed. Exits non-zero on drift, on an unbacked
dependency, or on a live index that is missing, non-unique or still building.

---

*Phase Y complete. At the time this report was produced, Phase Z had not started.*
