import type { ReplyTarget } from '@agentry/core';
import type { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import { SlackOutboundChannel, SlackOutboundChannelError } from './slack-outbound-channel.js';

interface PostMessageArgs {
  readonly channel: string;
  readonly thread_ts?: string;
  readonly text: string;
}

function fakeClient(
  postMessage: (args: PostMessageArgs) => Promise<{ ok: boolean; ts?: string; error?: string }>,
): WebClient {
  return {
    chat: {
      postMessage: vi.fn().mockImplementation(postMessage),
    },
  } as unknown as WebClient;
}

const target: ReplyTarget = {
  channelKind: 'slack',
  channelNativeRef: 'slack:C9876:1700000000.000100',
  threading: {
    channel: 'C9876',
    thread_ts: '1700000000.000100',
    message_ts: '1700000123.000200',
  },
};

describe('SlackOutboundChannel', () => {
  it('declares slack channelKind', () => {
    const ch = new SlackOutboundChannel({
      botToken: 'xoxb-x',
      client: fakeClient(async () => ({ ok: true, ts: '1.0' })),
    });
    expect(ch.kind).toBe('slack');
  });

  it('calls chat.postMessage with channel + thread_ts + text', async () => {
    const seen: PostMessageArgs[] = [];
    const client = fakeClient(async (args) => {
      seen.push(args);
      return { ok: true, ts: '1700000456.789000' };
    });
    const ch = new SlackOutboundChannel({ botToken: 'xoxb-x', client });
    const ack = await ch.reply(target, { text: 'hello' });

    expect(seen).toEqual([{ channel: 'C9876', thread_ts: '1700000000.000100', text: 'hello' }]);
    expect(ack.messageId).toBe('1700000456.789000');
    expect(ack.postedAt.getTime()).toBe(1700000456789);
    expect(ack.metadata).toEqual({ channel: 'C9876', thread_ts: '1700000000.000100' });
  });

  it('throws SlackOutboundChannelError when threading is incomplete', async () => {
    const ch = new SlackOutboundChannel({
      botToken: 'xoxb-x',
      client: fakeClient(async () => ({ ok: true, ts: '1.0' })),
    });
    const incomplete: ReplyTarget = {
      channelKind: 'slack',
      channelNativeRef: 'slack:C9876:1.0',
      threading: { channel: 'C9876' },
    };
    await expect(ch.reply(incomplete, { text: 'hi' })).rejects.toThrow(SlackOutboundChannelError);
  });

  it('propagates Slack API errors via SlackOutboundChannelError', async () => {
    const ch = new SlackOutboundChannel({
      botToken: 'xoxb-x',
      client: fakeClient(async () => ({ ok: false, error: 'channel_not_found' })),
    });
    await expect(ch.reply(target, { text: 'hi' })).rejects.toMatchObject({
      name: 'SlackOutboundChannelError',
      message: expect.stringContaining('channel_not_found'),
    });
  });

  it('throws when response is missing ts even with ok:true', async () => {
    const ch = new SlackOutboundChannel({
      botToken: 'xoxb-x',
      client: fakeClient(async () => ({ ok: true })),
    });
    await expect(ch.reply(target, { text: 'hi' })).rejects.toThrow(SlackOutboundChannelError);
  });
});
