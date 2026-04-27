import { describe, expect, it } from 'vitest';
import { SlackScopeError, verifySlackScopes } from './slack-scope-verifier.js';

interface FakeAuthTestArgs {
  readonly grantedHeader: string | null;
  readonly body: object;
  readonly status?: number;
}

function fakeFetch({
  grantedHeader,
  body,
  status = 200,
}: FakeAuthTestArgs): typeof globalThis.fetch {
  return (async (_input: unknown, init?: RequestInit) => {
    const auth = init?.headers && (init.headers as Record<string, string>).Authorization;
    if (auth !== 'Bearer xoxb-test-token') {
      throw new Error(`Unexpected Authorization header: ${String(auth)}`);
    }
    return {
      headers: {
        get: (name: string) => (name.toLowerCase() === 'x-oauth-scopes' ? grantedHeader : null),
      },
      json: async () => body,
      ok: status >= 200 && status < 300,
      status,
    } as unknown as Response;
  }) as typeof globalThis.fetch;
}

describe('verifySlackScopes', () => {
  it('returns auth info when all required scopes are granted', async () => {
    const fetch = fakeFetch({
      grantedHeader: 'app_mentions:read,chat:write,channels:history',
      body: { ok: true, user_id: 'UBOT', team_id: 'T1' },
    });
    const info = await verifySlackScopes(
      'xoxb-test-token',
      ['app_mentions:read', 'chat:write'],
      fetch,
    );
    expect(info).toEqual({
      botUserId: 'UBOT',
      teamId: 'T1',
      grantedScopes: ['app_mentions:read', 'chat:write', 'channels:history'],
    });
  });

  it('throws SlackScopeError listing every missing scope', async () => {
    const fetch = fakeFetch({
      grantedHeader: 'chat:write',
      body: { ok: true, user_id: 'UBOT', team_id: 'T1' },
    });
    await expect(
      verifySlackScopes(
        'xoxb-test-token',
        ['app_mentions:read', 'chat:write', 'channels:history'],
        fetch,
      ),
    ).rejects.toMatchObject({
      name: 'SlackScopeError',
      message: expect.stringContaining('[app_mentions:read, channels:history]'),
    });
  });

  it('throws when auth.test returns ok:false', async () => {
    const fetch = fakeFetch({
      grantedHeader: 'chat:write',
      body: { ok: false, error: 'invalid_auth' },
    });
    await expect(verifySlackScopes('xoxb-test-token', [], fetch)).rejects.toThrow(SlackScopeError);
  });

  it('throws when response is missing user_id or team_id', async () => {
    const fetch = fakeFetch({
      grantedHeader: 'chat:write',
      body: { ok: true },
    });
    await expect(verifySlackScopes('xoxb-test-token', [], fetch)).rejects.toThrow(SlackScopeError);
  });

  it('treats absent x-oauth-scopes header as empty grant', async () => {
    const fetch = fakeFetch({
      grantedHeader: null,
      body: { ok: true, user_id: 'UBOT', team_id: 'T1' },
    });
    await expect(verifySlackScopes('xoxb-test-token', ['chat:write'], fetch)).rejects.toThrow(
      SlackScopeError,
    );
  });
});
