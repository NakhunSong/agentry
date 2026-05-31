import type { JobEnqueueOptions, JobHandler, JobQueue, JobRunner } from '@agentry/core';
import { PgBoss } from 'pg-boss';

// Minimal subset of the Logger port — duplicated here so the adapter does
// not import `Logger` (a port type) and inflate the dependency surface.
// Adapter callers pass any Logger-shaped object; the real `@agentry/core`
// `Logger` satisfies it structurally.
export interface PgBossLogger {
  info(obj: Record<string, unknown>, msg: string): void;
  warn(obj: Record<string, unknown>, msg: string): void;
  error(obj: Record<string, unknown>, msg: string): void;
}

export interface PgBossJobRunnerOptions {
  readonly connectionString: string;
  // pg-boss creates its own schema (default `pgboss`) and owns the tables.
  // Override only when isolating multiple agentry deployments inside one DB.
  readonly schema?: string;
  // Defaults match Slack/HTTP-style retry semantics: 3 attempts, exponential
  // backoff starting at 30 seconds. Override per deployment when sources have
  // different retry tolerances.
  readonly retryLimit?: number;
  readonly retryDelay?: number;
  readonly retryBackoff?: boolean;
  // Per-node worker concurrency. pg-boss default is 1 → only one job at a
  // time per process even across different singletonKeys, defeating the
  // "different keys run in parallel" half of the per-key FIFO contract.
  // Default 10 gives meaningful per-session parallelism without exhausting
  // a typical pg connection pool.
  readonly localConcurrency?: number;
  // Graceful drain budget. The handler is also given this much time to
  // finish in-flight jobs before pg-boss tears down workers.
  readonly stopTimeoutMs?: number;
  // Per-job error hook. Surfaces failures from the handler chain symmetric
  // with `InMemoryJobRunner`. pg-boss will still record the failure + retry
  // based on `retryLimit` regardless of this hook.
  readonly onError?: (err: unknown, key: string) => void;
  readonly logger?: PgBossLogger;
}

interface QueueEntry {
  readonly handler: JobHandler<unknown>;
}

const DEFAULT_RETRY_LIMIT = 3;
const DEFAULT_RETRY_DELAY_SECONDS = 30;
const DEFAULT_LOCAL_CONCURRENCY = 10;
const DEFAULT_STOP_TIMEOUT_MS = 30_000;

// pg-boss-backed JobRunner. Same per-key FIFO semantics as the in-memory
// adapter, but durable + cross-process:
//   - `singletonKey = key` + `policy: 'key_strict_fifo'` blocks processing
//     of jobs with the same key while any job with that key is active, in
//     retry, OR failed — strict FIFO across the full lifecycle, the only
//     policy that survives `localConcurrency > 1`. The simpler `singleton`
//     policy only restricts the `active` state and lets a second worker
//     pick up the next same-key job while the first is in retryDelay.
//   - Failure semantic: when retries are exhausted, the key stays BLOCKED
//     until an operator clears it (`boss.retry(name, id)` or
//     `boss.deleteJob(name, id)`). This is intentional — a session whose
//     job system is broken should not silently accept new messages while
//     the prior one rotted. Monitor `pgboss.job WHERE state = 'failed'`.
//   - Jobs survive process restart; another worker picks them up.
//   - `drain()` calls `boss.stop({ graceful: true })` — waits for THIS
//     process's in-flight jobs only; other workers continue.
//
// Payload contract: JSON-roundtrip safe. pg-boss stores `data` as JSONB,
// so `Date`/`Map`/functions/circular refs will not survive. This adapter
// does NOT enforce or transform the payload — keep payloads to plain JSON
// shapes (strings, numbers, booleans, null, plain objects, arrays).
//
// ARCHITECTURE.md §4.8 covers when to use this over the in-memory adapter.
export class PgBossJobRunner implements JobRunner {
  private readonly queues = new Map<string, QueueEntry>();
  private readonly retryLimit: number;
  private readonly retryDelay: number;
  private readonly retryBackoff: boolean;
  private readonly localConcurrency: number;
  private readonly stopTimeoutMs: number;
  private readonly onError?: (err: unknown, key: string) => void;
  private readonly logger?: PgBossLogger;
  private boss: PgBoss | null = null;
  private started = false;

