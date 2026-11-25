# MongoDB index verification

**Status: NOT VERIFIED.** The indexes below are Mongoose *declarations*. No
connection to the Atlas cluster has been made from the development sandbox, so
none of them has been observed to exist. Mongoose creates indexes lazily in the
background on first use of a model, and index creation can fail silently — for
example when a unique index is declared over data that already contains
duplicates. A declaration is a request, not a guarantee.

Run the checks below against the real database and paste the output.

> **PHASE Y — this table is now checked against the schemas.**
>
> Until Phase Y it was maintained by hand and had drifted badly: it listed 8
> indexes while the models declared 47, and it omitted three of the six UNIQUE
> ones — including `notifications.uniq_user_scheme_change_channel`, the
> constraint that is the entire exactly-once guarantee for the in-app inbox. An
> operator following this page would have verified the wrong set and reported
> success.
>
> `npm run evaluate:indexes` regenerates the expected set from the model
> definitions and fails if this table and the schemas disagree, so the drift
> cannot recur silently. Add a row when you add an index; the check will tell
> you if you forget.

## Expected indexes

| Collection | Index | Purpose | Unique |
|---|---|---|---|
| `notificationlogs` | `email_1` | Single-field lookup / filter | No |
| `notificationlogs` | `email_1_schemeId_1_version_1_channel_1` | One email per scheme version per recipient | **Yes** |
| `notificationlogs` | `schemeId_1` | Single-field lookup / filter | No |
| `notifications` | `createdAt_1` | Single-field lookup / filter | No |
| `notifications` | `processingJobId_1` | Single-field lookup / filter | No |
| `notifications` | `schemeId_1` | Single-field lookup / filter | No |
| `notifications` | `severity_1` | Single-field lookup / filter | No |
| `notifications` | `status_1` | Single-field lookup / filter | No |
| `notifications` | `status_1_nextAttemptAt_1` | The notification retry sweep | No |
| `notifications` | `triggeringChangeId_1` | Single-field lookup / filter | No |
| `notifications` | `type_1` | Single-field lookup / filter | No |
| `notifications` | `uniq_user_scheme_change_channel` | Exactly-once in-app notification per (user, scheme, change, channel) | **Yes** |
| `notifications` | `userId_1` | Single-field lookup / filter | No |
| `notifications` | `userId_1_createdAt_-1` | The inbox, newest first | No |
| `notifications` | `userId_1_readAt_1` | Unread count / unread filter | No |
| `recommendationhistories` | `createdAt_1` | Single-field lookup / filter | No |
| `recommendationhistories` | `eligibilityTransition_1` | Single-field lookup / filter | No |
| `recommendationhistories` | `processingJobId_1` | Single-field lookup / filter | No |
| `recommendationhistories` | `processingJobId_1_createdAt_-1` | Everything one cycle produced | No |
| `recommendationhistories` | `recommendationTransition_1` | Single-field lookup / filter | No |
| `recommendationhistories` | `schemeId_1` | Single-field lookup / filter | No |
| `recommendationhistories` | `triggeringChangeId_1` | Single-field lookup / filter | No |
| `recommendationhistories` | `uniq_user_scheme_change` | Idempotency of propagation | **Yes** |
| `recommendationhistories` | `userId_1` | Single-field lookup / filter | No |
| `recommendationhistories` | `userId_1_createdAt_-1` | "My history, newest first" | No |
| `schemechunks` | `chunkId_1` | Deterministic chunk identity — stops a re-index duplicating chunks | **Yes** |
| `schemechunks` | `field_1` | Single-field lookup / filter | No |
| `schemechunks` | `language_1` | Single-field lookup / filter | No |
| `schemechunks` | `schemeId_1` | Single-field lookup / filter | No |
| `schemechunks` | `schemeId_1_schemeVersion_1_status_1` | Supersede the previous version | No |
| `schemechunks` | `schemeVersion_1` | Single-field lookup / filter | No |
| `schemechunks` | `status_1` | Single-field lookup / filter | No |
| `schemechunks` | `status_1_field_1` | Field-scoped retrieval | No |
| `schemechunks` | `status_1_language_1_schemeId_1` | Retrieval over ACTIVE chunks | No |
| `schemehistories` | `policyImpactStatus_1` | Single-field lookup / filter | No |
| `schemehistories` | `policyRetryable_1` | Single-field lookup / filter | No |
| `schemehistories` | `policyRetryable_1_createdAt_1` | The policy retry sweep | No |
| `schemehistories` | `propagationStatus_1` | Single-field lookup / filter | No |
| `schemehistories` | `ragIndexRetryable_1` | Single-field lookup / filter | No |
| `schemehistories` | `ragIndexRetryable_1_createdAt_1` | The RAG re-index sweep | No |
| `schemehistories` | `ragIndexStatus_1` | Single-field lookup / filter | No |
| `schemehistories` | `schemeId_1` | Single-field lookup / filter | No |
| `schemehistories` | `schemeId_1_version_1` | Load the previous snapshot | No |
| `schemes` | `schemeId_1` | Scheme identity; the comparator looks every scheme up by it | **Yes** |
| `users` | `email_1` | Login | **Yes** |
| `users` | `profile.age_1` | Single-field band query — PolicyImpactAgent narrows on `profile.age` alone when only an age rule changes | No |
| `users` | `profile.annualIncome_1` | Single-field band query — PolicyImpactAgent narrows on `profile.annualIncome` alone when only an income rule changes | No |
| `users` | `profile.state_1` | Single-field lookup — PolicyImpactAgent narrows on `profile.state` alone when only a states allow-list rule changes | No |
| `users` | `profile.state_1_profile.annualIncome_1` | Targeted impact queries | No |
| `users` | `role_1` | Single-field lookup / filter | No |

