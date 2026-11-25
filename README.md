# Dynamic Policy-Aware Government Scheme Monitoring & Recommendation System

An intelligent, policy-aware system that monitors changes in government schemes, evaluates their impact on citizens' eligibility, and updates personalized recommendations and notifications automatically.

The system combines rule-based eligibility matching, policy change detection, targeted impact analysis, recommendation propagation, notifications, and Retrieval-Augmented Generation (RAG) to help users stay informed about government welfare schemes.

---

## 1. Project Overview

Government schemes frequently change their eligibility criteria, income limits, age restrictions, benefits, and other policy conditions. Citizens may not always be aware of these changes, which can result in missed opportunities or outdated eligibility information.

This project addresses that problem by developing an automated system that:

- Monitors changes in government scheme policies.
- Detects and classifies changes between scheme versions.
- Identifies users potentially affected by policy changes.
- Updates eligibility recommendations.
- Notifies users when their eligibility status changes.
- Provides explanations for recommendation changes.
- Supports conversational queries using a RAG-based assistant.

The primary objective is to reduce unnecessary processing while maintaining reliable policy-impact detection and consistent recommendations.

## 2. Key Features

### Policy Monitoring and Change Detection
- Collects and maintains government scheme information.
- Detects changes between different scheme versions.
- Normalizes policy data before comparison.
- Classifies material and non-material policy changes.

### Targeted Policy Impact Analysis
- Identifies potentially affected users using targeted candidate selection.
- Avoids unnecessary full-population re-evaluation where safe.
- Uses a full-scan fallback for policy changes that cannot be safely narrowed.
- Maintains an audit trail of policy-impact evaluations.

### Eligibility Matching and Recommendation Propagation
- Evaluates user profiles against scheme eligibility criteria.
- Updates recommendations when policy conditions change.
- Maintains recommendation history.
- Tracks newly eligible and no-longer-eligible users.

### Intelligent Notifications
- Sends notifications when eligibility changes.
- Supports notification deduplication and user preferences.
- Implements retry handling and notification lifecycle management.
- Provides an in-app notification inbox.

### Explanation Agent
- Generates explanations for eligibility and recommendation changes.
- Grounds explanations in available scheme and user information.
- Includes safeguards against unsupported or contradictory responses.

### RAG-Based Conversational Assistant
- Indexes scheme information into retrievable chunks.
- Supports version-aware retrieval.
- Provides conversational access to scheme information.
- Supports deterministic fallback responses when an LLM provider is unavailable.

### Evaluation and Verification
The project includes dedicated evaluation phases for:
- Retrieval and stale-answer behaviour.
- Adversarial guard evaluation.
- Policy propagation soundness.
- Notification cost comparison.
- Recommendation staleness.
- Ranking order-invariance.
- Eligibility matcher verification.
- Policy change-detection completeness.
- API response-surface security.
- Cross-surface recommendation agreement.
- Database index-contract verification.

## 3. Technology Stack

| Component | Technologies |
|---|---|
| Frontend | React, Vite |
| Backend | Node.js, Express.js |
| Database | MongoDB, Mongoose |
| Authentication | JWT |
| Scheduling | node-cron |
| AI / LLM | Groq or Gemini |
| Retrieval | RAG, vector embeddings |
| Testing | Jest, custom offline miniJest harness |
| Logging | Winston |

## 4. Project Architecture

The application follows a frontend-backend architecture.

```text
                 USER
                   |
                   v
          React + Vite Frontend
                   |
                   v
             Express API
                   |
          +--------+--------+
          |                 |
          v                 v
    Authentication     User Profiles
          |                 |
          +--------+--------+
                   |
                   v
          Policy Monitoring
                   |
                   v
          Policy Change Agent
                   |
                   v
          Policy Impact Agent
                   |
                   v
        Targeted Candidate Selection
                   |
                   v
       Eligibility Re-evaluation
                   |
                   v
      Recommendation Propagation
                   |
          +--------+--------+
          |                 |
          v                 v
    Notifications      Audit History
          |
          v
     User Notification Inbox

                   |
                   v
          RAG / Conversational
                Assistant
```

