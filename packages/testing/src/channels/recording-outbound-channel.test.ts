import { describe, expect, it } from 'vitest';
import { RecordingOutboundChannel } from './recording-outbound-channel.js';

describe('RecordingOutboundChannel', () => {
  it('records every reply call with target + content', async () => {
    const ch = new RecordingOutboundChannel('test');
    const target = { channelKind: 'test', channelNativeRef: 'thread-1' };
    const ack = await ch.reply(target, { text: 'hello' });
    expect(ch.replies).toEqual([{ target, content: { text: 'hello' } }]);
    expect(ack.messageId).toBe('msg-1');
  });

  it('issues monotonic message ids', async () => {
    const ch = new RecordingOutboundChannel();
    const target = { channelKind: 'test', channelNativeRef: 'thread-1' };
    const a = await ch.reply(target, { text: 'a' });
    const b = await ch.reply(target, { text: 'b' });
    expect(a.messageId).toBe('msg-1');
    expect(b.messageId).toBe('msg-2');
  });
});
