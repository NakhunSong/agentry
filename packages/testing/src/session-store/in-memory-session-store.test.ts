import { describe, expect, it } from 'vitest';
import { InMemorySessionStore } from './in-memory-session-store.js';

describe('InMemorySessionStore', () => {
  it('returns the same session for repeated findOrCreate on the same key', async () => {
    const store = new InMemorySessionStore();
    const a = await store.findOrCreate('test', 'thread-1', 'tenant-1');
    const b = await store.findOrCreate('test', 'thread-1', 'tenant-1');
    expect(b.id).toBe(a.id);
  });

  it('issues distinct sessions for different (kind, ref, tenant) tuples', async () => {
    const store = new InMemorySessionStore();
    const a = await store.findOrCreate('test', 'thread-1', 'tenant-1');
    const b = await store.findOrCreate('test', 'thread-1', 'tenant-2');
    expect(b.id).not.toBe(a.id);
  });

  it('records turns with monotonic seqNo per session', async () => {
    const store = new InMemorySessionStore();
    const session = await store.findOrCreate('test', 'thread-1', 'tenant-1');
    const t1 = await store.recordTurn(session.id, { authorRole: 'user', contentText: 'hi' });
    const t2 = await store.recordTurn(session.id, { authorRole: 'agent', contentText: 'yo' });
    expect(t1.seqNo).toBe(1n);
    expect(t2.seqNo).toBe(2n);
    const recent = await store.getRecentTurns(session.id, 10);
    expect(recent.map((t) => t.contentText)).toEqual(['hi', 'yo']);
  });

  it('returns the last N turns from getRecentTurns', async () => {
    const store = new InMemorySessionStore();
    const session = await store.findOrCreate('test', 'thread-1', 'tenant-1');
    for (const t of ['a', 'b', 'c']) {
      await store.recordTurn(session.id, { authorRole: 'user', contentText: t });
    }
    const recent = await store.getRecentTurns(session.id, 2);
    expect(recent.map((r) => r.contentText)).toEqual(['b', 'c']);
  });
});
