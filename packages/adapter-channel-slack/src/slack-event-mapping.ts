import type { IncomingEvent } from '@agentry/core';
import { SLACK_CHANNEL_KIND } from './slack-channel-kinds.js';

// Subset of the Slack `app_mention` envelope we depend on. Bolt's published
// types are looser; this is the contract we read at runtime, so we pin it
// explicitly.
export interface SlackAppMentionEnvelope {
  readonly event: {
    readonly type: 'app_mention';
    readonly user?: string;
    readonly text?: string;
    readonly ts: string;
    readonly thread_ts?: string;
    readonly channel: string;
    readonly event_ts: string;
  };
  readonly event_id: string;
  readonly team_id: string;
}

export class SlackEventMappingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackEventMappingError';
  }
}

// Channel-mention only (DMs are deferred). Self-mention filtering is not
// applied: `app_mention` is fired only when *someone else* mentions the bot.
// If a future revision subscribes to `message.channels`, add a self-message
// filter at that subscription point.
export function mapAppMentionToIncomingEvent(envelope: SlackAppMentionEnvelope): IncomingEvent {
  const { event, event_id, team_id } = envelope;
  if (!event.user) {
    throw new SlackEventMappingError(
      `app_mention without event.user (event_id=${event_id}); cannot identify author`,
    );
  }

  const threadTs = event.thread_ts ?? event.ts;
  return {
    channelKind: SLACK_CHANNEL_KIND,
    channelNativeRef: `slack:${event.channel}:${threadTs}`,
    author: { channelUserId: event.user },
    payload: { text: event.text ?? '' },
    threading: {
      channel: event.channel,
      message_ts: event.ts,
      thread_ts: threadTs,
      team_id,
    },
    receivedAt: new Date(Number.parseFloat(event.event_ts) * 1000),
    idempotencyKey: event_id,
  };
}
