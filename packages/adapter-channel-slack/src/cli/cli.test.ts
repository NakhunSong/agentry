import type { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import { SLACK_REQUIRED_SCOPES } from '../slack-inbound-channel.js';
import { runSlackCli, type SlackWebClientFactory } from './cli.js';

interface CapturedIo {
  readonly out: string[];
  readonly err: string[];
  readonly io: { out: (msg: string) => void; err: (msg: string) => void };
}

function captureIo(): CapturedIo {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (msg) => out.push(msg),
      err: (msg) => err.push(msg),
    },
  };
}

const ALL_GRANTED_SCOPES = SLACK_REQUIRED_SCOPES.join(',');

function fakeFetch(init: {
  readonly status?: number;
  readonly grantedScopes: string;
  readonly body: { ok: boolean; user_id?: string; team_id?: string; error?: string };
}): typeof globalThis.fetch {
  return vi.fn(
    async () =>
      new Response(JSON.stringify(init.body), {
        status: init.status ?? 200,
        headers: { 'x-oauth-scopes': init.grantedScopes },
      }),
  ) as unknown as typeof globalThis.fetch;
}

interface FakeWebClientResponses {
  readonly conversationsList?: (req: Record<string, unknown>) => Promise<{
    ok: boolean;
    error?: string;
    channels?: readonly Record<string, unknown>[];
  }>;
  readonly chatPostMessage?: (req: Record<string, unknown>) => Promise<{
    ok: boolean;
    ts?: string;
    error?: string;
  }>;
}

function fakeWebClient(responses: FakeWebClientResponses): {
  factory: SlackWebClientFactory;
  conversationsList: ReturnType<typeof vi.fn>;
  chatPostMessage: ReturnType<typeof vi.fn>;
} {
  const conversationsList = vi.fn(
    responses.conversationsList ?? (async () => ({ ok: true, channels: [] })),
  );
  const chatPostMessage = vi.fn(
    responses.chatPostMessage ?? (async () => ({ ok: true, ts: '1.0' })),
  );
  const client = {
    conversations: { list: conversationsList },
    chat: { postMessage: chatPostMessage },
  } as unknown as WebClient;
  return { factory: () => client, conversationsList, chatPostMessage };
}

