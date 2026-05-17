import type {
  ChannelKind,
  ChannelNativeRef,
  DistillationCriteria,
  Session,
  SessionId,
  SessionStatus,
  SessionStore,
  TenantId,
  Turn,
  TurnId,
  TurnInput,
} from '@agentry/core';

export class InMemorySessionStore implements SessionStore {
  private readonly sessions = new Map<SessionId, Session>();
  private readonly turns = new Map<SessionId, Turn[]>();
  private readonly nativeIndex = new Map<string, SessionId>();
  // Mirrors the pgvector `(session_id, idempotency_key)` partial unique
  // index — the in-memory adapter doesn't race (use case enters recordTurn
  // serialized per-session via JobRunner), but the dedup is here so port
  // semantics behave identically to the production adapter under tests.
  private readonly idempotencyIndex = new Map<string, Turn>();
  private sessionSeq = 0;
  private turnSeq = 0;

  private indexKey(kind: ChannelKind, ref: ChannelNativeRef, tenant: TenantId): string {
    return `${kind}|${ref}|${tenant}`;
  }

  private idempotencyIndexKey(sessionId: SessionId, idempotencyKey: string): string {
    return `${sessionId}|${idempotencyKey}`;
  }

  async findOrCreate(
    channelKind: ChannelKind,
    channelNativeRef: ChannelNativeRef,
    tenantId: TenantId,
  ): Promise<Session> {
    const key = this.indexKey(channelKind, channelNativeRef, tenantId);
    const existingId = this.nativeIndex.get(key);
    if (existingId !== undefined) {
      const existing = this.sessions.get(existingId);
      if (existing) return existing;
    }
    this.sessionSeq += 1;
    const id: SessionId = `session-${this.sessionSeq}`;
    const now = new Date();
    const created: Session = {
      id,
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
    this.sessions.set(id, created);
    this.nativeIndex.set(key, id);
    this.turns.set(id, []);
    return created;
  }

  async findByRef(
    channelKind: ChannelKind,
    channelNativeRef: ChannelNativeRef,
    tenantId: TenantId,
  ): Promise<Session | null> {
    const key = this.indexKey(channelKind, channelNativeRef, tenantId);
    const existingId = this.nativeIndex.get(key);
    if (existingId === undefined) return null;
    return this.sessions.get(existingId) ?? null;
  }

  async recordTurn(sessionId: SessionId, turn: TurnInput): Promise<Turn> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    const idempotencyKey = turn.idempotencyKey ?? null;
    if (idempotencyKey !== null) {
      const existing = this.idempotencyIndex.get(
        this.idempotencyIndexKey(sessionId, idempotencyKey),
      );
      if (existing) return existing;
    }
    const list = this.turns.get(sessionId) ?? [];
    this.turnSeq += 1;
    const turnId: TurnId = `turn-${this.turnSeq}`;
    const seqNo = BigInt(list.length + 1);
    // Build the Turn explicitly — TurnInput.idempotencyKey is optional/string
    // while Turn.idempotencyKey is required/string|null. A spread + override
    // would conflate the two; spelling out the fields keeps the type contract
    // visible. If TurnInput grows a new optional field, add it here.
    const created: Turn = {
      authorRole: turn.authorRole,
      ...(turn.authorRef !== undefined ? { authorRef: turn.authorRef } : {}),
      contentText: turn.contentText,
      ...(turn.contentExtra !== undefined ? { contentExtra: turn.contentExtra } : {}),
      ...(turn.metadata !== undefined ? { metadata: turn.metadata } : {}),
      id: turnId,
      seqNo,
      sessionId,
      createdAt: new Date(),
      idempotencyKey,
    };
    list.push(created);
    this.turns.set(sessionId, list);
    this.sessions.set(sessionId, { ...session, lastActiveAt: new Date() });
    if (idempotencyKey !== null) {
      this.idempotencyIndex.set(this.idempotencyIndexKey(sessionId, idempotencyKey), created);
    }
    return created;
  }

  async getRecentTurns(sessionId: SessionId, limit: number): Promise<readonly Turn[]> {
    const list = this.turns.get(sessionId) ?? [];
    if (limit >= list.length) return [...list];
    return list.slice(list.length - limit);
  }

  async updateStatus(sessionId: SessionId, status: SessionStatus): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, { ...session, status });
  }

  async setMetadata(sessionId: SessionId, patch: Readonly<Record<string, unknown>>): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    this.sessions.set(sessionId, {
      ...session,
      metadata: { ...session.metadata, ...patch },
    });
  }

  async listSessionsForDistillation(
    _criteria: DistillationCriteria,
  ): Promise<readonly SessionId[]> {
    return [];
  }
}
