import type {
  ChannelKind,
  InboundChannel,
  IncomingEvent,
  OutboundChannel,
  SessionPolicy,
} from '@agentry/core';
import { RecordingOutboundChannel, StaticSessionPolicy } from '@agentry/testing';
import type { Pool } from 'pg';
import { describe, expect, it, vi } from 'vitest';
import { compose } from './compose.js';
import type { AgentryConfig } from './config/agentry-config.js';
import type { Secrets } from './config/secrets.js';

const config: AgentryConfig = {
  agentWorkdir: '/tmp/agent-workdir',
  logging: { level: 'info' },
};

const secrets: Secrets = {
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_SIGNING_SECRET: 'secret',
  POSTGRES_URL: 'postgresql://test/test',
  VOYAGE_API_KEY: 'voyage-test',
};

interface StubPool {
  readonly query: ReturnType<typeof vi.fn>;
  readonly end: ReturnType<typeof vi.fn>;
}

function makeStubPool(): { pool: StubPool; asPool: Pool } {
  const stub: StubPool = {
    query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    end: vi.fn().mockResolvedValue(undefined),
  };
  return { pool: stub, asPool: stub as unknown as Pool };
}

describe('compose', () => {
  it('passes secrets.POSTGRES_URL through poolFactory', async () => {
    const { asPool } = makeStubPool();
    const poolFactory = vi.fn().mockReturnValue(asPool);

    const handles = await compose({ config, secrets, poolFactory });
    await handles.shutdown();

    expect(poolFactory).toHaveBeenCalledTimes(1);
    expect(poolFactory).toHaveBeenCalledWith('postgresql://test/test');
  });

  it('returns expected adapter kinds and an empty inboundChannels list by default', async () => {
    const { asPool } = makeStubPool();
    const handles = await compose({
      config,
      secrets,
      poolFactory: () => asPool,
    });

    expect(handles.agentRunner.kind).toBe('claude_cli');
    expect(handles.embeddingProvider.model).toBe('voyage-3.5');
    expect(handles.inboundChannels).toEqual([]);

    await handles.shutdown();
  });

  it('drains the JobRunner before ending the Pool', async () => {
    const { pool, asPool } = makeStubPool();
    const order: string[] = [];
    pool.end.mockImplementationOnce(async () => {
      order.push('pool.end');
    });

    const handles = await compose({
      config,
      secrets,
      poolFactory: () => asPool,
    });

    const drainSpy = vi.spyOn(handles.jobRunner, 'drain').mockImplementation(async () => {
      order.push('jobRunner.drain');
    });

    await handles.shutdown();

    expect(order).toEqual(['jobRunner.drain', 'pool.end']);
    expect(pool.end).toHaveBeenCalledTimes(1);
    drainSpy.mockRestore();
  });

  it('plumbs custom session policies and outbound channels into handleIncoming', async () => {
    const { asPool } = makeStubPool();
    const policy = new StaticSessionPolicy({ channelKind: 'test' });
    const outbound = new RecordingOutboundChannel('test');
    const sessionPolicies = new Map<ChannelKind, SessionPolicy>([['test', policy]]);
    const outboundChannels = new Map<ChannelKind, OutboundChannel>([['test', outbound]]);

    const handles = await compose({
      config,
      secrets,
      poolFactory: () => asPool,
      sessionPolicies,
      outboundChannels,
    });

    const event: IncomingEvent = {
      channelKind: 'unregistered',
      channelNativeRef: 'thread-x',
      author: { channelUserId: 'u1' },
      payload: { text: 'hi' },
      threading: {},
      receivedAt: new Date(),
      idempotencyKey: 'k1',
    };
    await expect(handles.handleIncoming(event)).rejects.toThrow(/SessionPolicy/);
    expect(outbound.replies).toHaveLength(0);

    await handles.shutdown();
  });

  it('writes pino output to the supplied logger destination', async () => {
    const { asPool } = makeStubPool();
    const chunks: string[] = [];
    const destination = {
      write(chunk: string | Uint8Array): boolean {
        chunks.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8'));
        return true;
      },
    } as NodeJS.WritableStream;

    const handles = await compose({
      config,
      secrets,
      poolFactory: () => asPool,
      loggerDestination: destination,
    });

    handles.logger.info({ probe: true }, 'compose-test-marker');
    await handles.shutdown();

    const merged = chunks.join('');
    expect(merged).toContain('compose-test-marker');
    expect(merged).toContain('"probe":true');
  });

  it('returns supplied inboundChannels untouched in handles', async () => {
    const { asPool } = makeStubPool();
    const inbound: InboundChannel[] = [
      {
        kind: 'test',
        async start() {},
      },
    ];

    const handles = await compose({
      config,
      secrets,
      poolFactory: () => asPool,
      inboundChannels: inbound,
    });

    expect(handles.inboundChannels).toBe(inbound);
    await handles.shutdown();
  });
});
