import type { JobEnqueueOptions, JobHandler, JobQueue, JobRunner } from '@agentry/core';

// Test-side mirror of `@agentry/adapter-jobrunner-memory`. Duplicated because
// dependency-cruiser blocks `packages/testing` from importing adapter packages
// (`testing-only-imports-core`). Behaviour is intentionally identical: same
// key runs FIFO, different keys run independently, job failures route to
// onError instead of poisoning the chain. Keep both copies in lockstep.
export interface InMemoryJobRunnerOptions {
  readonly onError?: (err: unknown, key: string) => void;
}

interface QueueEntry {
  readonly handler: JobHandler<unknown>;
}

export class InMemoryJobRunner implements JobRunner {
  private readonly chains = new Map<string, Promise<void>>();
  private readonly queues = new Map<string, QueueEntry>();
  private started = false;

  constructor(private readonly options: InMemoryJobRunnerOptions = {}) {}

  register<P>(queue: string, handler: JobHandler<P>): JobQueue<P> {
    if (this.started) {
      throw new Error(`JobRunner: cannot register queue '${queue}' after start()`);
    }
    if (this.queues.has(queue)) {
      throw new Error(`JobRunner: queue '${queue}' is already registered`);
    }
    this.queues.set(queue, { handler: handler as JobHandler<unknown> });
    return {
      enqueue: (opts: JobEnqueueOptions<P>) => this.enqueueInternal(queue, opts),
    };
  }

  async start(): Promise<void> {
    this.started = true;
  }

  private async enqueueInternal<P>(queue: string, opts: JobEnqueueOptions<P>): Promise<void> {
    const entry = this.queues.get(queue);
    if (!entry) {
      throw new Error(`JobRunner: queue '${queue}' is not registered`);
    }
    const { key, payload } = opts;
    const handler = entry.handler;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const onError = this.options.onError;
    const next: Promise<void> = previous
      .then(() => handler(payload))
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
        if (this.chains.get(key) === next) {
          this.chains.delete(key);
        }
      });
    this.chains.set(key, next);
  }

  async drain(): Promise<void> {
    while (this.chains.size > 0) {
      await Promise.all([...this.chains.values()]);
    }
  }
}
