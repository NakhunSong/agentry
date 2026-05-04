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
  TurnInput,
} from '@agentry/core';
import type { Pool } from 'pg';

interface SessionRow {
  id: string;
  tenant_id: string;
  channel_kind: string;
  channel_native_ref: string;
  started_at: Date;
  last_active_at: Date;
  status: string;
  participants: unknown[];
  metadata: Record<string, unknown>;
  // pg returns BIGINT as string by default to avoid precision loss.
  distilled_through_seq_no: string;
}

interface TurnRow {
  id: string;
  seq_no: string;
  session_id: string;
  author_role: string;
  author_ref: Record<string, unknown> | null;
  content_text: string;
  content_extra: Record<string, unknown>;
  created_at: Date;
  metadata: Record<string, unknown>;
}

function mapSession(row: SessionRow): Session {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    channelKind: row.channel_kind,
    channelNativeRef: row.channel_native_ref,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    status: row.status as SessionStatus,
    participants: row.participants,
    metadata: row.metadata,
    distilledThroughSeqNo: BigInt(row.distilled_through_seq_no),
  };
}

function mapTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    seqNo: BigInt(row.seq_no),
    sessionId: row.session_id,
    authorRole: row.author_role as Turn['authorRole'],
    // null → undefined per the documented adapter convention.
    ...(row.author_ref !== null ? { authorRef: row.author_ref } : {}),
    contentText: row.content_text,
    contentExtra: row.content_extra,
    createdAt: row.created_at,
    metadata: row.metadata,
  };
}

export class PgvectorSessionStore implements SessionStore {
  constructor(private readonly pool: Pool) {}

  async findOrCreate(
    channelKind: ChannelKind,
    channelNativeRef: ChannelNativeRef,
    tenantId: TenantId,
  ): Promise<Session> {
    // ON CONFLICT DO UPDATE acts as a touch: existing rows have
    // last_active_at refreshed and returned, new rows inserted — both in
    // a single round trip.
    const result = await this.pool.query<SessionRow>(
      `INSERT INTO sessions (
         tenant_id, channel_kind, channel_native_ref,
         started_at, last_active_at, status
       )
       VALUES ($1, $2, $3, now(), now(), 'active')
       ON CONFLICT (tenant_id, channel_kind, channel_native_ref) DO UPDATE
         SET last_active_at = now()
       RETURNING *`,
      [tenantId, channelKind, channelNativeRef],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('findOrCreate returned no row — should be unreachable');
    }
    return mapSession(row);
  }

  async findByRef(
    channelKind: ChannelKind,
    channelNativeRef: ChannelNativeRef,
    tenantId: TenantId,
  ): Promise<Session | null> {
    const result = await this.pool.query<SessionRow>(
      `SELECT * FROM sessions
       WHERE tenant_id = $1
         AND channel_kind = $2
         AND channel_native_ref = $3
       LIMIT 1`,
      [tenantId, channelKind, channelNativeRef],
    );
    const row = result.rows[0];
    return row ? mapSession(row) : null;
  }

  async recordTurn(sessionId: SessionId, turn: TurnInput): Promise<Turn> {
    const result = await this.pool.query<TurnRow>(
      `INSERT INTO turns (
         session_id, author_role, author_ref,
         content_text, content_extra, metadata
       )
       VALUES ($1, $2, $3::jsonb, $4, $5::jsonb, $6::jsonb)
       RETURNING *`,
      [
        sessionId,
        turn.authorRole,
        turn.authorRef ? JSON.stringify(turn.authorRef) : null,
        turn.contentText,
        JSON.stringify(turn.contentExtra ?? {}),
        JSON.stringify(turn.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    if (!row) {
      throw new Error('recordTurn returned no row — should be unreachable');
    }
    return mapTurn(row);
  }

  async getRecentTurns(sessionId: SessionId, limit: number): Promise<readonly Turn[]> {
    const result = await this.pool.query<TurnRow>(
      `SELECT * FROM turns
       WHERE session_id = $1
       ORDER BY seq_no DESC
       LIMIT $2`,
      [sessionId, limit],
    );
    // DESC + reverse → chronological (oldest of the limit-window first), so
    // a use case can feed prior context to the agent without re-sorting.
    return result.rows.reverse().map(mapTurn);
  }

  async updateStatus(sessionId: SessionId, status: SessionStatus): Promise<void> {
    await this.pool.query('UPDATE sessions SET status = $1 WHERE id = $2', [status, sessionId]);
  }

  async setMetadata(sessionId: SessionId, patch: Readonly<Record<string, unknown>>): Promise<void> {
    // JSONB || merges shallowly; overlapping keys take the right-side value.
    await this.pool.query('UPDATE sessions SET metadata = metadata || $1::jsonb WHERE id = $2', [
      JSON.stringify(patch),
      sessionId,
    ]);
  }

  async listSessionsForDistillation(criteria: DistillationCriteria): Promise<readonly SessionId[]> {
    if (criteria.kind === 'idle') {
      const result = await this.pool.query<{ id: string }>(
        `SELECT id FROM sessions
         WHERE status = 'idle'
           AND last_active_at < now() - ($1 * interval '1 minute')`,
        [criteria.idleSinceMin],
      );
      return result.rows.map((r) => r.id);
    }
    // session_ended | manual | rolling all target a single sessionId.
    const result = await this.pool.query<{ id: string }>('SELECT id FROM sessions WHERE id = $1', [
      criteria.sessionId,
    ]);
    return result.rows.map((r) => r.id);
  }
}
