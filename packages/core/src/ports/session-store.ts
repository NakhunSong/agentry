import type { SessionId, TenantId } from '../domain/ids.js';
import type {
  ChannelKind,
  ChannelNativeRef,
  DistillationCriteria,
  Session,
  SessionStatus,
  Turn,
  TurnInput,
} from '../domain/session.js';

// Episodic-memory port. Sessions and turns map directly onto the schema in
// `docs/design/knowledge-store.md` §2.2. The store is canonical — agent
// runners reconstruct prompts from it, distillation reads it, the channel
// adapter writes synthetic turns into it.
export interface SessionStore {
  findOrCreate(
    channelKind: ChannelKind,
    channelNativeRef: ChannelNativeRef,
    tenantId: TenantId,
  ): Promise<Session>;

  // Read-only counterpart of findOrCreate. Returns null when no session
  // exists for the (kind, ref, tenant) tuple. Callers that only need to
  // CHECK existence or read metadata (e.g., session-bootstrap hooks
  // deciding whether their work is already done) should use this instead
  // of findOrCreate to avoid the UPSERT roundtrip on the hot path.
  findByRef(
    channelKind: ChannelKind,
    channelNativeRef: ChannelNativeRef,
    tenantId: TenantId,
  ): Promise<Session | null>;

  recordTurn(sessionId: SessionId, turn: TurnInput): Promise<Turn>;

  getRecentTurns(sessionId: SessionId, limit: number): Promise<readonly Turn[]>;

  updateStatus(sessionId: SessionId, status: SessionStatus): Promise<void>;

  setMetadata(sessionId: SessionId, patch: Readonly<Record<string, unknown>>): Promise<void>;

  listSessionsForDistillation(criteria: DistillationCriteria): Promise<readonly SessionId[]>;
}
