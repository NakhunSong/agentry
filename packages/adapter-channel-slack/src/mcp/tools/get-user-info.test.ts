import type { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import { getUserInfo } from './get-user-info.js';

interface FakeUserResponse {
  readonly ok: boolean;
  readonly error?: string;
  readonly user?: Record<string, unknown>;
}

function fakeClient(responses: {
  info: (req: Record<string, unknown>) => Promise<FakeUserResponse>;
}): WebClient {
  return {
    users: { info: vi.fn(responses.info) },
  } as unknown as WebClient;
}

describe('getUserInfo', () => {
  it('returns mapped user data with display_name preferred from profile', async () => {
    const client = fakeClient({
      info: async () => ({
        ok: true,
        user: {
          id: 'U999',
          name: 'nakhun',
          real_name: 'Nakhun Song (top-level)',
          is_bot: false,
          tz: 'Asia/Seoul',
          profile: {
            display_name: 'nakhun',
            real_name: 'Nakhun Song',
          },
        },
      }),
    });

    const result = await getUserInfo(client, { user: 'U999' });

    expect(result.isError).toBeUndefined();
    const payload = JSON.parse(result.content[0].text) as {
      user: Record<string, unknown>;
    };
    expect(payload.user).toEqual({
      id: 'U999',
      name: 'nakhun',
      real_name: 'Nakhun Song',
      display_name: 'nakhun',
      is_bot: false,
      tz: 'Asia/Seoul',
    });
  });

  it('falls back to top-level real_name when profile.real_name is missing', async () => {
    const client = fakeClient({
      info: async () => ({
        ok: true,
        user: {
          id: 'U001',
          name: 'legacy-user',
          real_name: 'Legacy Real',
          is_bot: false,
          profile: {},
        },
      }),
    });

    const result = await getUserInfo(client, { user: 'U001' });

    const payload = JSON.parse(result.content[0].text) as { user: Record<string, unknown> };
    expect(payload.user.real_name).toBe('Legacy Real');
    expect(payload.user.display_name).toBeUndefined();
  });

  it('flags bots via is_bot=true', async () => {
    const client = fakeClient({
      info: async () => ({
        ok: true,
        user: {
          id: 'U-BOT',
          name: 'workflow-bot',
          is_bot: true,
          profile: { display_name: 'workflow-bot' },
        },
      }),
    });

    const result = await getUserInfo(client, { user: 'U-BOT' });

    const payload = JSON.parse(result.content[0].text) as { user: { is_bot: boolean } };
    expect(payload.user.is_bot).toBe(true);
  });

  it('returns isError=true when Slack responds with !ok', async () => {
    const client = fakeClient({
      info: async () => ({ ok: false, error: 'user_not_found' }),
    });

    const result = await getUserInfo(client, { user: 'U-MISSING' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('user_not_found');
  });

  it('returns isError=true when the underlying call throws', async () => {
    const client = fakeClient({
      info: async () => {
        throw new Error('network down');
      },
    });

    const result = await getUserInfo(client, { user: 'U-X' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('network down');
  });
});
