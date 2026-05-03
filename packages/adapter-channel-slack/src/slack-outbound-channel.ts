import type {
  ChannelKind,
  OutboundChannel,
  ReplyAck,
  ReplyContent,
  ReplyTarget,
} from '@agentry/core';
import { WebClient } from '@slack/web-api';
import { SLACK_CHANNEL_KIND } from './slack-channel-kinds.js';
import { slackTsToDate } from './slack-conventions.js';

export interface SlackOutboundChannelOptions {
  readonly botToken: string;
  // Shared WebClient seam. Production: the composition root passes one
  // client to both the outbound channel (for chat.postMessage) and the
  // history backfiller (for conversations.replies) so both share a
  // connection pool. Tests: inject a mock with the methods the test
  // exercises.
  readonly client?: WebClient;
}

interface SlackThreadingShape {
  readonly channel?: unknown;
  readonly thread_ts?: unknown;
}

export class SlackOutboundChannelError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackOutboundChannelError';
  }
}

export class SlackOutboundChannel implements OutboundChannel {
  readonly kind: ChannelKind = SLACK_CHANNEL_KIND;
  private readonly client: WebClient;

  constructor(opts: SlackOutboundChannelOptions) {
    this.client = opts.client ?? new WebClient(opts.botToken);
  }

  async reply(target: ReplyTarget, content: ReplyContent): Promise<ReplyAck> {
    const threading = (target.threading ?? {}) as SlackThreadingShape;
    const channel = typeof threading.channel === 'string' ? threading.channel : undefined;
    const threadTs = typeof threading.thread_ts === 'string' ? threading.thread_ts : undefined;
    if (!channel || !threadTs) {
      throw new SlackOutboundChannelError(
        `Slack reply requires threading.channel and threading.thread_ts; got ${JSON.stringify(threading)}`,
      );
    }

    const result = await this.client.chat.postMessage({
      channel,
      thread_ts: threadTs,
      text: content.text,
    });
    if (!result.ok || !result.ts) {
      throw new SlackOutboundChannelError(
        `chat.postMessage failed: ${result.error ?? 'response missing ts'}`,
      );
    }

    return {
      messageId: result.ts,
      postedAt: slackTsToDate(result.ts),
      metadata: { channel, thread_ts: threadTs },
    };
  }
}
