import { describe, expect, it, vi } from 'vitest';
import { runSlackCli } from './cli.js';

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

describe('runSlackCli', () => {
  it('prints usage and returns 1 on unknown command', async () => {
    const cap = captureIo();
    const code = await runSlackCli([], {}, cap.io);
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toContain('Usage');
  });

  it('verify-scopes returns 1 when SLACK_BOT_TOKEN is missing', async () => {
    const cap = captureIo();
    const code = await runSlackCli(['verify-scopes'], {}, cap.io);
    expect(code).toBe(1);
    expect(cap.err.join('\n')).toContain('SLACK_BOT_TOKEN');
  });

  it('verify-scopes returns 0 with bot identity line when all scopes are present', async () => {
    const cap = captureIo();
    const fetch = fakeFetch({
      grantedScopes: 'app_mentions:read,chat:write,channels:history,groups:history',
      body: { ok: true, user_id: 'U-BOT', team_id: 'T-TEAM' },
    });

    const code = await runSlackCli(
      ['verify-scopes'],
      { SLACK_BOT_TOKEN: 'xoxb-test' },
      cap.io,
      fetch,
    );

    expect(code).toBe(0);
    expect(cap.out.join('\n')).toContain('U-BOT');
    expect(cap.out.join('\n')).toContain('T-TEAM');
  });

  it('verify-scopes returns 1 with the missing-scope message when a scope is absent', async () => {
    const cap = captureIo();
    const fetch = fakeFetch({
      grantedScopes: 'app_mentions:read,chat:write',
      body: { ok: true, user_id: 'U-BOT', team_id: 'T-TEAM' },
    });

    const code = await runSlackCli(
      ['verify-scopes'],
      { SLACK_BOT_TOKEN: 'xoxb-test' },
      cap.io,
      fetch,
    );

    expect(code).toBe(1);
    expect(cap.err.join('\n')).toContain('channels:history');
  });
});
