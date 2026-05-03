import {
  type ChannelNativeRef,
  type IncomingEvent,
  type SessionPolicy,
  type SessionStore,
  SYNTHETIC_EVENT_METADATA_KEY,
  type TenantId,
  type ThreadingMetadata,
} from '@agentry/core';
import type { WebClient } from '@slack/web-api';
import { SLACK_CHANNEL_KIND } from './slack-channel-kinds.js';
import { slackHistoryIdempotencyKey, slackNativeRef, slackTsToDate } from './slack-conventions.js';

// Slack-specific session metadata uses flat-prefixed keys (e.g.
// `slackBackfilled`) until SessionStore gains atomic deeper-merge.
// PgvectorSessionStore.setMetadata is a shallow JSONB merge, so a nested
// `slack: { backfilled: true }` shape would clobber sibling slack.* keys
// on every write.
export const SLACK_BACKFILLED_METADATA_KEY = 'slackBackfilled';

interface SlackThreadingShape {
  readonly channel: string;
  readonly thread_ts: string;
  readonly message_ts: string;
  readonly team_id: string;
}

export interface SlackHistoryBackfillerOptions {
  readonly webClient: WebClient;
  readonly sessionStore: SessionStore;
  readonly sessionPolicy: SessionPolicy;
}

export class SlackHistoryBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackHistoryBackfillError';
  }
}

export class SlackHistoryBackfiller {
  private readonly opts: SlackHistoryBackfillerOptions;
  // In-memory promise lock keyed by nativeRef collapses concurrent
  // first-touch events for the same session into one Slack API call. The
  // persistent `slackBackfilled` metadata flag covers the cross-restart
  // case; this map covers the single-process race window. Multi-instance
  // deployments still have a narrow same-session-different-process race
  // (accepted for the MVP).
  private readonly inFlight = new Map<ChannelNativeRef, Promise<readonly IncomingEvent[]>>();

  constructor(opts: SlackHistoryBackfillerOptions) {
    this.opts = opts;
  }

  async backfillIfNeeded(
    liveEvent: IncomingEvent,
    tenant: TenantId,
  ): Promise<readonly IncomingEvent[]> {
    const ref = this.opts.sessionPolicy.computeNativeRef(liveEvent);
    const existing = this.inFlight.get(ref);
    if (existing) return existing;
    const promise = this.runBackfill(liveEvent, tenant, ref);
    this.inFlight.set(ref, promise);
    try {
      return await promise;
    } finally {
      this.inFlight.delete(ref);
    }
  }

  private async runBackfill(
    liveEvent: IncomingEvent,
    tenant: TenantId,
    ref: ChannelNativeRef,
  ): Promise<readonly IncomingEvent[]> {
    const session = await this.opts.sessionStore.findOrCreate(
      this.opts.sessionPolicy.channelKind,
      ref,
      tenant,
    );
    if (session.metadata[SLACK_BACKFILLED_METADATA_KEY] === true) return [];

    const threading = readThreading(liveEvent.threading);
    const result = await this.opts.webClient.conversations.replies({
      channel: threading.channel,
      ts: threading.thread_ts,
      // Slack returns replies oldest-first, one page at a time. With
      // limit: 1000 (Slack's max), a thread of >1000 messages truncates
      // the MOST RECENT tail — i.e. the part the agent most needs for
      // context. Slack's 3-second ack budget rules out multi-page fetch
      // on the inbound hot path. Followup work: invert pagination (latest
      // first) and/or move backfill off the ack path if real threads
      // start hitting the cap.
      limit: 1000,
    });
    if (!result.ok || !result.messages) {
      throw new SlackHistoryBackfillError(
        `conversations.replies failed: ${result.error ?? 'no messages'}`,
      );
    }

    const synthetics: IncomingEvent[] = [];
    for (const msg of result.messages) {
      // bot_id filters bot's OWN past replies; msg.user is set on bot
      // messages too, so a `!msg.user` check would let them through. The
      // use case records all synthetic events as authorRole: 'user', so
      // recording bot replies as "user said" would corrupt agent context.
      // Bot history is dropped entirely until SessionStore gains a
      // direct write path that can record agent turns.
      if (msg.bot_id !== undefined) continue;
      if (!msg.user || !msg.ts) continue;
      if (msg.ts === threading.message_ts) continue;
      synthetics.push(buildSyntheticEvent(msg, threading));
    }

    await this.opts.sessionStore.setMetadata(session.id, {
      [SLACK_BACKFILLED_METADATA_KEY]: true,
    });
    return synthetics;
  }
}

interface BackfillMessage {
  readonly user?: string;
  readonly ts?: string;
  readonly text?: string;
  readonly bot_id?: string;
}

function readThreading(threading: ThreadingMetadata): SlackThreadingShape {
  const channel = threading.channel;
  const threadTs = threading.thread_ts;
  const messageTs = threading.message_ts;
  const teamId = threading.team_id;
  if (
    typeof channel !== 'string' ||
    typeof threadTs !== 'string' ||
    typeof messageTs !== 'string' ||
    typeof teamId !== 'string'
  ) {
    throw new SlackHistoryBackfillError(
      `live event threading missing slack keys: ${JSON.stringify(threading)}`,
    );
  }
  return { channel, thread_ts: threadTs, message_ts: messageTs, team_id: teamId };
}

function buildSyntheticEvent(msg: BackfillMessage, threading: SlackThreadingShape): IncomingEvent {
  const user = msg.user;
  const ts = msg.ts;
  if (!user || !ts) {
    throw new SlackHistoryBackfillError(
      `buildSyntheticEvent called with incomplete message: ${JSON.stringify(msg)}`,
    );
  }
  return {
    channelKind: SLACK_CHANNEL_KIND,
    channelNativeRef: slackNativeRef(threading.channel, threading.thread_ts),
    author: { channelUserId: user },
    payload: { text: msg.text ?? '' },
    threading: {
      channel: threading.channel,
      thread_ts: threading.thread_ts,
      message_ts: ts,
      team_id: threading.team_id,
    },
    receivedAt: slackTsToDate(ts),
    idempotencyKey: slackHistoryIdempotencyKey(ts),
    metadata: { [SYNTHETIC_EVENT_METADATA_KEY]: true },
  };
}