describe('runSlackCli', () => {
  it('prints usage and returns 1 on unknown command', async () => {
    const cap = captureIo();
    const code = await runSlackCli([], { env: {}, io: cap.io });
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toContain('Usage');
  });

  describe('verify-scopes', () => {
    it('returns 1 when SLACK_BOT_TOKEN is missing', async () => {
      const cap = captureIo();
      const code = await runSlackCli(['verify-scopes'], { env: {}, io: cap.io });
      expect(code).toBe(1);
      expect(cap.err.join('\n')).toContain('SLACK_BOT_TOKEN');
    });

    it('returns 0 with bot identity line when all scopes are present', async () => {
      const cap = captureIo();
      const fetchImpl = fakeFetch({
        grantedScopes: ALL_GRANTED_SCOPES,
        body: { ok: true, user_id: 'U-BOT', team_id: 'T-TEAM' },
      });

      const code = await runSlackCli(['verify-scopes'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-test' },
        io: cap.io,
        fetchImpl,
      });

      expect(code).toBe(0);
      expect(cap.out.join('\n')).toContain('U-BOT');
      expect(cap.out.join('\n')).toContain('T-TEAM');
    });

    it('returns 1 with the missing-scope message when a scope is absent', async () => {
      const cap = captureIo();
      // Drop users:read to simulate a partial install.
      const fetchImpl = fakeFetch({
        grantedScopes: SLACK_REQUIRED_SCOPES.filter((s) => s !== 'users:read').join(','),
        body: { ok: true, user_id: 'U-BOT', team_id: 'T-TEAM' },
      });

      const code = await runSlackCli(['verify-scopes'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-test' },
        io: cap.io,
        fetchImpl,
      });

      expect(code).toBe(1);
      expect(cap.err.join('\n')).toContain('users:read');
    });
  });

  describe('list-channels', () => {
    it('returns 1 when SLACK_BOT_TOKEN is missing', async () => {
      const cap = captureIo();
      const code = await runSlackCli(['list-channels'], { env: {}, io: cap.io });
      expect(code).toBe(1);
      expect(cap.err.join('\n')).toContain('SLACK_BOT_TOKEN');
    });

    it('lists only channels where the bot is a member', async () => {
      const cap = captureIo();
      const { factory } = fakeWebClient({
        conversationsList: async () => ({
          ok: true,
          channels: [
            { id: 'C001', name: 'general', is_member: true, is_private: false },
            { id: 'C002', name: 'random', is_member: false, is_private: false },
            { id: 'G003', name: 'private-room', is_member: true, is_private: true },
          ],
        }),
      });

      const code = await runSlackCli(['list-channels'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-test' },
        io: cap.io,
        webClientFactory: factory,
      });

      expect(code).toBe(0);
      const out = cap.out.join('\n');
      expect(out).toContain('C001');
      expect(out).toContain('general');
      expect(out).toContain('public');
      expect(out).toContain('G003');
      expect(out).toContain('private-room');
      expect(out).toContain('private');
      expect(out).not.toContain('C002');
    });

    it('prints a hint when the bot is in zero channels', async () => {
      const cap = captureIo();
      const { factory } = fakeWebClient({
        conversationsList: async () => ({
          ok: true,
          channels: [{ id: 'C001', name: 'general', is_member: false, is_private: false }],
        }),
      });

      const code = await runSlackCli(['list-channels'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-test' },
        io: cap.io,
        webClientFactory: factory,
      });

      expect(code).toBe(0);
      expect(cap.out.join('\n')).toContain('invite the bot');
    });

    it('returns 1 when conversations.list fails', async () => {
      const cap = captureIo();
      const { factory } = fakeWebClient({
        conversationsList: async () => ({ ok: false, error: 'missing_scope' }),
      });

      const code = await runSlackCli(['list-channels'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-test' },
        io: cap.io,
        webClientFactory: factory,
      });

      expect(code).toBe(1);
      expect(cap.err.join('\n')).toContain('missing_scope');
    });
  });

  describe('send-test-message', () => {
    it('returns 1 when SLACK_BOT_TOKEN is missing', async () => {
      const cap = captureIo();
      const code = await runSlackCli(['send-test-message', '--channel', 'C1'], {
        env: {},
        io: cap.io,
      });
      expect(code).toBe(1);
      expect(cap.err.join('\n')).toContain('SLACK_BOT_TOKEN');
    });

    it('returns 1 when --channel is missing', async () => {
      const cap = captureIo();
      const { factory } = fakeWebClient({});
      const code = await runSlackCli(['send-test-message'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-test' },
        io: cap.io,
        webClientFactory: factory,
      });
      expect(code).toBe(1);
      expect(cap.err.join('\n')).toContain('--channel');
    });

    it('posts with a default text when --text is not provided', async () => {
      const cap = captureIo();
      const { factory, chatPostMessage } = fakeWebClient({
        chatPostMessage: async () => ({ ok: true, ts: '1700000000.000100' }),
      });
      const code = await runSlackCli(['send-test-message', '--channel', 'C1'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-test' },
        io: cap.io,
        webClientFactory: factory,
      });
      expect(code).toBe(0);
      expect(cap.out.join('\n')).toContain('1700000000.000100');
      expect(chatPostMessage).toHaveBeenCalledWith({
        channel: 'C1',
        text: 'agentry-slack send-test-message smoke',
      });
    });

    it('forwards --text and --thread-ts to chat.postMessage', async () => {
      const cap = captureIo();
      const { factory, chatPostMessage } = fakeWebClient({
        chatPostMessage: async () => ({ ok: true, ts: '2.0' }),
      });
      const code = await runSlackCli(
        [
          'send-test-message',
          '--channel',
          'C1',
          '--text',
          'hello',
          '--thread-ts',
          '1700000000.000100',
        ],
        {
          env: { SLACK_BOT_TOKEN: 'xoxb-test' },
          io: cap.io,
          webClientFactory: factory,
        },
      );
      expect(code).toBe(0);
      expect(chatPostMessage).toHaveBeenCalledWith({
        channel: 'C1',
        text: 'hello',
        thread_ts: '1700000000.000100',
      });
    });

    it('returns 1 when chat.postMessage fails', async () => {
      const cap = captureIo();
      const { factory } = fakeWebClient({
        chatPostMessage: async () => ({ ok: false, error: 'channel_not_found' }),
      });
      const code = await runSlackCli(['send-test-message', '--channel', 'C1'], {
        env: { SLACK_BOT_TOKEN: 'xoxb-test' },
        io: cap.io,
        webClientFactory: factory,
      });
      expect(code).toBe(1);
      expect(cap.err.join('\n')).toContain('channel_not_found');
    });
  });
});
