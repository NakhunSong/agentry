import type { JobRunner, JobRunnerEnqueueOptions } from '@agentry/core';

export interface InMemoryJobRunnerOptions {
  // Invoked once per job rejection. The chain continues regardless — a
  // failing job must NOT poison subsequent jobs on the same key. Errors
  // thrown by the handler itself are swallowed.
  readonly onError?: (err: unknown, key: string) => void;
}

// Single-process per-key serializer. Same key → FIFO chain; different keys
// run independently. Swap to pg-boss / BullMQ when crossing process boundaries
// (see ARCHITECTURE.md §4.8).
export class InMemoryJobRunner implements JobRunner {
  private readonly chains = new Map<string, Promise<void>>();

  constructor(private readonly options: InMemoryJobRunnerOptions = {}) {}

  async enqueue(opts: JobRunnerEnqueueOptions): Promise<void> {
    const key = opts.key;
    const job = opts.job;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const onError = this.options.onError;
    const next: Promise<void> = previous
      .then(() => job())
      .catch((err: unknown) => {
        if (onError) {
          try {
            onError(err, key);
          } catch {
            // swallow — handler errors must not poison the chain
          }
        }
      })
      .finally(() => {
        // Drop the chain entry only if no later enqueue has replaced it.
        if (this.chains.get(key) === next) {
          this.chains.delete(key);
        }
      });
    this.chains.set(key, next);
  }

  // Wait for every in-flight chain to drain. Loops because a job may enqueue
  // another while we await — graceful shutdown still has to settle them.
  // Caller is responsible for ensuring enqueued jobs terminate; otherwise
  // drain never returns.
  async drain(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()]);
    }
  }
}
