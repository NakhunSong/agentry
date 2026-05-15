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

    const queue = runner.register<{ id: string; gate?: Deferred<void> }>('q', async (payload) => {
      order.push(`${payload.id}:start`);
      if (payload.gate) await payload.gate.promise;
      order.push(`${payload.id}:end`);
    });

    await queue.enqueue({ key: 'k', payload: { id: 'a', gate: gateA } });
    await queue.enqueue({ key: 'k', payload: { id: 'b' } });

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

    const queue = runner.register<{ id: string; gate?: Deferred<void> }>('q', async (payload) => {
      order.push(`${payload.id}:start`);
      if (payload.gate) await payload.gate.promise;
    });

    await queue.enqueue({ key: 'a', payload: { id: 'a', gate: gateA } });
    await queue.enqueue({ key: 'b', payload: { id: 'b' } });

    await settle();
    expect(order).toEqual(['a:start', 'b:start']);
    gateA.resolve();
    await runner.drain();
  });

  it('routes a job throw to onError without poisoning the chain', async () => {
    const onError = vi.fn();
    const runner = new InMemoryJobRunner({ onError });
    const order: string[] = [];

    const queue = runner.register<{ throws: boolean }>('q', async (payload) => {
      if (payload.throws) throw new Error('boom');
      order.push('after');
    });

    await queue.enqueue({ key: 'k', payload: { throws: true } });
    await queue.enqueue({ key: 'k', payload: { throws: false } });

    await runner.drain();
    expect(order).toEqual(['after']);
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, key] = onError.mock.calls[0] ?? [];
    expect((err as Error).message).toBe('boom');
    expect(key).toBe('k');
  });
});
