import {
  type ChannelKind,
  type ChannelNativeRef,
  type DistillationCriteria,
  type IncomingEvent,
  type Session,
  type SessionId,
  type SessionLifecycleEvent,
  type SessionPolicy,
  type SessionStatus,
  type SessionStore,
  SYNTHETIC_EVENT_METADATA_KEY,
  type TenantId,
  type Turn,
  type TurnInput,
} from '@agentry/core';
import type { WebClient } from '@slack/web-api';
import { describe, expect, it, vi } from 'vitest';
import { SLACK_CHANNEL_KIND } from './slack-channel-kinds.js';
import {
  SLACK_BACKFILLED_METADATA_KEY,
  SlackHistoryBackfillError,
  SlackHistoryBackfiller,
} from './slack-history-backfiller.js';

interface ConversationsRepliesMessage {
  readonly user?: string;
  readonly ts?: string;
  readonly text?: string;
  readonly bot_id?: string;
}

interface ConversationsRepliesResult {
  readonly ok: boolean;
  readonly error?: string;
  readonly messages?: readonly ConversationsRepliesMessage[];
}

function makeWebClient(
  replies: (args: {
    channel: string;
    ts: string;
    limit: number;
  }) => Promise<ConversationsRepliesResult>,
): WebClient {
  return {
    conversations: {
      replies: vi.fn(replies),
    },
  } as unknown as WebClient;
}

function makeSession(overrides: Partial<Session> = {}): Session {
  const now = new Date('2026-04-01T00:00:00Z');
  return {
    id: 'sess-1' as SessionId,
    tenantId: 'default' as TenantId,
    channelKind: SLACK_CHANNEL_KIND,
    channelNativeRef: 'slack:C9:1700000000.000100',
    startedAt: now,
    lastActiveAt: now,
    status: 'active' as SessionStatus,
    participants: [],
    metadata: {},
    distilledThroughSeqNo: 0n,
    ...overrides,
  };
}

interface FakeSessionStore extends SessionStore {
  readonly findOrCreateMock: ReturnType<typeof vi.fn>;
  readonly setMetadataMock: ReturnType<typeof vi.fn>;
}

function makeSessionStore(initial: Session = makeSession()): FakeSessionStore {
  let current = initial;
  const findOrCreateMock = vi.fn(async () => current);
  const setMetadataMock = vi.fn(
    async (_id: SessionId, patch: Readonly<Record<string, unknown>>) => {
      current = { ...current, metadata: { ...current.metadata, ...patch } };
    },
  );
  return {
    findOrCreate: findOrCreateMock as SessionStore['findOrCreate'],
    setMetadata: setMetadataMock as SessionStore['setMetadata'],
    recordTurn: vi.fn(async (_id: SessionId, _t: TurnInput): Promise<Turn> => {
      throw new Error('not used');
    }),
    getRecentTurns: vi.fn(async (_id: SessionId, _l: number) => []),
    updateStatus: vi.fn(async (_id: SessionId, _s: SessionStatus) => {}),
    listSessionsForDistillation: vi.fn(async (_c: DistillationCriteria) => []),
    findOrCreateMock,
    setMetadataMock,
  };
}

class StubSlackPolicy implements SessionPolicy {
  readonly channelKind: ChannelKind = SLACK_CHANNEL_KIND;
  computeNativeRef(event: IncomingEvent): ChannelNativeRef {
    return event.channelNativeRef;
  }
  idleTimeoutMinutes(): number {
    return 1440;
  }
  shouldEndOn(_event: SessionLifecycleEvent): boolean {
    return false;
  }
}

const liveEvent: IncomingEvent = {
  channelKind: SLACK_CHANNEL_KIND,
  channelNativeRef: 'slack:C9:1700000000.000100',
  author: { channelUserId: 'U1' },
  payload: { text: '<@UBOT> hi' },
  threading: {
    channel: 'C9',
    thread_ts: '1700000000.000100',
    message_ts: '1700000123.000200',
    team_id: 'T1',
  },
  receivedAt: new Date(1_700_000_123_000),
  idempotencyKey: 'EvLive',
};

