# JobRunner

The `JobRunner` port (ARCHITECTURE.md §4.8) drives **per-key FIFO** processing
of work that should not run on the inbound ack path — agent runs, knowledge
backfills, distillation triggers. Same `key` (typically `sessionId`) → strict
FIFO; different keys → parallel. agentry ships two adapters and lets you write
your own.

## Shipped adapters

| Adapter | Package | When to use |
|---|---|---|
| In-memory | `@agentry/adapter-jobrunner-memory` | Default. Single VPS, single process, light traffic. No restart durability. |
| pg-boss | `@agentry/adapter-jobrunner-pgboss` | Anything that needs durability or multi-process distribution. Reuses your existing Postgres — no new container. |

## When to swap to pg-boss

Switch from in-memory if **any one** of the following holds. Mirrored from
ARCHITECTURE.md §4.8.

| # | Trigger | Why |
|---|---|---|
| 1 | Horizontal scaling: 2+ runtime instances behind a load balancer | In-memory `Map<key, Promise>` is process-local; same `sessionId` arriving at different instances breaks per-key serialization |
| 2 | Restart durability required | In-memory loses queued jobs on deploy / crash |
| 3 | Long-running background jobs regularly exceed 60s | Distillation or full-sync block agent latency in-process; need separate worker |
| 4 | Operational visibility (retry dashboard, DLQ, queue stats) | In-memory adapter exposes none |
| 5 | Per-source rate limiting (GitHub API quotas, etc.) | Centralized throttling natural in queue, awkward in-memory |

If none apply, the in-memory adapter remains the right choice. It's not a
training-wheels adapter — it's the correct primitive for a single-VPS
deployment with one server process.

## Swapping to pg-boss

Two changes to your fork:

```ts
// agentry.config.ts
export default defineConfig({
  agentWorkdir: '/path/to/agent-workdir',
  jobRunner: 'pg-boss', // was 'memory' (the default)
  // ... rest unchanged
});
```

Database permission — pg-boss creates its own schema (`pgboss` by default)
on first start. The connection user from `POSTGRES_URL` needs `CREATE`
on the database:

```sql
-- one-time, run as a privileged user
GRANT CREATE ON DATABASE agentry TO agentry;
```

(The dev `docker-compose.yml` already grants this because the `agentry` user
owns the database.)

Restart the process. The first boot adds the `pgboss.*` tables alongside the
existing `public.*` schema — no migration step, pg-boss owns its DDL.

### Behavior changes after the swap

- **Per-key FIFO survives across processes.** Two runtime instances against
  the same Postgres serialize correctly per `singletonKey`.
- **At-least-once delivery.** A failed handler is retried up to 3 times
  with exponential backoff starting at 30s. `recordTurn` is idempotent on
  `idempotencyKey` (migration `0002_turn_idempotency.sql`) so user-turn
  duplicates are silently deduped. Agent turns and outbound replies are
  NOT deduped — every retry produces fresh agent output and may post the
  reply again. This is the right trade-off for "the user got no reply"
  vs "the user got two replies"; channel-level outbound dedup is a
  separate concern owned by the channel adapter.
- **drain() is per-process.** `await jobRunner.drain()` waits for THIS
  process's in-flight jobs to finish (graceful shutdown). Other workers
  continue. Match this with your container `preStop` hook / `SIGTERM`
  handler so K8s rolling restarts and `docker compose down` don't
  truncate jobs.
- **Extra DB roundtrip per inbound message.** The worker re-reads the
  session via `SessionStore.findByRef` instead of trusting a publisher-
  captured snapshot — required for multi-process correctness (see
  ARCHITECTURE.md §4.9 for the analogous pattern in `SessionFirstTouch`).

### Failure mode you must operate

The adapter uses pg-boss `policy: 'key_strict_fifo'` — same-key jobs are
serialized across `active` / `retry` / `failed` states. Different keys
still run in parallel up to `localConcurrency` (default 10, see Tuning
below). This is the only policy that survives `localConcurrency > 1`
without race-leaking same-key jobs across workers during retry delays.

**Consequence**: when a job exhausts its retries (default 3 attempts), it
lands in `failed` state and **the key stays blocked indefinitely**. From a
Slack user's POV: the bot replies fine until one thread hits a permanent
handler failure, then that thread goes silent forever — subsequent messages
in the same thread are accepted (200 ack) but never processed.

No alerting is built in. You MUST monitor failed jobs and unblock keys:

```sql
-- count blocked keys (signal to alert on)
SELECT singleton_key, count(*)
FROM pgboss.job
WHERE state = 'failed' AND name = 'handle-incoming'
GROUP BY singleton_key;

-- inspect a blocked job
SELECT id, data, output, retry_count, completed_on
FROM pgboss.job
WHERE state = 'failed' AND singleton_key = '<sessionId>';
```