MongoDB stores user profiles, scheme information, policy versions, recommendations, notification records, and related application data.

## 5. Project Structure

```text
final_project/
|
|-- backend/
|   |-- src/
|   |   |-- agents/
|   |   |-- models/
|   |   |-- services/
|   |   |-- evaluation/
|   |   |-- scheduler/
|   |   |-- routes/
|   |   |-- middleware/
|   |
|   |-- scripts/
|   |-- tests/
|   |-- docs/
|   |-- .env.example
|   |-- package.json
|
|-- frontend/
|   |-- src/
|   |   |-- auth/
|   |   |-- components/
|   |   |-- pages/
|   |   |-- notifications/
|   |   |-- chat/
|   |
|   |-- package.json
|
|-- README.md
```

The repository contains a merged implementation. Individual development phases are documented in `backend/docs/`.

## 6. Development Phases

The project was developed incrementally through the following phases:

| Phase | Implementation |
|---|---|
| BASE | Scheme collection, eligibility matcher, APIs and browsing interface |
| H | Scheme version detection, normalization and comparison |
| I | Policy Change Agent and Policy Impact Agent |
| J | Recommendation propagation and audit trail |
| K0 | JWT authentication and ownership protection |
| K | Grounded Explanation Agent |
| L / L.1–L.8 | Notification deduplication, preferences, retries and inbox |
| M | RAG indexing and version-aware retrieval |
| N | Conversational agent and chat interface |
| O | Evaluation harness for stale answers and retrieval |
| P | Adversarial guard evaluation and ablation |
| Q | Policy propagation soundness |
| R | Notification cost evaluation |
| S | Recommendation staleness bound |
| T | Ranking order-invariance |
| U | Independent eligibility matcher verification |
| V | Policy change-detection completeness |
| W | Public API response-surface audit |
| X | Cross-surface recommendation agreement |
| Y | Database index-contract verification |
| Z | Final release audit |

Detailed reports and evaluation findings are available in `backend/docs/`.

## 7. Installation and Setup

### Prerequisites

- Node.js 18 or above (Node.js 20 LTS recommended).
- MongoDB Atlas account or local MongoDB installation.
- Groq or Gemini API key (optional, for LLM features).

### Step 1: Clone the Repository

```bash
git clone <YOUR_GITHUB_REPOSITORY_URL>
cd <YOUR_REPOSITORY_FOLDER>
```

### Step 2: Backend Setup

```bash
cd backend
npm install
```

Create your environment file:

```bash
cp .env.example .env
```

On Windows PowerShell:

```powershell
Copy-Item .env.example .env
```

Configure the required environment variables:

```env
MONGODB_URI=mongodb+srv://USER:PASSWORD@cluster.mongodb.net/scheme_monitor

JWT_SECRET=your_secure_random_secret

LLM_PROVIDER=groq
GROQ_API_KEY=
```

Generate a secure JWT secret using:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

Update the `.env` file with your actual credentials.

**Important:** Never upload `.env`, API keys, database passwords, or other secrets to GitHub. If credentials were previously exposed, rotate them before reuse.

### Step 3: Start the Backend

```bash
npm run dev
```

The backend runs at:

```text
http://localhost:4000
```

Verify the backend:

```text
http://localhost:4000/health
```

### Step 4: Frontend Setup

Open another terminal:

```bash
cd frontend
npm install
npm run dev
```

The frontend runs at:

```text
http://localhost:5173
```

If the backend uses a different port, configure `VITE_API_BASE_URL` in the frontend environment file.

## 8. First-Time Application Usage

1. Open the frontend application.
2. Register a new account.
3. Complete your profile with relevant information such as age, income, state and category.
4. Collect scheme information using the backend collection script.
5. Browse available government schemes.
6. View personalized eligibility matches.
7. Explore recommendation history.
8. Check notifications when policy changes affect eligibility.
9. Interact with the conversational assistant.

To collect schemes manually:

```bash
npm run collect:once
```

Run this command from the backend directory.

## 9. Running Tests and Evaluations

The project provides multiple testing and evaluation scripts.

Run the following commands from the backend directory:

