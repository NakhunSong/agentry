import type { IncomingEvent, SessionLifecycleEvent } from '@agentry/core';
import { describe, expect, it } from 'vitest';
import { SlackSessionPolicy } from './slack-session-policy.js';

function buildEvent(channelNativeRef: string): IncomingEvent {
  return {
    channelKind: 'slack',
    channelNativeRef,
    author: { channelUserId: 'U1' },
    payload: { text: 'hi' },
    threading: { channel: 'C1', thread_ts: '1.0', message_ts: '1.0', team_id: 'T1' },
    receivedAt: new Date(0),
    idempotencyKey: 'Ev1',
  };
}

describe('SlackSessionPolicy', () => {
  const policy = new SlackSessionPolicy();

  it('declares slack channelKind', () => {
    expect(policy.channelKind).toBe('slack');
  });

  it('returns the canonical nativeRef from the IncomingEvent (identity)', () => {
    expect(policy.computeNativeRef(buildEvent('slack:C1:1.0'))).toBe('slack:C1:1.0');
    expect(policy.computeNativeRef(buildEvent('slack:CXY:9.7'))).toBe('slack:CXY:9.7');
  });

  it('returns 24h idle timeout per ARCH §4.3', () => {
    expect(policy.idleTimeoutMinutes()).toBe(1440);
  });

  it('ends session on channel_close', () => {
    const closed: SessionLifecycleEvent = { kind: 'channel_close' };
    expect(policy.shouldEndOn(closed)).toBe(true);
  });

  it('does not end session on idle_timeout or other kinds', () => {
    expect(policy.shouldEndOn({ kind: 'idle_timeout' })).toBe(false);
    expect(policy.shouldEndOn({ kind: 'user_left' })).toBe(false);
  });
});
