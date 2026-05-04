import type {
  ChannelKind,
  HandleIncomingMessageDeps,
  IncomingEvent,
  Logger,
  OutboundChannel,
  Session,
  SessionFirstTouch,
  SessionFirstTouchInput,
  SessionPolicy,
  SessionStore,
  TenantId,
} from '@agentry/core';
import { makeHandleIncomingMessage, SYNTHETIC_EVENT_METADATA_KEY } from '@agentry/core';
import { describe, expect, it, vi } from 'vitest';
import { RecordingAgentRunner } from '../agent-runner/recording-agent-runner.js';
import { RecordingOutboundChannel } from '../channels/recording-outbound-channel.js';
import { InMemoryJobRunner } from '../job-runner/in-memory-job-runner.js';
import { InMemoryKnowledgeStore } from '../knowledge-store/in-memory-knowledge-store.js';
import { silentLogger } from '../logger/silent-logger.js';
import { StaticSessionPolicy } from '../session-policy/static-session-policy.js';
import { InMemorySessionStore } from '../session-store/in-memory-session-store.js';
import { type Deferred, deferred } from '../test-utils/deferred.js';

const BACKFILLED_KEY = 'backfilled';

function makeEvent(idempotencyKey: string, text: string): IncomingEvent {
  return {
    channelKind: 'test',
    channelNativeRef: 'thread-1',
    author: { channelUserId: 'u1' },
    payload: { text },
    threading: {},
    receivedAt: new Date(),
    idempotencyKey,
  };
}

function makeAgentRunner(): RecordingAgentRunner {
  return new RecordingAgentRunner([
    { type: 'text_delta', text: 'reply' },
    { type: 'finished', reason: 'complete', usage: { input: 0, output: 0 } },
  ]);
}

// Test-only first-touch impl that mirrors the production contract:
// closure-snapshot check → fresh re-read via SessionStore → "slow path"
// (counted) only when both say not-yet-done. Slow path can be paused via
// `slowPathGate` to model an in-flight backfill.
class TestFirstTouch implements SessionFirstTouch {
  slowPathCalls = 0;
  slowPathGate: Deferred<void> | null = null;
  constructor(
    private readonly store: SessionStore,
    private readonly policy: SessionPolicy,
  ) {}

  async onFirstTouch(input: SessionFirstTouchInput): Promise<readonly IncomingEvent[]> {
    const { session, event } = input;
    if (session.metadata[BACKFILLED_KEY] === true) return [];
    const fresh = await this.store.findByRef(
      this.policy.channelKind,
      this.policy.computeNativeRef(event),
      session.tenantId,
    );
    if (fresh !== null && fresh.metadata[BACKFILLED_KEY] === true) return [];

    this.slowPathCalls += 1;
    if (this.slowPathGate !== null) await this.slowPathGate.promise;

    await this.store.setMetadata(session.id, { [BACKFILLED_KEY]: true });
    return [
      {
        channelKind: 'test',
        channelNativeRef: event.channelNativeRef,
        author: { channelUserId: 'past-user' },
        payload: { text: 'past msg' },
        threading: {},
        receivedAt: new Date(),
        idempotencyKey: `synth-${event.idempotencyKey}`,
        metadata: { [SYNTHETIC_EVENT_METADATA_KEY]: true },
      },
    ];
  }
}

interface RaceHarness {
  readonly handle: ReturnType<typeof makeHandleIncomingMessage>;
  readonly sessionStore: InMemorySessionStore;
  readonly jobRunner: InMemoryJobRunner;
  readonly outbound: RecordingOutboundChannel;
  readonly firstTouch: TestFirstTouch;
}

function buildHarness(): RaceHarness {
  const sessionStore = new InMemorySessionStore();
  const knowledgeStore = new InMemoryKnowledgeStore();
  const jobRunner = new InMemoryJobRunner();
  const outbound = new RecordingOutboundChannel('test');
  const policy = new StaticSessionPolicy({ channelKind: 'test' });
  const firstTouch = new TestFirstTouch(sessionStore, policy);

  const deps: HandleIncomingMessageDeps = {
    sessionStore,
    knowledgeStore,
    agentRunner: makeAgentRunner(),
    jobRunner,
    sessionPolicies: new Map<ChannelKind, SessionPolicy>([['test', policy]]),
    outboundChannels: new Map<ChannelKind, OutboundChannel>([['test', outbound]]),
    sessionFirstTouches: new Map<ChannelKind, SessionFirstTouch>([['test', firstTouch]]),
    resolveTenant: () => 'tenant-1' as TenantId,
    agentWorkdir: '/tmp/agent-workdir',
    logger: silentLogger,
  };

  return {
    handle: makeHandleIncomingMessage(deps),
    sessionStore,
    jobRunner,
    outbound,
    firstTouch,
  };
}

