import { describe, expect, it } from 'vitest';
import type { ReplyAck, ReplyContent, ReplyTarget } from '../domain/channel.js';
import type { OutboundChannel } from './outbound-channel.js';

interface RecordedCall {
  readonly target: ReplyTarget;
  readonly content: ReplyContent;
}

function buildFake(): OutboundChannel & { readonly calls: readonly RecordedCall[] } {
  const calls: RecordedCall[] = [];
  let counter = 0;
  return {
    kind: 'fake',
    get calls() {
      return calls;
    },
    async reply(target, content): Promise<ReplyAck> {
      calls.push({ target, content });
      counter += 1;
      return {
        messageId: `m-${counter}`,
        postedAt: new Date(0),
      };
    },
  };
}

describe('OutboundChannel port', () => {
  it('admits a minimal in-memory implementation', async () => {
    const channel = buildFake();
    expect(channel.kind).toBe('fake');

    const ack = await channel.reply(
      {
        channelKind: 'fake',
        channelNativeRef: 'fake:1',
        threading: { thread_ts: '1.0' },
      },
      { text: 'hello' },
    );

    expect(ack.messageId).toBe('m-1');
    expect(ack.postedAt).toBeInstanceOf(Date);
    expect(channel.calls).toHaveLength(1);
    expect(channel.calls[0]?.target.channelNativeRef).toBe('fake:1');
    expect(channel.calls[0]?.content.text).toBe('hello');
  });

  it('admits a target without threading metadata', async () => {
    const channel = buildFake();
    await channel.reply(
      { channelKind: 'fake', channelNativeRef: 'fake:dm:1' },
      { text: 'in a DM' },
    );
    expect(channel.calls[0]?.target.threading).toBeUndefined();
  });
});
