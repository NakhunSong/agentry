import type { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import { getChannelHistory } from './get-channel-history.js';

interface FakeHistoryResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly messages?: readonly Record<string, unknown>[];
}

function fakeClient(responses: {
  history: (req: Record<string, unknown>) => Promise<FakeHistoryResponse>;
}): WebClient {
  return {
    conversations: { history: vi.fn(responses.history) },
  } as unknown as WebClient;
}

describe('getChannelHistory', () => {
  it('returns messages with bot_id preserved', async () => {
    const client = fakeClient({
      history: async () => ({
        ok: true,
        messages: [
          { ts: '1.0', user: 'U1', text: 'hello' },
          { ts: '2.0', bot_id: 'B999', username: 'workflow-bot', text: 'QA report' },
          { ts: '3.0', user: 'U2', text: 'reply', thread_ts: '1.0' },
        ],
      }),
    });

    const result = await getChannelHistory(client, { channel: 'C123' });

    expect(result.isError).toBeUndefined();
    expect(result.content).toHaveLength(1);
    const payload = JSON.parse(result.content[0].text) as {
      messages: readonly Record<string, unknown>[];
    };
    expect(payload.messages).toEqual([
      { ts: '1.0', user: 'U1', text: 'hello' },
      { ts: '2.0', bot_id: 'B999', username: 'workflow-bot', text: 'QA report' },
      { ts: '3.0', user: 'U2', text: 'reply', thread_ts: '1.0' },
    ]);
  });

  it('passes limit and since through to Slack', async () => {
    const historyMock = vi.fn(async () => ({ ok: true, messages: [] }));
    const client = fakeClient({ history: historyMock });

    await getChannelHistory(client, { channel: 'C123', limit: 25, since: 1700000000 });

    expect(historyMock).toHaveBeenCalledWith({
      channel: 'C123',
      limit: 25,
      oldest: '1700000000',
    });
  });

  it('uses default limit when none is provided', async () => {
    const historyMock = vi.fn(async () => ({ ok: true, messages: [] }));
    const client = fakeClient({ history: historyMock });

    await getChannelHistory(client, { channel: 'C123' });

    const call = historyMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(call.limit).toBe(50);
    expect(call.oldest).toBeUndefined();
  });

  it('returns isError=true when Slack responds with !ok', async () => {
    const client = fakeClient({
      history: async () => ({ ok: false, error: 'channel_not_found' }),
    });

    const result = await getChannelHistory(client, { channel: 'C123' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('channel_not_found');
  });

  it('returns isError=true when the underlying call throws', async () => {
    const client = fakeClient({
      history: async () => {
        throw new Error('network down');
      },
    });

    const result = await getChannelHistory(client, { channel: 'C123' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network down');
  });
});
