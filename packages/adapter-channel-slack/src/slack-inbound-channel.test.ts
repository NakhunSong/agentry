import type { IncomingEvent, Logger, TenantId } from '@agentry/core';
import type { App } from '@slack/bolt';
import { describe, expect, it, vi } from 'vitest';
import type { SlackHistoryBackfiller } from './slack-history-backfiller.js';
import { SlackInboundChannel } from './slack-inbound-channel.js';

// dep-cruiser forbids adapter-* → @agentry/testing imports (the testing
// package is wired only into core's use-case tests and runtime). The
// silentLogger duplication here is the layering tax for keeping adapters
// self-contained.
const silentLogger: Logger = {
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  fatal: () => {},
  child: () => silentLogger,
};

type AppMentionHandler = (ctx: { event: object; body: object; logger: Logger }) => Promise<void>;

interface FakeAppShape {
  readonly app: App;
  readonly captured: { handler?: AppMentionHandler; startPort?: number; stopped: boolean };
}

function fakeApp(): FakeAppShape {
  const captured: FakeAppShape['captured'] = { stopped: false };
  const app = {
    event: vi.fn().mockImplementation((type: string, h: AppMentionHandler) => {
      if (type === 'app_mention') captured.handler = h;
    }),
    start: vi.fn().mockImplementation(async (port: number) => {
      captured.startPort = port;
    }),
    stop: vi.fn().mockImplementation(async () => {
      captured.stopped = true;
    }),
  } as unknown as App;
  return { app, captured };
}

function fakeFetchOk(grantedScopes: string[]): typeof globalThis.fetch {
  return (async () =>
    ({
      headers: {
        get: (n: string) => (n.toLowerCase() === 'x-oauth-scopes' ? grantedScopes.join(',') : null),
      },
      json: async () => ({ ok: true, user_id: 'UBOT', team_id: 'T1' }),
      ok: true,
      status: 200,
    }) as unknown as Response) as typeof globalThis.fetch;
}

async function waitForHandler(
  captured: FakeAppShape['captured'],
): Promise<NonNullable<FakeAppShape['captured']['handler']>> {
  await vi.waitFor(() => {
    expect(captured.handler).toBeDefined();
  });
  if (!captured.handler) throw new Error('app_mention handler was not registered');
  return captured.handler;
}

const baseOpts = {
  botToken: 'xoxb-test-token',
  signingSecret: 'sigsecret',
  port: 3001,
  requiredScopes: ['app_mentions:read', 'chat:write'],
};

