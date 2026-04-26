import { describe, expect, it } from 'vitest';
import type {
  ChannelKind,
  ChannelNativeRef,
  DistillationCriteria,
  Session,
  SessionId,
  SessionStatus,
  TenantId,
  Turn,
  TurnInput,
} from '../index.js';
import type { SessionStore } from './session-store.js';

// Compile + runtime smoke: a minimal in-memory implementation proves the
// interface is implementable without false constraints. Concrete adapter
// (PgvectorSessionStore) lands in its own package.
function buildFake(): SessionStore {
  const sessions = new Map<SessionId, Session>();
  const turnsBySession = new Map<SessionId, Turn[]>();
  const sessionByKey = new Map<string, SessionId>();
  let sessionCounter = 0;
  let turnCounter = 0;
  let nextSeq = 1n;

  return {
    async findOrCreate(
      channelKind: ChannelKind,
      channelNativeRef: ChannelNativeRef,
      tenantId: TenantId,
    ): Promise<Session> {
      const key = `${tenantId}|${channelKind}|${channelNativeRef}`;
      const existingId = sessionByKey.get(key);
      const existing = existingId ? sessions.get(existingId) : undefined;
      if (existing) return existing;

      sessionCounter += 1;
      const now = new Date();
      const session: Session = {
        id: `sess-${sessionCounter}`,
        tenantId,
        channelKind,
        channelNativeRef,
        startedAt: now,
        lastActiveAt: now,
        status: 'active',
        participants: [],
        metadata: {},
        distilledThroughSeqNo: 0n,
      };
      sessions.set(session.id, session);
      sessionByKey.set(key, session.id);
      turnsBySession.set(session.id, []);
      return session;
    },

    async recordTurn(sessionId: SessionId, input: TurnInput): Promise<Turn> {
      turnCounter += 1;
      const turn: Turn = {
        ...input,
        id: `turn-${turnCounter}`,
        seqNo: nextSeq,
        sessionId,
        createdAt: new Date(),
      };
      nextSeq += 1n;
      const list = turnsBySession.get(sessionId) ?? [];
      list.push(turn);
      turnsBySession.set(sessionId, list);
      return turn;
    },

    async getRecentTurns(sessionId: SessionId, limit: number): Promise<readonly Turn[]> {
      const all = turnsBySession.get(sessionId) ?? [];
      return all.slice(-limit);
    },

    async updateStatus(sessionId: SessionId, status: SessionStatus): Promise<void> {
      const existing = sessions.get(sessionId);
      if (!existing) return;
      sessions.set(sessionId, { ...existing, status });
    },

    async setMetadata(
      sessionId: SessionId,
      patch: Readonly<Record<string, unknown>>,
    ): Promise<void> {
      const existing = sessions.get(sessionId);
      if (!existing) return;
      sessions.set(sessionId, {
        ...existing,
        metadata: { ...existing.metadata, ...patch },
      });
    },

    async listSessionsForDistillation(
      criteria: DistillationCriteria,
    ): Promise<readonly SessionId[]> {
      if (criteria.kind === 'idle') {
        return [...sessions.values()].filter((s) => s.status === 'idle').map((s) => s.id);
      }
      // session_ended | manual | rolling all target a specific session
      return sessions.has(criteria.sessionId) ? [criteria.sessionId] : [];
    },
  };
}

describe('SessionStore port', () => {
  it('admits a minimal in-memory implementation', async () => {
    const store = buildFake();

    const a = await store.findOrCreate('slack', 'slack:C1:1.0', 'default');
    const aAgain = await store.findOrCreate('slack', 'slack:C1:1.0', 'default');
    expect(aAgain.id).toBe(a.id);

    const b = await store.findOrCreate('slack', 'slack:C2:2.0', 'default');
    expect(b.id).not.toBe(a.id);

    const userTurn = await store.recordTurn(a.id, {
      authorRole: 'user',
      contentText: 'hello',
    });
    expect(userTurn.seqNo).toBe(1n);

    const agentTurn = await store.recordTurn(a.id, {
      authorRole: 'agent',
      contentText: 'hi back',
      metadata: { usage: { input: 6, output: 7 } },
    });
    expect(agentTurn.seqNo).toBe(2n);

    const recent = await store.getRecentTurns(a.id, 5);
    expect(recent.map((t) => t.contentText)).toEqual(['hello', 'hi back']);

    await store.updateStatus(a.id, 'idle');
    await store.setMetadata(a.id, { synthetic_count: 0 });
  });

  it('listSessionsForDistillation handles all four trigger shapes', async () => {
    const store = buildFake();
    const a = await store.findOrCreate('cli', 'cli:1', 'default');
    await store.updateStatus(a.id, 'idle');

    const idle = await store.listSessionsForDistillation({
      kind: 'idle',
      idleSinceMin: 60,
    });
    expect(idle).toContain(a.id);

    const ended = await store.listSessionsForDistillation({
      kind: 'session_ended',
      sessionId: a.id,
    });
    expect(ended).toEqual([a.id]);

    const manual = await store.listSessionsForDistillation({
      kind: 'manual',
      sessionId: a.id,
    });
    expect(manual).toEqual([a.id]);

    const rolling = await store.listSessionsForDistillation({
      kind: 'rolling',
      sessionId: a.id,
      everyNTurns: 20,
    });
    expect(rolling).toEqual([a.id]);
  });
});