## Procedure

```js
// mongosh "<your-atlas-uri>"
use <yourDatabase>

db.notifications.getIndexes()
db.notificationlogs.getIndexes()
db.recommendationhistories.getIndexes()
db.schemes.getIndexes()
db.schemechunks.getIndexes()
db.schemehistories.getIndexes()
db.users.getIndexes()
```

**What to check, not just that output appears:**

1. Every index marked **Yes** above exists **and** reports `"unique": true` —
   there are six, and four of them are load-bearing: `recommendationhistories
   .uniq_user_scheme_change`, `notifications.uniq_user_scheme_change_channel`,
   `notificationlogs.email_1_schemeId_1_version_1_channel_1` and
   `schemechunks.chunkId_1`. Without the unique flag such an index still speeds
   up reads while providing no idempotency at all, and concurrent cycles will
   write duplicate history, duplicate inbox rows, duplicate emails or duplicate
   RAG chunks. `npm run evaluate:indexes -- --live` performs exactly this check
   against `MONGODB_URI` and reports NOT MEASURED — never "fine" — when it
   cannot reach a database.

2. No index is listed as `"building"` — a partially built index is not yet
   enforcing anything.

3. Confirm the unique index is actually enforced, rather than assumed:

```js
// Should fail with E11000. If it succeeds, the unique index is absent.
const doc = db.recommendationhistories.findOne();
if (doc) {
  try {
    db.recommendationhistories.insertOne({
      userId: doc.userId,
      schemeId: doc.schemeId,
      triggeringChangeId: doc.triggeringChangeId,
      previousEligibility: false, newEligibility: true,
      eligibilityTransition: "INELIGIBLE_TO_ELIGIBLE",
      previousRecommendationStatus: "NOT_RECOMMENDED",
      newRecommendationStatus: "RECOMMENDED",
      recommendationTransition: "NOT_RECOMMENDED_TO_RECOMMENDED",
      createdAt: new Date(),
    });
    print("PROBLEM: duplicate accepted — the unique index is NOT enforcing");
  } catch (e) {
    print(e.code === 11000 ? "OK: duplicate rejected (E11000)" : "Unexpected: " + e.message);
  }
}
```

4. Check the targeted-impact query uses its index rather than scanning:

```js
db.users.find({ "profile.annualIncome": { $gt: 250000, $lte: 300000 } })
        .explain("executionStats").executionStats
// winningPlan.stage should be IXSCAN, not COLLSCAN.
```

If any index is missing, `Model.syncIndexes()` creates it — but on a
collection that already contains duplicates a unique index will refuse to
build, and the duplicates must be resolved first.
