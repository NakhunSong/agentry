import { describe, expect, it } from 'vitest';
import type { IncomingEvent } from '../domain/channel.js';
import type { SessionPolicy } from './session-policy.js';

// Compile + runtime smoke. Mirrors a Slack-channel-style policy enough to
// pin the contract: native-ref derived from threading metadata, idle 24h,
// `idle_timeout` ends sessions, `channel_close` does too, anything else
// stays open.
function buildFake(): SessionPolicy {
  return {
    channelKind: 'fake',
    computeNativeRef(event) {
      const thread = event.threading.thread_ts;
      const ref = typeof thread === 'string' ? thread : event.idempotencyKey;
      return `fake:${ref}`;
    },
    idleTimeoutMinutes() {
      return 24 * 60;
    },
    shouldEndOn(event) {
      return event.kind === 'idle_timeout' || event.kind === 'channel_close';
    },
  };
}

const baseEvent: IncomingEvent = {
  channelKind: 'fake',
  channelNativeRef: 'unused-during-policy-eval',
  author: { channelUserId: 'u1' },
  payload: { text: 'hi' },
  threading: { thread_ts: '1704067200.123' },
  receivedAt: new Date(),
  idempotencyKey: 'k1',
};

describe('SessionPolicy port', () => {
  it('admits a minimal in-memory implementation', () => {
    const policy = buildFake();
    expect(policy.channelKind).toBe('fake');
    expect(policy.idleTimeoutMinutes()).toBe(24 * 60);
  });

  it('computes native ref from threading metadata', () => {
    const policy = buildFake();
    expect(policy.computeNativeRef(baseEvent)).toBe('fake:1704067200.123');
  });

  it('falls back when threading lacks the expected key', () => {
    const policy = buildFake();
    expect(policy.computeNativeRef({ ...baseEvent, threading: {} })).toBe('fake:k1');
  });

  it('shouldEndOn distinguishes lifecycle event kinds', () => {
    const policy = buildFake();
    expect(policy.shouldEndOn({ kind: 'idle_timeout' })).toBe(true);
    expect(policy.shouldEndOn({ kind: 'channel_close' })).toBe(true);
    expect(policy.shouldEndOn({ kind: 'user_left' })).toBe(false);
    expect(policy.shouldEndOn({ kind: 'channel_archived' })).toBe(false);
  });
});