describe('SlackHistoryBackfiller', () => {
  it('returns [] without calling Slack when session is already backfilled', async () => {
    const store = makeSessionStore(
      makeSession({ metadata: { [SLACK_BACKFILLED_METADATA_KEY]: true } }),
    );
    const repliesFn = vi.fn();
    const webClient = makeWebClient(repliesFn);
    const backfiller = new SlackHistoryBackfiller({
      webClient,
      sessionStore: store,
      sessionPolicy: new StubSlackPolicy(),
    });

    const result = await backfiller.backfillIfNeeded(liveEvent, 'default');

    expect(result).toEqual([]);
    expect(repliesFn).not.toHaveBeenCalled();
    expect(store.setMetadataMock).not.toHaveBeenCalled();
  });

  it('maps prior thread messages to synthetic IncomingEvents in chronological order', async () => {
    const store = makeSessionStore();
    const repliesFn = vi.fn(async () => ({
      ok: true,
      messages: [
        { user: 'U1', ts: '1700000000.000100', text: 'first' },
        { user: 'U2', ts: '1700000050.000100', text: 'reply' },
        { user: 'U1', ts: '1700000123.000200', text: 'live ignored' },
      ],
    }));
    const backfiller = new SlackHistoryBackfiller({
      webClient: makeWebClient(repliesFn),
      sessionStore: store,
      sessionPolicy: new StubSlackPolicy(),
    });

    const result = await backfiller.backfillIfNeeded(liveEvent, 'default');

    expect(result).toHaveLength(2);
    expect(result.map((e) => e.idempotencyKey)).toEqual([
      'slack-history:1700000000.000100',
      'slack-history:1700000050.000100',
    ]);
    const [first] = result;
    expect(first).toMatchObject({
      channelKind: SLACK_CHANNEL_KIND,
      channelNativeRef: 'slack:C9:1700000000.000100',
      author: { channelUserId: 'U1' },
      payload: { text: 'first' },
      metadata: { [SYNTHETIC_EVENT_METADATA_KEY]: true },
    });
    expect(first?.threading).toEqual({
      channel: 'C9',
      thread_ts: '1700000000.000100',
      message_ts: '1700000000.000100',
      team_id: 'T1',
    });
  });

  it('excludes bot_id messages so bot replies are not recorded as user turns', async () => {
    const store = makeSessionStore();
    const repliesFn = vi.fn(async () => ({
      ok: true,
      messages: [
        { user: 'U1', ts: '1700000000.000100', text: 'human' },
        { user: 'UBOT', bot_id: 'B123', ts: '1700000010.000100', text: 'bot says' },
        { user: 'U2', ts: '1700000050.000100', text: 'human 2' },
      ],
    }));
    const backfiller = new SlackHistoryBackfiller({
      webClient: makeWebClient(repliesFn),
      sessionStore: store,
      sessionPolicy: new StubSlackPolicy(),
    });

    const result = await backfiller.backfillIfNeeded(liveEvent, 'default');

    expect(result.map((e) => e.author.channelUserId)).toEqual(['U1', 'U2']);
  });

  it('marks the session backfilled after a successful first run', async () => {
    const store = makeSessionStore();
    const backfiller = new SlackHistoryBackfiller({
      webClient: makeWebClient(async () => ({ ok: true, messages: [] })),
      sessionStore: store,
      sessionPolicy: new StubSlackPolicy(),
    });

    await backfiller.backfillIfNeeded(liveEvent, 'default');

    expect(store.setMetadataMock).toHaveBeenCalledWith('sess-1', {
      [SLACK_BACKFILLED_METADATA_KEY]: true,
    });
  });

  it('throws SlackHistoryBackfillError when conversations.replies returns ok: false', async () => {
    const store = makeSessionStore();
    const backfiller = new SlackHistoryBackfiller({
      webClient: makeWebClient(async () => ({ ok: false, error: 'channel_not_found' })),
      sessionStore: store,
      sessionPolicy: new StubSlackPolicy(),
    });

    await expect(backfiller.backfillIfNeeded(liveEvent, 'default')).rejects.toBeInstanceOf(
      SlackHistoryBackfillError,
    );
    expect(store.setMetadataMock).not.toHaveBeenCalled();
  });

  it('collapses concurrent first-touch calls into a single Slack API request', async () => {
    const store = makeSessionStore();
    let resolve!: (value: ConversationsRepliesResult) => void;
    const inflight = new Promise<ConversationsRepliesResult>((r) => {
      resolve = r;
    });
    const repliesFn = vi.fn(async () => inflight);
    const backfiller = new SlackHistoryBackfiller({
      webClient: makeWebClient(repliesFn),
      sessionStore: store,
      sessionPolicy: new StubSlackPolicy(),
    });

    const a = backfiller.backfillIfNeeded(liveEvent, 'default');
    const b = backfiller.backfillIfNeeded(liveEvent, 'default');

    await vi.waitFor(() => {
      expect(repliesFn).toHaveBeenCalledTimes(1);
    });
    resolve({ ok: true, messages: [] });
    const [resA, resB] = await Promise.all([a, b]);
    expect(repliesFn).toHaveBeenCalledTimes(1);
    expect(resA).toEqual([]);
    expect(resB).toEqual([]);
  });

  it('does not poison the lock when a backfill throws — next call retries', async () => {
    const store = makeSessionStore();
    let calls = 0;
    const repliesFn = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { ok: false, error: 'rate_limited' };
      return { ok: true, messages: [] };
    });
    const backfiller = new SlackHistoryBackfiller({
      webClient: makeWebClient(repliesFn),
      sessionStore: store,
      sessionPolicy: new StubSlackPolicy(),
    });

    await expect(backfiller.backfillIfNeeded(liveEvent, 'default')).rejects.toBeInstanceOf(
      SlackHistoryBackfillError,
    );
    const second = await backfiller.backfillIfNeeded(liveEvent, 'default');
    expect(second).toEqual([]);
    expect(repliesFn).toHaveBeenCalledTimes(2);
  });
});
