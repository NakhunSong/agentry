import { describe, expect, it, vi } from 'vitest';
import { InMemoryJobRunner } from './in-memory-job-runner.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (err: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

// Drain ALL pending microtasks by waiting for the next macrotask boundary.
// `setImmediate` fires after every microtask has settled, which is enough
// for our chained `.then().catch().finally()` plus user-job awaits.
async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('InMemoryJobRunner', () => {
  it('serializes jobs sharing a key in FIFO order', async () => {
    const runner = new InMemoryJobRunner();
    const order: string[] = [];
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    await runner.enqueue({
      key: 'session-1',
      job: async () => {
        order.push('a:start');
        await gateA.promise;
        order.push('a:end');
      },
    });
    await runner.enqueue({
      key: 'session-1',
      job: async () => {
        order.push('b:start');
        await gateB.promise;
        order.push('b:end');
      },
    });

    await settle();
    expect(order).toEqual(['a:start']);

    gateA.resolve();
    await settle();
    expect(order).toEqual(['a:start', 'a:end', 'b:start']);

    gateB.resolve();
    await settle();
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs jobs on different keys in parallel', async () => {
    const runner = new InMemoryJobRunner();
    const order: string[] = [];
    const gateA = deferred<void>();
    const gateB = deferred<void>();

    await runner.enqueue({
      key: 'session-1',
      job: async () => {
        order.push('a:start');
        await gateA.promise;
        order.push('a:end');
      },
    });
    await runner.enqueue({
      key: 'session-2',
      job: async () => {
        order.push('b:start');
        await gateB.promise;
        order.push('b:end');
      },
    });

    await settle();
    // Both started — different keys do not block each other.
    expect(order).toEqual(['a:start', 'b:start']);

    gateB.resolve();
    await settle();
    expect(order).toEqual(['a:start', 'b:start', 'b:end']);

    gateA.resolve();
    await settle();
    expect(order).toEqual(['a:start', 'b:start', 'b:end', 'a:end']);
  });

  it('continues the chain after a job throws', async () => {
    const onError = vi.fn();
    const runner = new InMemoryJobRunner({ onError });
    const order: string[] = [];

    await runner.enqueue({
      key: 'k',
      job: async () => {
        throw new Error('boom');
      },
    });
    await runner.enqueue({
      key: 'k',
      job: async () => {
        order.push('after-error');
      },
    });

    await runner.drain();
    expect(order).toEqual(['after-error']);
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, key] = onError.mock.calls[0] ?? [];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toBe('boom');
    expect(key).toBe('k');
  });

  it('swallows errors thrown by the onError handler itself', async () => {
    const runner = new InMemoryJobRunner({
      onError: () => {
        throw new Error('handler-failed');
      },
    });
    const order: string[] = [];

    await runner.enqueue({
      key: 'k',
      job: async () => {
        throw new Error('boom');
      },
    });
    await runner.enqueue({
      key: 'k',
      job: async () => {
        order.push('after');
      },
    });

    await runner.drain();
    expect(order).toEqual(['after']);
  });

  it('resolves enqueue immediately, before the job completes', async () => {
    const runner = new InMemoryJobRunner();
    const gate = deferred<void>();
    let started = false;
    let finished = false;

    const enqueuePromise = runner.enqueue({
      key: 'k',
      job: async () => {
        started = true;
        await gate.promise;
        finished = true;
      },
    });

    await enqueuePromise;
    // The job may have started its first microtask but cannot have finished.
    expect(finished).toBe(false);

    await settle();
    expect(started).toBe(true);
    expect(finished).toBe(false);

    gate.resolve();
    await runner.drain();
    expect(finished).toBe(true);
  });

  it('drain waits for in-flight jobs across multiple keys', async () => {
    const runner = new InMemoryJobRunner();
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    let aDone = false;
    let bDone = false;

    await runner.enqueue({
      key: 'a',
      job: async () => {
        await gateA.promise;
        aDone = true;
      },
    });
    await runner.enqueue({
      key: 'b',
      job: async () => {
        await gateB.promise;
        bDone = true;
      },
    });

    queueMicrotask(() => {
      gateA.resolve();
      gateB.resolve();
    });

    await runner.drain();
    expect(aDone).toBe(true);
    expect(bDone).toBe(true);
  });
});
