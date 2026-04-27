import type { JobRunner, JobRunnerEnqueueOptions } from '@agentry/core';

// Test-side mirror of `@agentry/adapter-jobrunner-memory`. Duplicated because
// dependency-cruiser blocks `packages/testing` from importing adapter packages
// (`testing-only-imports-core`). Behaviour is intentionally identical: same key
// runs FIFO, different keys run independently, job failures route to onError
// instead of poisoning the chain.
export interface InMemoryJobRunnerOptions {
  readonly onError?: (err: unknown, key: string) => void;
}

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
