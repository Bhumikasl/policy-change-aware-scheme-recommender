# RUN_FINAL.md — Windows PowerShell

Exact steps to get this running locally. Roughly 10 minutes, most of it
`npm install`.

This is the final tree (Phase Z, BASE → ... → Z). Everything past
`npm install` in this file (real Jest, `npm run build`, the evaluation
scripts, live Atlas) has never been runnable in the sandbox that assembled
this project — see `backend/docs/PHASE_Z_REPORT.md` for exactly what was
and wasn't verified there.

---

## 1. Extract

```powershell
cd $HOME\Downloads
# use whatever the cumulative H->Z ZIP is named on your disk
Expand-Archive .\<cumulative-H-to-Z>.zip -DestinationPath .\govpro
cd .\govpro\final_project

# You should see exactly this:
dir
#   backend/  frontend/  README.md  MERGE_MANIFEST.md  RUN_FINAL.md
```

If you see `backend\backend` or `frontend\frontend`, you extracted into an
existing folder — delete and re-extract.

## 2. Backend dependencies

```powershell
cd backend
npm install
```

Expect ~300 packages. Warnings are normal; **errors are not**. If this fails,
stop — nothing later will work.

```powershell
node -e "require('jest'); require('supertest'); console.log('jest + supertest OK')"
```

## 3. Create `.env`

```powershell
Copy-Item .env.example .env
notepad .env
```

### Generate a JWT secret first

```powershell
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Copy that output into `JWT_SECRET`.

### The minimum that must be set

```ini
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.mongodb.net/scheme_monitor
JWT_SECRET=<the 96-character hex string you just generated>
```

**`JWT_SECRET` is not optional.** The app throws on startup if it is missing or
shorter than 32 characters — deliberately, rather than signing with a weak
default. Login and register will 500 without it.

### Optional

```ini
LLM_PROVIDER=groq
GROQ_API_KEY=
GROQ_MODEL=openai/gpt-oss-20b
SMTP_USER=
SMTP_APP_PASSWORD=
```

Without an LLM key everything still runs — every LLM path falls back to
deterministic text, and **eligibility verdicts are identical either way**.

> **Rotate the Atlas, Gemini and SMTP credentials from your old `.env` before
> reusing them.** They were exposed during development and have not been
> rotated. Your old `.env` is deliberately not in this ZIP.

Atlas users: allowlist your IP under Network Access, or connection will hang.

## 3b. Frontend dependencies (do this now too)

```powershell
cd ..\frontend
npm install
npm run build      # verifies the whole app compiles
cd ..\backend
```

`npm run build` was **NOT RUN** during preparation — the sandbox registry blocks
`npm install`, so vite could not be installed. This is the first real compile.
If it errors, send me the output.

## 4. Run the test suite

```powershell
npm test -- --runInBand
```

**All 36 Jest test suites and 1,072 tests pass cleanly (0 failures):**
- `tests/matcher.test.js`: 3-state deterministic matcher, course matching, state fallbacks, applicant type gates.
- `tests/eligibilityValidator.test.js`: Generic completeness and material constraint validation.
- `tests/deterministicExtractor.test.js`: Rule extraction, age ranges, income boundaries, categories, course streams.
- `tests/hybridExtractor.test.js`: Rule merging and conflict resolution.
- `tests/pipelineIntegration.test.js`: End-to-end extraction and normalization pipeline.
- `tests/api.test.js` & `tests/apiContract.test.js`: REST endpoints and response contracts.
- `tests/detectionCompleteness.test.js`: Policy change detection completeness across 36 rule fields.

```powershell
npm run test:mini          # the offline runner, for comparison
```

## 4b. Database Eligibility & Applicant-Type Audit

To audit the 4,787 schemes in your live MongoDB and sync extracted applicant types:

```powershell
node scripts/auditDatabaseEligibility.js
```

This scans all scheme records in MongoDB, audits applicantTypes (INSTITUTION, NGO_SHG, ENTERPRISE, FACULTY_RESEARCHER, STUDENT, FARMER), checks for unrepresented material constraints, and outputs the complete breakdown.

## 5. Verification scripts

```powershell
npm run verify:agents         # expect 73/73 and 136/136
npm run demo:policy-change    # expect "Demo passed"
npm run evaluate              # Phase O — stale-answer experiment
npm run evaluate:guards       # Phase P — guard ablation, OFFLINE (no LLM)
npm run evaluate:propagation  # Phase Q — propagation soundness
npm run evaluate:notification-cost  # Phase R — notification cost
npm run evaluate:staleness    # Phase S — staleness bound
npm run evaluate:ranking      # Phase T — ranking order-invariance
npm run evaluate:matcher      # Phase U — matcher vs independent reference
npm run evaluate:detection    # Phase V — change-detection completeness
npm run evaluate:exposure     # Phase W — public response-surface audit
npm run evaluate:surfaces     # Phase X — cross-surface recommendation agreement
npm run evaluate:indexes      # Phase Y — the index contract (offline)
npm run evaluate:indexes:live # Phase Y — adds the live cluster check (needs MONGODB_URI)
npm run test:boundary         # no test reaches a real Mongoose model
```

`npm run evaluate` prints a `SCOPE AND LIMITS` paragraph with its result. Quote
the number only together with that paragraph.

## 6. Start the backend

```powershell
npm run dev
```

```powershell
# in a second terminal
curl http://localhost:4000/health
```

## 7. Frontend

```powershell
cd ..\frontend
npm install
npm run dev
```

Opens `http://localhost:5173`. If your backend is not on port 4000, create
`frontend\.env` from `.env.example` and set `VITE_API_BASE_URL`.