```bash
# Main test suite
npm test

# Agent verification
npm run verify:agents

# Policy change demonstration
npm run demo:policy-change

# Phase O: Stale-answer evaluation
npm run evaluate

# Phase P: Adversarial guard evaluation
npm run evaluate:guards

# Phase Q: Propagation soundness
npm run evaluate:propagation

# Phase R: Notification cost
npm run evaluate:notification-cost

# Phase S: Staleness bound
npm run evaluate:staleness

# Phase T: Ranking order-invariance
npm run evaluate:ranking

# Phase U: Eligibility matcher verification
npm run evaluate:matcher

# Phase V: Change-detection completeness
npm run evaluate:detection

# Phase W: Public response-surface audit
npm run evaluate:exposure

# Phase X: Cross-surface recommendation agreement
npm run evaluate:surfaces

# Phase Y: Database index-contract verification
npm run evaluate:indexes

# Boundary testing
npm run test:boundary
```

Some evaluations support live database execution. Refer to the corresponding phase documentation before running them.

### Testing Notes

The development environment also used a custom lightweight test harness called `miniJest` because npm registry access was unavailable during part of development.

At Phase Y, its recorded result was:

- 1,006 tests passed.
- 0 tests failed.
- 1 suite skipped (`api.test.js`).

This is a custom offline test-harness result, not a Jest result.

Historical Jest reports contain different test totals (813 and 824). These should not be treated as the current authoritative test count. Run `npm test` with the real dependencies installed to obtain the current result.

## 10. Evaluation Results

The project includes controlled experiments to evaluate the correctness, efficiency and consistency of different components.

**Important:** The following results are based on synthetic datasets and simulated evaluation environments. They should not be interpreted as real-world government deployment results or measurements of distinct citizens.

### Phase Q — Policy Propagation Soundness

Objective: Evaluate whether targeted candidate selection misses users affected by policy changes.

| Metric | Result |
|---|---:|
| Synthetic population | 240 users |
| Policy-change scenarios | 16 |
| Scenarios using targeted narrowing | 10 |
| Total candidate evaluations in those scenarios | 2,400 |
| Candidate evaluations examined | 592 |
| Candidate evaluations avoided | 1,808 |
| Scan reduction | 75.3% |
| Affected user-case instances | 1,089 |
| Missed affected instances | 0 |
| Recall | 100% |

**Understanding the measurements:**

The 2,400 candidate evaluations represent 240 synthetic users evaluated across 10 scenarios where targeted narrowing was applicable.

The system examined 592 candidate evaluations and avoided re-scoring 1,808 candidate evaluations.

The 1,089 figure represents affected user-case instances accumulated across the evaluated scenarios. It does not represent 1,089 globally distinct individuals.

The targeted approach achieved 100% recall in this synthetic evaluation, with zero missed affected instances.

The results do not establish equivalent performance on a real MongoDB deployment.

### Phase R — Notification Cost Evaluation

Objective: Compare the targeted notification approach against the legacy full-scan notification approach.

Recorded evaluation results:

| Metric | Result |
|---|---:|
| Legacy notification instances | 1,716 |
| Targeted notification instances | 1,089 |
| Reduction in notification instances | 627 |
| Reduction percentage | 36.5% |
| Legacy-only instances | 1,197 |
| Targeted-only instances | 570 |

The 570 targeted-only figure represents additional user-case notification instances identified by the targeted approach across the evaluated synthetic scenarios.

These are aggregated scenario-level counts, not necessarily 570 globally distinct individuals.

The notification cost experiment measures in-process computation. It does not include SMTP delivery latency, database latency, or MongoDB Atlas network overhead.

Phase R.2 notification-duration instrumentation exists, but a measured cycle result was not recorded.

### Other Evaluation Phases

| Phase | Evaluation focus | Reported scope |
|---|---|---|
| O | Stale-answer and retrieval evaluation | Evaluation harness |
| P | Adversarial guard ablation | Offline evaluation |
| S | Recommendation staleness | Derived 25-hour worst-case correction window |
| T | Ranking order-invariance | 960 synthetic rankings |
| U | Independent matcher verification | 306,180 enumerated cases |
| V | Change-detection completeness | 196 single-field mutations across 1,152 profiles |
| W | Public response-surface audit | Four unauthenticated surfaces and 50 internal fields |
| X | Cross-surface agreement | 24 synthetic comparisons |
| Y | Database index contract | 47 declared indexes and 4 uniqueness dependencies |

