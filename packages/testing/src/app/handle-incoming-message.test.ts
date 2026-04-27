import type {
  AgentEvent,
  AgentRunInput,
  AgentRunner,
  ChannelKind,
  HandleIncomingMessageDeps,
  IncomingEvent,
  OutboundChannel,
  SessionPolicy,
} from '@agentry/core';
import { makeHandleIncomingMessage } from '@agentry/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { RecordingAgentRunner } from '../agent-runner/recording-agent-runner.js';
import { RecordingOutboundChannel } from '../channels/recording-outbound-channel.js';
import { InMemoryJobRunner } from '../job-runner/in-memory-job-runner.js';
import { InMemoryKnowledgeStore } from '../knowledge-store/in-memory-knowledge-store.js';
import { silentLogger } from '../logger/silent-logger.js';
import { StaticSessionPolicy } from '../session-policy/static-session-policy.js';
import { InMemorySessionStore } from '../session-store/in-memory-session-store.js';

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}
function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeEvent(overrides: Partial<IncomingEvent> = {}): IncomingEvent {
  return {
    channelKind: 'test',
    channelNativeRef: 'thread-1',
    author: { channelUserId: 'u1' },
    payload: { text: 'hello' },
    threading: {},
    receivedAt: new Date(),
    idempotencyKey: `k-${Math.random().toString(36).slice(2)}`,
    ...overrides,
  };
}

interface Harness {
  readonly handle: ReturnType<typeof makeHandleIncomingMessage>;
  readonly sessionStore: InMemorySessionStore;
  readonly knowledgeStore: InMemoryKnowledgeStore;
  readonly jobRunner: InMemoryJobRunner;
  readonly outbound: RecordingOutboundChannel;
  readonly errors: Array<{ err: unknown; key: string }>;
}

function buildHarness(
  overrides: {
    readonly agentRunner?: AgentRunner;
    readonly sessionPolicies?: ReadonlyMap<ChannelKind, SessionPolicy>;
    readonly outboundChannels?: ReadonlyMap<ChannelKind, OutboundChannel>;
  } = {},
): Harness {
  const sessionStore = new InMemorySessionStore();
  const knowledgeStore = new InMemoryKnowledgeStore();
  const errors: Array<{ err: unknown; key: string }> = [];
  const jobRunner = new InMemoryJobRunner({
    onError: (err, key) => errors.push({ err, key }),
  });
  const outbound = new RecordingOutboundChannel('test');
  const agentRunner =
    overrides.agentRunner ??
    new RecordingAgentRunner([
      { type: 'text_delta', text: 'reply' },
      { type: 'finished', reason: 'complete', usage: { input: 1, output: 2 } },
    ]);

  const deps: HandleIncomingMessageDeps = {
    sessionStore,
    knowledgeStore,
    agentRunner,
    jobRunner,
    sessionPolicies:
      overrides.sessionPolicies ??
      new Map([['test', new StaticSessionPolicy({ channelKind: 'test' })]]),
    outboundChannels: overrides.outboundChannels ?? new Map([['test', outbound]]),
    resolveTenant: () => 'tenant-1',
    agentWorkdir: '/tmp/agent-workdir',
    logger: silentLogger,
  };

  return {
    handle: makeHandleIncomingMessage(deps),
    sessionStore,
    knowledgeStore,
    jobRunner,
    outbound,
    errors,
  };
}