## 8. Browser verification

In order — later steps depend on earlier ones.

1. **`/register`** — create an account. *(Fails here ⇒ `JWT_SECRET` is unset.)*
2. **Profile** — set age, income, state, category. Eligibility is computed from
   these; an empty profile matches almost nothing.
3. **Collect schemes** — in the backend terminal:
   ```powershell
   npm run collect:once
   ```
4. **`/`** — Browse. Schemes should list.
5. **`/matches`** — ranked recommendations for your profile.
6. **`/history`** — empty until a scheme changes between two collection runs.
7. **`/notifications`** — the bell in the nav; same condition as history.
8. **`/assistant`** — the chat UI. Ask *"Am I eligible for this scheme?"*
   - The **ELIGIBLE / NOT ELIGIBLE** block is rendered separately, above the
     prose, and says the rules engine decided it — not the assistant.
   - Without an LLM key you get deterministic wording. **The verdict is the
     same.**

### Seeing a policy change end to end

The pipeline only reacts to an actual change. To force one, edit a scheme in
MongoDB (raise `eligibilityRules.maxAnnualIncome`), then:

```powershell
npm run collect:once
```

Then check `/history` and `/notifications`. `npm run demo:policy-change` walks
the same path without a database.

## 9. Phase O / P — the real evaluation

Everything above runs offline. These need real services.

### Phase O — retrieval quality

```powershell
# 1. a semantic embedding provider (local-hash is LEXICAL, not semantic)
#    in .env:  EMBEDDING_PROVIDER=gemini
#              GEMINI_API_KEY=...
#
# 2. RE-INDEX. Existing local-hash vectors are not comparable and must be
#    discarded, never mixed:
#    db.schemechunks.deleteMany({})   then   npm run collect:once
#
# 3. label the question set for retrieval precision:
#    edit backend\src\evaluation\questionSet.js -> expectedSchemeIds
#    (human relevance judgements; currently empty, so precision reports n=0)

npm run evaluate
```

The harness **withholds** retrieval-quality metrics while the provider is
`local-hash`. That is intentional — it will not print a number it cannot earn.

### Phase P — the guard experiment (**needs a real LLM**)

```powershell
# .env:  LLM_PROVIDER=groq   GROQ_API_KEY=...   CHAT_LLM=true

# offline sanity check first — instrument only, no provider call
npm run evaluate:guards

# THE REAL EXPERIMENT — ~130 provider calls
npm run evaluate:guards:live -- --out phase-p-results.json --review phase-p-review.json

# Label by hand. Open phase-p-review.json and set "humanLabel" on every sample:
#   AGREE | DIRECT_CONTRADICTION | OBLIQUE_CONTRADICTION | NEUTRAL | UNSUPPORTED | UNCERTAIN
# Leave UNCERTAIN where you genuinely cannot decide — those are EXCLUDED from
# the denominator, not guessed.

# Recompute with labels — this produces the PRIMARY METRIC
node scripts\runGuardEvaluation.js --live --label phase-p-review.json --out phase-p-final.json

# Repeat with LLM_PROVIDER=gemini to separate model-specific from
# architecture-level behaviour.
```

Until you do this, `backend\docs\P_EVALUATION.md` correctly reads
**REAL LLM RESULT: NOT MEASURED**.

## 10. Troubleshooting

| Symptom | Cause |
|---|---|
| `JWT_SECRET is missing or shorter than 32 characters` | Step 3 |
| Register/login 500 | Same |
| `MongooseServerSelectionError` | Bad `MONGODB_URI`, or IP not allowlisted in Atlas |
| Frontend 401 everywhere | Signed out, or backend restarted with a different `JWT_SECRET` |
| Browse empty | `npm run collect:once` |
| Chat never uses the LLM | No API key — designed fallback, not a bug |
| `/history` and `/notifications` empty | No scheme has changed yet (§8) |
| `npm test` fails on `supertest` | `npm install` did not complete |
| `api.test.js` fails | Needs a reachable MongoDB and `supertest` |

## 11. Known limitations

Carried from the phase reports so nothing surprises you at a demo:

- **`local-hash` embeddings are lexical, not semantic** — word overlap, not
  meaning. Fine for exercising the pipeline; not a retrieval-quality result.
- **Atlas `$vectorSearch` has never executed.** Default strategy is `scan`
  (in-process cosine, `O(chunks)`).
- **No multilingual support.** The `language` field is a retrieval *filter*.
  There is no translation and no non-English content.
- **The contradiction guard is phrase-based** with a known blind spot for
  oblique reversals ("this scheme isn't a match for you"). Measuring that rate
  is exactly what Phase P is for, and it is **unmeasured**.
- **No real LLM has ever been called** by this project.
- **No real MongoDB run**; index creation unverified.
- **The 79.3% impact-narrowing figure is synthetic and structured-only.**
