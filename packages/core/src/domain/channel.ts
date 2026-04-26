import type { ChannelKind, ChannelNativeRef } from './session.js';

// Author identity within an IncomingEvent. We deliberately omit
// `channelKind` (present in the ARCHITECTURE.md §4.1 design): an event's
// author is always reached through `event.channelKind`, so duplicating it
// here is one more place for adapter code to drift out of sync. If a future
// flow needs author-vs-delivery divergence (e.g. cross-channel forwarding),
// reintroduce it then — smaller commitments are easier to walk back.
export interface Participant {
  readonly channelUserId: string;
  readonly displayName?: string;
}

// MVP carries text only. Future: attachments, structured blocks (Slack
// blocks, Discord embeds, ...). Mirrored by ReplyContent on the outbound
// side.
export interface TurnContent {
  readonly text: string;
}

// Channel-specific routing keys (Slack thread_ts, Discord thread_id, ...).
// Opaque to use cases except as a black box passed back to OutboundChannel
// when replying. SessionPolicy.computeNativeRef will read shape-specific
// keys, so concrete adapters cooperate with their own SessionPolicy.
export type ThreadingMetadata = Readonly<Record<string, unknown>>;

export interface IncomingEvent {
  readonly channelKind: ChannelKind;
  readonly channelNativeRef: ChannelNativeRef;
  readonly author: Participant;
  readonly payload: TurnContent;
  readonly threading: ThreadingMetadata;
  readonly receivedAt: Date;
  // Adapter-computed; protects against duplicate webhook delivery (Slack
  // Events API redelivers on timeout).
  readonly idempotencyKey: string;
  // Synthetic-thread-history flag per ARCHITECTURE.md §4.3 lives here as
  // `metadata.synthetic === true`; concrete adapters may add other keys.
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface ReplyTarget {
  readonly channelKind: ChannelKind;
  readonly channelNativeRef: ChannelNativeRef;
  readonly threading?: ThreadingMetadata;
}

export interface ReplyContent {
  readonly text: string;
}

export interface ReplyAck {
  // Adapter-native message id (Slack ts, Discord message_id, ...).
  readonly messageId: string;
  readonly postedAt: Date;
  readonly metadata?: Readonly<Record<string, unknown>>;
}