  constructor(private readonly options: PgBossJobRunnerOptions) {
    this.retryLimit = options.retryLimit ?? DEFAULT_RETRY_LIMIT;
    this.retryDelay = options.retryDelay ?? DEFAULT_RETRY_DELAY_SECONDS;
    this.retryBackoff = options.retryBackoff ?? true;
    this.localConcurrency = options.localConcurrency ?? DEFAULT_LOCAL_CONCURRENCY;
    this.stopTimeoutMs = options.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
    if (options.onError !== undefined) this.onError = options.onError;
    if (options.logger !== undefined) this.logger = options.logger;
  }

  register<P>(queue: string, handler: JobHandler<P>): JobQueue<P> {
    if (this.started) {
      throw new Error(`PgBossJobRunner: cannot register queue '${queue}' after start()`);
    }
    if (this.queues.has(queue)) {
      throw new Error(`PgBossJobRunner: queue '${queue}' is already registered`);
    }
    this.queues.set(queue, { handler: handler as JobHandler<unknown> });
    return {
      enqueue: (opts: JobEnqueueOptions<P>) => this.enqueueInternal(queue, opts),
    };
  }

  async start(): Promise<void> {
    if (this.started) {
      throw new Error('PgBossJobRunner: start() called twice');
    }
    const boss = new PgBoss({
      connectionString: this.options.connectionString,
      ...(this.options.schema !== undefined ? { schema: this.options.schema } : {}),
      application_name: 'agentry-jobrunner',
    });
    boss.on('error', (err: unknown) => {
      this.logger?.error({ err }, 'pg-boss surfaced error event');
    });
    await boss.start();

    for (const [name, entry] of this.queues) {
      await boss.createQueue(name, {
        policy: 'key_strict_fifo',
        retryLimit: this.retryLimit,
        retryDelay: this.retryDelay,
        retryBackoff: this.retryBackoff,
      });
      await boss.work(
        name,
        { localConcurrency: this.localConcurrency },
        async (jobs: Array<{ id: string; data: unknown }>) => {
          // pg-boss key_strict_fifo blocks ALL processing of jobs sharing
          // a singletonKey while any job with that key is active, in retry,
          // OR failed. Different keys still run in parallel up to
          // localConcurrency. The handler can throw freely; pg-boss records
          // the failure and schedules a retry per the queue's
          // retryLimit/retryDelay. Retries exhausted → key stays blocked
          // (see class JSDoc operational note).
          // batchSize defaults to 1, so the array has exactly one job — but
          // narrow defensively to keep noUncheckedIndexedAccess happy.
          const job = jobs[0];
          if (!job) return;
          try {
            await entry.handler(job.data);
          } catch (err) {
            this.onError?.(err, this.singletonKeyForJob(job));
            throw err; // re-throw so pg-boss records failure + schedules retry
          }
        },
      );
    }

    this.boss = boss;
    this.started = true;
  }

  async drain(): Promise<void> {
    if (this.boss === null) return;
    // graceful: true → wait for active jobs to finish (bounded by timeout).
    // close: true → tear down pg-boss's connection pool. The caller's own
    // pg.Pool (if any) is independent.
    await this.boss.stop({ graceful: true, timeout: this.stopTimeoutMs, close: true });
    this.boss = null;
  }

  private async enqueueInternal<P>(queue: string, opts: JobEnqueueOptions<P>): Promise<void> {
    if (!this.boss) {
      throw new Error(
        `PgBossJobRunner: enqueue('${queue}') called before start() — call start() once after all register() calls`,
      );
    }
    if (!this.queues.has(queue)) {
      throw new Error(`PgBossJobRunner: queue '${queue}' is not registered`);
    }
    // singletonKey enforces per-key serialization. opts.payload travels as
    // JSONB; non-JSON-safe values are the caller's responsibility (see
    // class JSDoc).
    await this.boss.send(queue, opts.payload as object, { singletonKey: opts.key });
  }

  // pg-boss puts singletonKey on the job row but the work() handler only
  // sees { id, data }. Best-effort key extraction for onError reporting:
  // job.data is opaque, so we just report the job id. Callers that need
  // the original key can include it in the payload.
  private singletonKeyForJob(job: { id: string }): string {
    return job.id;
  }
}
