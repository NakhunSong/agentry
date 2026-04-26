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

async function settle(): Promise<void> {
  await new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

describe('testing.InMemoryJobRunner', () => {
  it('serializes jobs sharing a key in FIFO order', async () => {
    const runner = new InMemoryJobRunner();
    const order: string[] = [];
    const gateA = deferred<void>();

    await runner.enqueue({
      key: 'k',
      job: async () => {
        order.push('a:start');
        await gateA.promise;
        order.push('a:end');
      },
    });
    await runner.enqueue({
      key: 'k',
      job: async () => {
        order.push('b:start');
        order.push('b:end');
      },
    });

    await settle();
    expect(order).toEqual(['a:start']);

    gateA.resolve();
    await runner.drain();
    expect(order).toEqual(['a:start', 'a:end', 'b:start', 'b:end']);
  });

  it('runs jobs on different keys in parallel', async () => {
    const runner = new InMemoryJobRunner();
    const order: string[] = [];
    const gateA = deferred<void>();

    await runner.enqueue({
      key: 'a',
      job: async () => {
        order.push('a:start');
        await gateA.promise;
      },
    });
    await runner.enqueue({
      key: 'b',
      job: async () => {
        order.push('b:start');
      },
    });

    await settle();
    expect(order).toEqual(['a:start', 'b:start']);
    gateA.resolve();
    await runner.drain();
  });

  it('routes a job throw to onError without poisoning the chain', async () => {
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
        order.push('after');
      },
    });

    await runner.drain();
    expect(order).toEqual(['after']);
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, key] = onError.mock.calls[0] ?? [];
    expect((err as Error).message).toBe('boom');
    expect(key).toBe('k');
  });
});