describe('makeHandleIncomingMessage — sessionFirstTouch integration', () => {
  it('runs onFirstTouch before processOneTurn and records synthetic + live turns', async () => {
    const h = buildHarness();
    await h.handle(makeEvent('live-1', 'live mention'));
    await h.jobRunner.drain();

    const session = await h.sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const turns = await h.sessionStore.getRecentTurns(session.id, 100);

    expect(h.firstTouch.slowPathCalls).toBe(1);
    expect(turns.map((t) => t.contentText)).toEqual(['past msg', 'live mention', 'reply']);
    expect(h.outbound.replies.map((r) => r.content.text)).toEqual(['reply']);
  });

  it('JobRunner per-key FIFO ensures synthetics are not double-fetched across queued mentions', async () => {
    const h = buildHarness();
    h.firstTouch.slowPathGate = deferred<void>();

    // Mention 1 enqueues; its job starts and pauses inside onFirstTouch.
    await h.handle(makeEvent('live-1', 'first'));
    // Yield so the queued job actually starts and hits the gate.
    await new Promise<void>((r) => setImmediate(r));
    expect(h.firstTouch.slowPathCalls).toBe(1);

    // Mention 2 enqueues while mention 1 is paused. Use case captures a
    // session snapshot whose metadata still lacks `backfilled` (mention 1
    // hasn't reached setMetadata yet). The captured snapshot is the
    // "stale closure" the impl must re-confirm via findByRef.
    await h.handle(makeEvent('live-2', 'second'));

    // Release mention 1: it sets metadata[backfilled]=true and returns
    // synthetic, then live processing runs. Mention 2's job runs next:
    // its closure snapshot says false but findByRef now says true →
    // returns [] without entering the slow path.
    h.firstTouch.slowPathGate.resolve();
    await h.jobRunner.drain();

    expect(h.firstTouch.slowPathCalls).toBe(1);

    const session = await h.sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const turns = await h.sessionStore.getRecentTurns(session.id, 100);
    // Mention 1: synthetic + live + agent. Mention 2: live + agent only
    // (no synthetic because first-touch returned []).
    expect(turns.map((t) => t.contentText)).toEqual([
      'past msg',
      'first',
      'reply',
      'second',
      'reply',
    ]);
  });

  it('proceeds with live event when onFirstTouch throws (failure is swallowed and warn-logged)', async () => {
    // Inline rewire — not worth threading a broken-impl override through buildHarness for one case.
    const broken: SessionFirstTouch = {
      onFirstTouch: async () => {
        throw new Error('backfill blew up');
      },
    };
    const warnSpy = vi.fn();
    const recordingLogger: Logger = {
      ...silentLogger,
      warn: warnSpy,
      child: () => recordingLogger,
    };
    const sessionStore = new InMemorySessionStore();
    const jobRunner = new InMemoryJobRunner();
    const outbound = new RecordingOutboundChannel('test');
    const policy = new StaticSessionPolicy({ channelKind: 'test' });
    const handle = makeHandleIncomingMessage({
      sessionStore,
      knowledgeStore: new InMemoryKnowledgeStore(),
      agentRunner: makeAgentRunner(),
      jobRunner,
      sessionPolicies: new Map([['test', policy]]),
      outboundChannels: new Map([['test', outbound]]),
      sessionFirstTouches: new Map([['test', broken]]),
      resolveTenant: () => 'tenant-1',
      agentWorkdir: '/tmp/agent-workdir',
      logger: recordingLogger,
    });

    await handle(makeEvent('live-1', 'live mention'));
    await jobRunner.drain();

    const session: Session = await sessionStore.findOrCreate('test', 'thread-1', 'tenant-1');
    const turns = await sessionStore.getRecentTurns(session.id, 100);
    expect(turns.map((t) => t.contentText)).toEqual(['live mention', 'reply']);
    expect(outbound.replies).toHaveLength(1);
    // Regression guard: removing the catch's log.warn would silently
    // hide first-touch failures.
    expect(warnSpy).toHaveBeenCalledOnce();
    const [calledWith] = warnSpy.mock.calls;
    expect(calledWith?.[1]).toMatch(/first-touch failed/);
  });
});
