import type {
  ChannelKind,
  OutboundChannel,
  ReplyAck,
  ReplyContent,
  ReplyTarget,
} from '@agentry/core';

export interface RecordedReply {
  readonly target: ReplyTarget;
  readonly content: ReplyContent;
}

export class RecordingOutboundChannel implements OutboundChannel {
  readonly kind: ChannelKind;
  private readonly captured: RecordedReply[] = [];

  constructor(kind: ChannelKind = 'test') {
    this.kind = kind;
  }

  get replies(): readonly RecordedReply[] {
    return this.captured;
  }

  async reply(target: ReplyTarget, content: ReplyContent): Promise<ReplyAck> {
    this.captured.push({ target, content });
    return {
      messageId: `msg-${this.captured.length}`,
      postedAt: new Date(),
    };
  }
}
