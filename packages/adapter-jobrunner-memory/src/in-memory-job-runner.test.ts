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

    const queue = runner.register<{ id: string; gate: Deferred<void> }>('q', async (payload) => {
      order.push(`${payload.id}:start`);
      await payload.gate.promise;
      order.push(`${payload.id}:end`);
    });

    await queue.enqueue({ key: 'session-1', payload: { id: 'a', gate: gateA } });
    await queue.enqueue({ key: 'session-1', payload: { id: 'b', gate: gateB } });

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

    const queue = runner.register<{ id: string; gate: Deferred<void> }>('q', async (payload) => {
      order.push(`${payload.id}:start`);
      await payload.gate.promise;
      order.push(`${payload.id}:end`);
    });

    await queue.enqueue({ key: 'session-1', payload: { id: 'a', gate: gateA } });
    await queue.enqueue({ key: 'session-2', payload: { id: 'b', gate: gateB } });

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

    const queue = runner.register<{ throws: boolean }>('q', async (payload) => {
      if (payload.throws) throw new Error('boom');
      order.push('after-error');
    });

    await queue.enqueue({ key: 'k', payload: { throws: true } });
    await queue.enqueue({ key: 'k', payload: { throws: false } });

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

    const queue = runner.register<{ throws: boolean }>('q', async (payload) => {
      if (payload.throws) throw new Error('boom');
      order.push('after');
    });

    await queue.enqueue({ key: 'k', payload: { throws: true } });
    await queue.enqueue({ key: 'k', payload: { throws: false } });

    await runner.drain();
    expect(order).toEqual(['after']);
  });

  it('resolves enqueue immediately, before the job completes', async () => {
    const runner = new InMemoryJobRunner();
    const gate = deferred<void>();
    let started = false;
    let finished = false;

    const queue = runner.register<null>('q', async () => {
      started = true;
      await gate.promise;
      finished = true;
    });

    const enqueuePromise = queue.enqueue({ key: 'k', payload: null });

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

    const queue = runner.register<{ id: string; gate: Deferred<void> }>('q', async (payload) => {
      await payload.gate.promise;
      if (payload.id === 'a') aDone = true;
      else bDone = true;
    });

    await queue.enqueue({ key: 'a', payload: { id: 'a', gate: gateA } });
    await queue.enqueue({ key: 'b', payload: { id: 'b', gate: gateB } });

    queueMicrotask(() => {
      gateA.resolve();
      gateB.resolve();
    });

    await runner.drain();
    expect(aDone).toBe(true);
    expect(bDone).toBe(true);
  });

  it('register throws on duplicate queue name', () => {
    const runner = new InMemoryJobRunner();
    runner.register('q', async () => {});
    expect(() => runner.register('q', async () => {})).toThrow(/already registered/);
  });

  it('register throws when called after start()', async () => {
    const runner = new InMemoryJobRunner();
    await runner.start();
    expect(() => runner.register('q', async () => {})).toThrow(/after start/);
  });

  it('start() is idempotent-safe (in-memory: no async setup)', async () => {
    const runner = new InMemoryJobRunner();
    await runner.start();
    // Calling drain after start with no in-flight jobs returns immediately.
    await runner.drain();
  });

  it('routes different queues to their own handlers', async () => {
    const runner = new InMemoryJobRunner();
    const seen: string[] = [];
    const qA = runner.register<{ v: string }>('a', async (p) => {
      seen.push(`a:${p.v}`);
    });
    const qB = runner.register<{ v: string }>('b', async (p) => {
      seen.push(`b:${p.v}`);
    });
    await qA.enqueue({ key: 'k', payload: { v: '1' } });
    await qB.enqueue({ key: 'k', payload: { v: '2' } });
    await runner.drain();
    // FIFO on shared key — a's job before b's.
    expect(seen).toEqual(['a:1', 'b:2']);
  });
});
