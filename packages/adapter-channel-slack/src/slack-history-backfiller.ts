import {
  type IncomingEvent,
  type Logger,
  type SessionFirstTouch,
  type SessionFirstTouchInput,
  type SessionPolicy,
  type SessionStore,
  SYNTHETIC_EVENT_METADATA_KEY,
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
  readonly logger?: Logger;
}

export class SlackHistoryBackfillError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackHistoryBackfillError';
  }
}

const noopLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => noopLogger,
};

// Channel-agnostic core hook implemented for Slack: backfills prior thread
// messages as synthetic IncomingEvents the use case records as user turns
// before the live mention. Single-process dedup comes from the JobRunner
// per-key FIFO contract; multi-process race is re-confirmed via
// SessionStore.findByRef before any work runs.
export class SlackHistoryBackfiller implements SessionFirstTouch {
  private readonly opts: SlackHistoryBackfillerOptions;
  private readonly log: Logger;

  constructor(opts: SlackHistoryBackfillerOptions) {
    this.opts = opts;
    this.log = opts.logger ?? noopLogger;
  }

  async onFirstTouch(input: SessionFirstTouchInput): Promise<readonly IncomingEvent[]> {
    const { session, event } = input;

    // Closure snapshot wins the cheap path: when the use case captured a
    // session that was already marked backfilled, no Slack roundtrip
    // needed.
    if (session.metadata[SLACK_BACKFILLED_METADATA_KEY] === true) {
      this.log.info({ sessionId: session.id }, 'slack first-touch: skipped (already backfilled)');
      return [];
    }

    // Defense-in-depth for the per-key-FIFO + multi-process race: the
    // captured session is from BEFORE enqueue, so a sibling job (this
    // process or another) that finished backfilling between findOrCreate
    // and now is invisible to the closure. Re-read fresh.
    const ref = this.opts.sessionPolicy.computeNativeRef(event);
    const fresh = await this.opts.sessionStore.findByRef(
      this.opts.sessionPolicy.channelKind,
      ref,
      session.tenantId,
    );
    if (fresh !== null && fresh.metadata[SLACK_BACKFILLED_METADATA_KEY] === true) {
      this.log.info(
        { sessionId: session.id },
        'slack first-touch: skipped (already backfilled by sibling)',
      );
      return [];
    }

    const threading = readThreading(event.threading);
    const result = await this.opts.webClient.conversations.replies({
      channel: threading.channel,
      ts: threading.thread_ts,
      // Slack returns replies oldest-first, one page at a time. With
      // limit: 1000 (Slack's max), a thread of >1000 messages truncates
      // the MOST RECENT tail — i.e. the part the agent most needs for
      // context. Followup work: invert pagination (latest first) and/or
      // bulk-recordTurn for very long threads.
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
    this.log.info(
      { sessionId: session.id, synthetics: synthetics.length },
      'slack first-touch: backfilled N messages from conversations.replies',
    );
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
