// Per-key serialization primitive. Same `key` runs FIFO, different keys run
// in parallel. `enqueue` resolves once the job is queued, NOT after it
// completes — back-pressure is not part of this contract.
//
// Payload + handler-registry shape (vs. closure-as-job) lets a distributed
// adapter (pg-boss, BullMQ, SQS, ...) wire the same port: payload travels
// through the queue medium as data; the handler is registered at boot on
// every process that runs the queue. ARCHITECTURE.md §4.8 covers when to
// swap from in-memory to a cross-process adapter.
//
// Payload contract: must be JSON-roundtrip-safe (plain objects, arrays,
// numbers, strings, booleans, null; `Date` is allowed and adapters MUST
// handle it explicitly — pg-boss serializes via ISO string). In-memory
// adapter passes payload by reference and does not enforce this; the
// pg-boss adapter does.

export interface JobHandler<P> {
  (payload: P): Promise<void>;
}

export interface JobEnqueueOptions<P> {
  readonly key: string;
  readonly payload: P;
}

// Typed enqueue handle returned by `JobRunner.register`. The typing prevents
// publishing to a queue with the wrong payload shape and removes the need to
// thread queue names through call sites.
export interface JobQueue<P> {
  enqueue(opts: JobEnqueueOptions<P>): Promise<void>;
}

export interface JobRunner {
  // Register a queue handler. Must be called at composition time, BEFORE
  // `start()`. Calling `register` twice for the same queue throws — duplicate
  // registration indicates a boot-time misconfiguration. Calling `register`
  // after `start()` also throws — distributed adapters wire workers at start
  // time and cannot retroactively bind a handler.
  register<P>(queue: string, handler: JobHandler<P>): JobQueue<P>;

  // Async one-shot initialization: distributed adapters (pg-boss, BullMQ, …)
  // open their schema, start workers, and begin polling here. In-memory has
  // no async setup and implements this as a no-op. Compose calls `start()`
  // once after all `register()` calls, before the first `enqueue`.
  start(): Promise<void>;

  // Graceful shutdown: wait until this process's in-flight jobs complete.
  // Cross-process adapters (pg-boss, BullMQ) do NOT wait for jobs running on
  // other workers — drain is per-process by design.
  drain(): Promise<void>;
}
