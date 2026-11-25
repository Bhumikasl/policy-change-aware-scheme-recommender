# Notification architecture (Phase L)

## Separation of concerns — the research point

The system keeps four things apart that are commonly fused:

| Concern | Owner | Decides |
|---|---|---|
| Policy reasoning | Policy Change Agent, Policy Impact Agent | what changed, and who could be affected |
| Recommendation propagation | `recommendationPropagation` | whose recommendation state actually moved |
| Explanation | Explanation Agent | how to say why, grounded in stored data |
| Notification delivery | Notification Agent, Notification Service | whether to interrupt someone, and getting it there |

**A delivery failure cannot corrupt a policy decision.** The audit trail is
written before any send is attempted, `notificationStatus` is tracked but is
excluded from `record.status` and from `policyRetryable`, and the notification
sweep is a separate scheduled job that calls only the delivery step. A failed
email is retried by the notification sweep; it never re-runs an agent.

The Notification Agent imports no model, no matcher and no database, so it
cannot reach an eligibility decision even accidentally. A test asserts this by
reading its own source.

## Targeted flow, not a scan

```
Policy Change Agent
      ↓  what changed
Policy Impact Agent
      ↓  affected users  (targeted band where provable, full scan where not)
Recommendation Propagation
      ↓  the subset whose recommendation state moved
Notification Agent
      ↓  the subset worth interrupting someone about
Email / In-App
```

Not:

```
Policy change → scan every user → notify
```

The pre-Phase-I notifier did exactly that: `User.find({})` on every version
bump, emailing on `isMatch`. A ministry rename emailed every matching user, and
the full scan undid the targeted selection upstream. That path is disabled by
default (`LEGACY_NOTIFIER=false`) and covered by a test asserting the only user
query the service issues is `{_id: {$in: affectedIds}}`.

**No scalability claim is made here.** The flow is narrower by construction;
whether that yields a measured improvement on a real population is a Phase R
question. **Phase R has now measured it on a synthetic population**: 36.5%
fewer interruptions (627/1716), and — the more important finding — 570 users
the legacy path could not reach at all, because its filter is
`isMatch(user, schemeAfter)` and someone who just LOST eligibility fails it.
See `docs/PHASE_R_REPORT.md`. Still no claim about a REAL population.

## Delivery lifecycle

```
PENDING ──claim──> SENDING ──ok──> SENT
                      │
                      ├── transient ──> FAILED_RETRYABLE ──(backoff, due)──> SENDING
                      └── permanent ──> FAILED_PERMANENTLY   (never re-claimed)

SUPPRESSED — deliberately not sent; never retried
```

`READ` is deliberately absent from this enum. Delivery and readership are
independent: a SENT email can go unread forever, and an in-app row can be read
while its email is still retrying. Read state lives in `readAt` and is queried
separately. Neither says anything about policy processing status.

Only `PENDING` and `FAILED_RETRYABLE` are claimable. `SENDING` exists so two
overlapping sweeps cannot claim the same row mid-flight.

## The queue boundary (L.3), and why a broker is deferred

Current default is **inline**: delivery happens during the collection cycle.
That is correct while the affected set is small and is what the end-to-end
tests exercise.

`NOTIFICATION_DELIVERY_MODE=queued` decouples it. In queued mode
`notifyFromTransitions` writes the row as `PENDING` and returns; the scheduled
sweep drains it. **Policy processing then never waits on SMTP**, which is the
requirement.

**The Notification collection is the queue.** A `PENDING` row with a due
`nextAttemptAt` is a job, `claimDueNotifications` is the dequeue, and the unique
index on `(userId, schemeId, triggeringChangeId, channel)` is the
exactly-once guarantee.

A dedicated broker (BullMQ/Redis, RabbitMQ) is **deferred**, deliberately:

- It adds a second datastore to run, secure, back up and keep consistent with
  MongoDB, for throughput this project has not yet been shown to need.
- The durability and idempotency properties are already provided by the unique
  index and the status machine.
- The integration boundary exists **now**. Moving to a broker means replacing
  `claimDueNotifications` and the sweep body — not restructuring the pipeline.

Revisit when a measured collection cycle spends a material fraction of its time
in delivery, or when delivery needs to scale independently of collection.

**Phase R added the instrumentation** — `notificationDurationMs` on the policy
record — and the arithmetic (`brokerRecommendation`, threshold 25%). The
measurement itself is **NOT MEASURED**: no cycle in the development environment
recorded both durations. Take it with
`npm run evaluate:notification-cost -- --cycles cycles.json`.

## Preferences

`user.notificationPrefs`:

- `email` (default true) — email channel
- `inApp` (default true) — in-app channel, **independent of email**
- `minSeverity` (default MEDIUM) — email threshold only
- `unsubscribedAt` — silences both channels

Disabling email leaves the in-app record intact. Rank movements are LOW
severity, so with the default threshold they appear in-app and not by email.