To unblock a key, either retry the failed job (if the underlying issue
was transient) or delete it (if you decide to drop the work):

```js
await boss.retry('handle-incoming', jobId);     // unblock + replay
await boss.deleteJob('handle-incoming', jobId); // unblock + abandon
```

Wire `pg-boss-job-runner`'s `onError` callback into your alerting (every
attempt failure surfaces here, including the final one) so an operator
notices before users do. Or query `pgboss.job WHERE state='failed'` from
your monitoring stack.

**Why this is the trade-off**: the alternative — letting a failed key
silently move past and process subsequent messages — looks friendlier
but means the bot accepts work that depends on prior state which never
got recorded. For a session-stateful agent that's worse than a visible
outage. The visible outage forces operator attention; silent drift
doesn't.

### Tuning

`PgBossJobRunnerOptions` exposes:

| Option | Default | When to change |
|---|---|---|
| `schema` | `'pgboss'` | Isolating multiple agentry deployments inside one DB |
| `retryLimit` | `3` | More for flaky upstream APIs; `0` to disable retry |
| `retryDelay` | `30` (seconds) | Tune to match upstream rate limits |
| `retryBackoff` | `true` | Set `false` for fixed delay |
| `localConcurrency` | `10` | pg-boss default is `1` which would defeat the "different keys run in parallel" half of the contract. Tune up for I/O-bound handlers (most agent workloads), down for CPU-bound. Rule of thumb: cap at roughly half your pg `Pool` max so handler queries and pg-boss polling don't starve each other. |
| `stopTimeoutMs` | `30_000` | Match your container's `terminationGracePeriodSeconds` |

## Writing a custom adapter

Implement the `JobRunner` port:

```ts
import type { JobHandler, JobQueue, JobRunner } from '@agentry/core';

export class MyJobRunner implements JobRunner {
  register<P>(queue: string, handler: JobHandler<P>): JobQueue<P> {
    // Store the handler. Throws if called twice for the same queue OR
    // after start() — the contract is "register at boot, start once,
    // then enqueue".
    // Return a typed JobQueue<P> whose enqueue() dispatches to your
    // backend (Redis/BullMQ, SQS, RabbitMQ, …).
  }

  async start(): Promise<void> {
    // Open connections, create queues, bind workers to the handlers
    // captured by register(). Idempotency adapters typically wire
    // boss.work() / Worker / consumer here.
  }

  async drain(): Promise<void> {
    // Stop accepting new work, wait for in-flight jobs in THIS process
    // (not other workers), tear down connections. Bounded by a deployment-
    // appropriate timeout — long enough that legitimate work finishes,
    // short enough that K8s won't force-kill mid-shutdown.
  }
}
```

Contract notes from the port JSDoc:

- **Per-key FIFO**: same `key` runs serial (FIFO), different keys run
  parallel. This is load-bearing for the use case — concurrent agent
  invocations on the same session would race on `recordTurn` and produce
  interleaved turn history.
- **Payloads must be JSON-roundtrip safe.** Plain objects, arrays,
  primitives, `null`. `Date`, `Map`, functions, and circular refs will
  break under any cross-process adapter. The adapter does NOT enforce
  this — keep payloads to JSON shapes by convention.
- **enqueue resolves on accept, not on completion.** The job runs
  asynchronously after `enqueue()` returns. This preserves the inbound
  3-second Slack ack budget.
- **register() throws after start().** Distributed adapters bind workers
  to handlers at start time and cannot retroactively add bindings.

Test against `packages/testing/src/job-runner/in-memory-job-runner.test.ts`
behaviours as the baseline: register/drain/FIFO/parallel/onError. Add a
testcontainers integration test for any cross-process adapter — the
single-instance unit tests can't tell you whether two workers actually
share a queue.

## Alternative backends (not shipped)

The `JobRunner` port is intentionally narrow so other backends slot in
without core changes:

- **BullMQ (Redis)**: useful if you want Bull Board for queue visualization
  or already run Redis. Ships as a separate `adapter-jobrunner-bullmq`
  package (not in this repo). The "new container" cost is real —
  prefer pg-boss when you're already on Postgres.
- **SQS / RabbitMQ / Kafka**: legitimate for cross-cloud deployments,
  but the per-key FIFO contract is harder to enforce — SQS FIFO queues
  have throughput limits, RabbitMQ needs single-active-consumer per key,
  Kafka requires careful partitioning.

For the agentry-default story (single VPS or small horizontal cluster on
Postgres), pg-boss is the recommended swap and the path the framework
optimizes for.
