import type {
  ChannelKind,
  ChannelNativeRef,
  IncomingEvent,
  SessionLifecycleEvent,
  SessionPolicy,
} from '@agentry/core';
import { SLACK_CHANNEL_KIND } from './slack-channel-kinds.js';

// 24h idle window per ARCHITECTURE.md §4.3.
const SLACK_IDLE_TIMEOUT_MIN = 24 * 60;

export class SlackSessionPolicy implements SessionPolicy {
  readonly channelKind: ChannelKind = SLACK_CHANNEL_KIND;

  // mapAppMentionToIncomingEvent already produces the canonical
  // `slack:${channel}:${ts}` form; the policy is identity (matches the
  // StaticSessionPolicy convention).
  computeNativeRef(event: IncomingEvent): ChannelNativeRef {
    return event.channelNativeRef;
  }

  idleTimeoutMinutes(): number {
    return SLACK_IDLE_TIMEOUT_MIN;
  }

  shouldEndOn(event: SessionLifecycleEvent): boolean {
    return event.kind === 'channel_close';
  }
}
