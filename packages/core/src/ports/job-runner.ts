export interface JobRunnerEnqueueOptions {
  readonly key: string;
  readonly job: () => Promise<void>;
}

// Per-key serialization primitive: same `key` runs FIFO, different keys
// run in parallel. `enqueue` resolves once the job is queued, NOT after it
// completes — back-pressure is not part of this contract.
export interface JobRunner {
  enqueue(opts: JobRunnerEnqueueOptions): Promise<void>;
}