For complete methodologies, assumptions and limitations, refer to the individual evaluation reports in `backend/docs/`.

## 11. Feature Configuration

The following environment variables control individual subsystems:

```env
NOTIFICATIONS=true
EXPLANATIONS=true
RAG_INDEXING=true
CHAT_LLM=true
POLICY_CHANGE_LLM=true
LEGACY_NOTIFIER=false
```

The legacy notifier should not be enabled alongside the current notification system.

The contradiction and grounding safeguards do not have environment-variable switches. Their evaluation is handled through injected dependencies in the Phase P evaluation harness.

## 12. Known Limitations

The following limitations are documented in the project's evaluation reports.

1. **Embedding quality:** The default `local-hash` embedding provider is lexical rather than semantic. Meaning-based retrieval quality has not been established using this provider.

2. **Vector search:** The Atlas `$vectorSearch` execution path has not been validated. The default retrieval strategy uses in-process cosine similarity.

3. **Multilingual support:** There is no complete translation pipeline or verified multilingual retrieval implementation.

4. **LLM guard evaluation:** The contradiction guard is phrase-based and has known limitations with indirect or oblique reversals. Its real-LLM error rate has not been measured.

5. **Synthetic propagation evaluation:** Phase Q uses synthetic policy-change scenarios and a simulated user store. Live MongoDB matching semantics and index behaviour are not established by this experiment.

6. **Notification delivery:** Phase R measures in-process computation rather than actual end-to-end notification delivery performance.

7. **Notification duration:** Phase R.2 instrumentation exists, but no measured notification-duration result is available.

8. **Database indexes:** Phase Y verifies declared index contracts, not the actual existence or performance of indexes on a live database.

9. **Ranking quality:** Phase T establishes ranking order-invariance, not whether the recommendations are relevant or optimal.

10. **Policy data accuracy:** Phase V evaluates change detection between normalized documents. It does not establish that the original government information was extracted correctly.

11. **Matcher correctness:** Phase U compares the eligibility matcher against an independently implemented reference. Agreement does not establish that the underlying government policy rules are correct.

12. **Correction window:** Phase S derives a 25-hour worst-case correction window from configured scheduling intervals, assuming successful attempts. It is not a measured real-world delay.

These limitations are important when interpreting the project's evaluation results.

## 13. Future Enhancements

Potential areas for further development include:

- Integrating and validating live government scheme data sources.
- Evaluating the system against larger real-world user datasets.
- Validating targeted policy impact analysis against a live MongoDB deployment.
- Improving semantic retrieval using production embedding providers.
- Expanding multilingual scheme information retrieval.
- Measuring end-to-end notification delivery performance.
- Conducting human evaluation of recommendation relevance and explanation quality.
- Improving monitoring, scalability and deployment infrastructure.

## 14. Documentation

Detailed technical documentation and evaluation reports are available in:

```text
backend/docs/
```

Important reports include:

- `PHASE_Q_REPORT.md`
- `PHASE_R_REPORT.md`
- `PHASE_S_REPORT.md`
- `PHASE_T_REPORT.md`
- `PHASE_U_REPORT.md`
- `PHASE_V_REPORT.md`
- `PHASE_W_REPORT.md`
- `PHASE_X_REPORT.md`
- `PHASE_Y_REPORT.md`
- `PHASE_Z_REPORT.md`

Additional implementation reports and verification documents are also available in the same directory.

## 15. Security

- Environment variables are used for sensitive configuration.
- JWT authentication protects user-specific operations.
- Ownership checks restrict access to user-specific resources.
- Public API responses use controlled projections.
- Sensitive credentials should never be committed to the repository.

Before deployment, configure secure database access, rotate exposed credentials, and review the environment configuration.

---

**Project:** Dynamic Policy-Aware Government Scheme Monitoring & Recommendation System

**Development:** BASE through Phase Z