describe('makeHandleIncomingMessage', () => {
  let harness: Harness;
  beforeEach(() => {
    harness = buildHarness();
  });

  it('records user + agent turns and posts reply on happy path', async () => {
    await harness.handle(makeEvent({ payload: { text: 'hi there' } }));
    await harness.jobRunner.drain();

    const session = await harness.sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const turns = await harness.sessionStore.getRecentTurns(session.id, 100);

    expect(turns).toHaveLength(2);
    expect(turns[0]?.authorRole).toBe('user');
    expect(turns[0]?.contentText).toBe('hi there');
    expect(turns[1]?.authorRole).toBe('agent');
    expect(turns[1]?.contentText).toBe('reply');
    expect(turns[1]?.metadata?.['finishReason']).toBe('complete');
    expect(turns[1]?.metadata?.['usage']).toEqual({ input: 1, output: 2 });

    expect(harness.outbound.replies).toHaveLength(1);
    expect(harness.outbound.replies[0]?.content).toEqual({ text: 'reply' });
    expect(harness.errors).toHaveLength(0);
  });

  it('only records user turn for synthetic events (history-only)', async () => {
    await harness.handle(
      makeEvent({ payload: { text: 'past msg' }, metadata: { synthetic: true } }),
    );
    await harness.jobRunner.drain();

    const session = await harness.sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const turns = await harness.sessionStore.getRecentTurns(session.id, 100);

    expect(turns.map((t) => t.authorRole)).toEqual(['user']);
    expect(harness.outbound.replies).toHaveLength(0);
  });

  it('serializes events on the same nativeRef through JobRunner (FIFO)', async () => {
    const gate = deferred<void>();
    let calls = 0;
    const runner: AgentRunner = {
      kind: 'gated',
      async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
        calls += 1;
        if (calls === 1) await gate.promise;
        yield { type: 'text_delta', text: `to:${input.prompt}` };
        yield { type: 'finished', reason: 'complete', usage: { input: 0, output: 0 } };
      },
    };
    harness = buildHarness({ agentRunner: runner });

    await harness.handle(makeEvent({ payload: { text: 'a' }, idempotencyKey: 'a' }));
    await harness.handle(makeEvent({ payload: { text: 'b' }, idempotencyKey: 'b' }));

    // Let the first job start and gate. Second job is queued behind.
    await new Promise<void>((r) => setImmediate(r));

    const session = await harness.sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const midTurns = await harness.sessionStore.getRecentTurns(session.id, 100);
    expect(midTurns.map((t) => t.contentText)).toEqual(['a']);

    gate.resolve();
    await harness.jobRunner.drain();

    const finalTurns = await harness.sessionStore.getRecentTurns(session.id, 100);
    expect(finalTurns.map((t) => t.contentText)).toEqual(['a', 'to:a', 'b', 'to:b']);
  });

  it('records agent turn with finishReason=error and skips reply on error event', async () => {
    harness = buildHarness({
      agentRunner: new RecordingAgentRunner([
        { type: 'text_delta', text: 'partial' },
        { type: 'error', message: 'boom', recoverable: false },
      ]),
    });
    await harness.handle(makeEvent());
    await harness.jobRunner.drain();

    const session = await harness.sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const turns = await harness.sessionStore.getRecentTurns(session.id, 100);
    expect(turns).toHaveLength(2);
    expect(turns[1]?.metadata?.['finishReason']).toBe('error');
    expect(harness.outbound.replies).toHaveLength(0);
  });

  it('records agent turn with finishReason=aborted and skips reply', async () => {
    harness = buildHarness({
      agentRunner: new RecordingAgentRunner([
        { type: 'text_delta', text: 'partial' },
        { type: 'finished', reason: 'aborted', usage: { input: 0, output: 0 } },
      ]),
    });
    await harness.handle(makeEvent());
    await harness.jobRunner.drain();

    const session = await harness.sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const turns = await harness.sessionStore.getRecentTurns(session.id, 100);
    expect(turns[1]?.metadata?.['finishReason']).toBe('aborted');
    expect(harness.outbound.replies).toHaveLength(0);
  });

  it('throws synchronously when no SessionPolicy matches the channel kind', async () => {
    harness = buildHarness({ sessionPolicies: new Map() });
    await expect(harness.handle(makeEvent())).rejects.toThrow(/SessionPolicy/);
  });

  it('records both turns then surfaces missing OutboundChannel via JobRunner.onError', async () => {
    harness = buildHarness({ outboundChannels: new Map() });
    await harness.handle(makeEvent());
    await harness.jobRunner.drain();

    const session = await harness.sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const turns = await harness.sessionStore.getRecentTurns(session.id, 100);
    expect(turns).toHaveLength(2);
    expect(harness.outbound.replies).toHaveLength(0);
    expect(harness.errors).toHaveLength(1);
    expect((harness.errors[0]?.err as Error).message).toMatch(/OutboundChannel/);
    expect(harness.errors[0]?.key).toBe(session.id);
  });
});