describe('SlackInboundChannel', () => {
  it('declares slack channelKind', () => {
    const ch = new SlackInboundChannel(baseOpts);
    expect(ch.kind).toBe('slack');
  });

  it('returns immediately when signal is already aborted, with no side effects', async () => {
    const { app, captured } = fakeApp();
    const ac = new AbortController();
    ac.abort();
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      fetch: fakeFetchOk(['chat:write']),
    });
    await ch.start(async () => {}, ac.signal);
    expect(captured.startPort).toBeUndefined();
    expect(captured.handler).toBeUndefined();
    expect(captured.stopped).toBe(false);
  });

  it('throws if scope verification fails (missing scope)', async () => {
    const { app } = fakeApp();
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      fetch: fakeFetchOk(['chat:write']),
    });
    const ac = new AbortController();
    await expect(ch.start(async () => {}, ac.signal)).rejects.toThrow(/missing required scopes/);
  });

  it('binds Bolt listener on configured port and registers an app_mention handler', async () => {
    const { app, captured } = fakeApp();
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      fetch: fakeFetchOk(['app_mentions:read', 'chat:write']),
    });
    const ac = new AbortController();
    const startPromise = ch.start(async () => {}, ac.signal);
    await waitForHandler(captured);
    await vi.waitFor(() => {
      expect(captured.startPort).toBe(3001);
    });
    ac.abort();
    await startPromise;
    expect(captured.stopped).toBe(true);
  });

  it('throws if start() is called twice on the same instance', async () => {
    const { app, captured } = fakeApp();
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      fetch: fakeFetchOk(['app_mentions:read', 'chat:write']),
    });
    const ac = new AbortController();
    const first = ch.start(async () => {}, ac.signal);
    await waitForHandler(captured);
    await expect(ch.start(async () => {}, ac.signal)).rejects.toThrow(/single-shot/);
    ac.abort();
    await first;
  });

  it('forwards mapped IncomingEvent to handler when app_mention fires', async () => {
    const { app, captured } = fakeApp();
    const seen: IncomingEvent[] = [];
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      fetch: fakeFetchOk(['app_mentions:read', 'chat:write']),
    });
    const ac = new AbortController();
    const startPromise = ch.start(async (e) => {
      seen.push(e);
    }, ac.signal);
    const handler = await waitForHandler(captured);

    await handler({
      event: {
        type: 'app_mention',
        user: 'U1',
        text: 'hi',
        ts: '1700000123.000200',
        thread_ts: '1700000000.000100',
        channel: 'C9',
        event_ts: '1700000123.000200',
      },
      body: { event_id: 'EvX', team_id: 'T1' },
      logger: silentLogger,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      channelKind: 'slack',
      channelNativeRef: 'slack:C9:1700000000.000100',
      idempotencyKey: 'EvX',
    });

    ac.abort();
    await startPromise;
  });

  it('forwards synthetic events from the backfiller before the live event', async () => {
    const { app, captured } = fakeApp();
    const seen: IncomingEvent[] = [];
    const synthetic: IncomingEvent = {
      channelKind: 'slack',
      channelNativeRef: 'slack:C9:1700000000.000100',
      author: { channelUserId: 'U9' },
      payload: { text: 'historical' },
      threading: {
        channel: 'C9',
        thread_ts: '1700000000.000100',
        message_ts: '1700000050.000100',
        team_id: 'T1',
      },
      receivedAt: new Date(1_700_000_050_000),
      idempotencyKey: 'slack-history:1700000050.000100',
      metadata: { synthetic: true },
    };
    const backfiller = {
      backfillIfNeeded: vi.fn(async () => [synthetic]),
    } as unknown as SlackHistoryBackfiller;
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      backfiller,
      fetch: fakeFetchOk(['app_mentions:read', 'chat:write', 'channels:history', 'groups:history']),
    });
    const ac = new AbortController();
    const startPromise = ch.start(async (e) => {
      seen.push(e);
    }, ac.signal);
    const handler = await waitForHandler(captured);

    await handler({
      event: {
        type: 'app_mention',
        user: 'U1',
        text: 'hi',
        ts: '1700000123.000200',
        thread_ts: '1700000000.000100',
        channel: 'C9',
        event_ts: '1700000123.000200',
      },
      body: { event_id: 'EvX', team_id: 'T1' },
      logger: silentLogger,
    });

    expect(seen.map((e) => e.idempotencyKey)).toEqual(['slack-history:1700000050.000100', 'EvX']);

    ac.abort();
    await startPromise;
  });

  it('still forwards the live event when the backfiller throws (warn logged)', async () => {
    const { app, captured } = fakeApp();
    const seen: IncomingEvent[] = [];
    const warnLog = vi.fn();
    const logger: Logger = { ...silentLogger, warn: warnLog };
    const backfiller = {
      backfillIfNeeded: vi.fn(async () => {
        throw new Error('rate_limited');
      }),
    } as unknown as SlackHistoryBackfiller;
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      backfiller,
      logger,
      fetch: fakeFetchOk(['app_mentions:read', 'chat:write', 'channels:history', 'groups:history']),
    });
    const ac = new AbortController();
    const startPromise = ch.start(async (e) => {
      seen.push(e);
    }, ac.signal);
    const handler = await waitForHandler(captured);

    await handler({
      event: {
        type: 'app_mention',
        user: 'U1',
        text: 'hi',
        ts: '1700000123.000200',
        thread_ts: '1700000000.000100',
        channel: 'C9',
        event_ts: '1700000123.000200',
      },
      body: { event_id: 'EvX', team_id: 'T1' },
      logger,
    });

    expect(seen.map((e) => e.idempotencyKey)).toEqual(['EvX']);
    expect(warnLog).toHaveBeenCalledOnce();

    ac.abort();
    await startPromise;
  });

  it('passes the resolveTenant result to the backfiller', async () => {
    const { app, captured } = fakeApp();
    const backfillIfNeeded = vi.fn(async () => []);
    const backfiller = { backfillIfNeeded } as unknown as SlackHistoryBackfiller;
    const resolveTenant = vi.fn((_e: IncomingEvent): TenantId => 'tenant-A');
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      backfiller,
      resolveTenant,
      fetch: fakeFetchOk(['app_mentions:read', 'chat:write', 'channels:history', 'groups:history']),
    });
    const ac = new AbortController();
    const startPromise = ch.start(async () => {}, ac.signal);
    const handler = await waitForHandler(captured);

    await handler({
      event: {
        type: 'app_mention',
        user: 'U1',
        text: 'hi',
        ts: '1700000123.000200',
        thread_ts: '1700000000.000100',
        channel: 'C9',
        event_ts: '1700000123.000200',
      },
      body: { event_id: 'EvX', team_id: 'T1' },
      logger: silentLogger,
    });

    expect(resolveTenant).toHaveBeenCalledOnce();
    expect(backfillIfNeeded).toHaveBeenCalledWith(
      expect.objectContaining({ idempotencyKey: 'EvX' }),
      'tenant-A',
    );

    ac.abort();
    await startPromise;
  });

  it('logs and swallows handler errors so Bolt still acks the request', async () => {
    const { app, captured } = fakeApp();
    const errorLog = vi.fn();
    const logger: Logger = { ...silentLogger, error: errorLog };
    const ch = new SlackInboundChannel({
      ...baseOpts,
      app,
      logger,
      fetch: fakeFetchOk(['app_mentions:read', 'chat:write']),
    });
    const ac = new AbortController();
    const startPromise = ch.start(async () => {
      throw new Error('boom');
    }, ac.signal);
    const handler = await waitForHandler(captured);

    await handler({
      event: {
        type: 'app_mention',
        user: 'U1',
        text: 'hi',
        ts: '1.0',
        thread_ts: '1.0',
        channel: 'C9',
        event_ts: '1.0',
      },
      body: { event_id: 'EvX', team_id: 'T1' },
      logger,
    });

    expect(errorLog).toHaveBeenCalledOnce();
    ac.abort();
    await startPromise;
  });
});
