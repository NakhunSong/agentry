import type { IncomingEvent } from '@agentry/core';
import { describe, expect, it } from 'vitest';
import { StaticSessionPolicy } from './static-session-policy.js';

const baseEvent: IncomingEvent = {
  channelKind: 'test',
  channelNativeRef: 'thread-1',
  author: { channelUserId: 'u1' },
  payload: { text: 'hello' },
  threading: {},
  receivedAt: new Date(),
  idempotencyKey: 'k1',
};

describe('StaticSessionPolicy', () => {
  it('returns the event nativeRef by default', () => {
    const policy = new StaticSessionPolicy({ channelKind: 'test' });
    expect(policy.computeNativeRef(baseEvent)).toBe('thread-1');
  });

  it('lets callers override resolveNativeRef', () => {
    const policy = new StaticSessionPolicy({
      channelKind: 'test',
      resolveNativeRef: (e) => `prefix:${e.channelNativeRef}`,
    });
    expect(policy.computeNativeRef(baseEvent)).toBe('prefix:thread-1');
  });

  it('returns configured idle timeout (default 30)', () => {
    expect(new StaticSessionPolicy({ channelKind: 'test' }).idleTimeoutMinutes()).toBe(30);
    expect(
      new StaticSessionPolicy({ channelKind: 'test', idleTimeoutMinutes: 5 }).idleTimeoutMinutes(),
    ).toBe(5);
  });

  it('treats configured kinds as session-ending', () => {
    const policy = new StaticSessionPolicy({
      channelKind: 'test',
      endOnKinds: ['idle_timeout', 'channel_close'],
    });
    expect(policy.shouldEndOn({ kind: 'idle_timeout' })).toBe(true);
    expect(policy.shouldEndOn({ kind: 'user_left' })).toBe(false);
  });
});
