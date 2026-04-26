import type { SessionId, TenantId, TurnId } from './ids.js';

// Open string: 'slack' | 'slack-dm' | 'discord' | 'cli' | 'http' | …
// Each channel adapter declares its own value; the framework treats it
// opaquely except for `(tenant_id, channel_kind, channel_native_ref)`
// uniqueness in the schema.
export type ChannelKind = string;

// Channel-specific session reference. Per the per-channel policy table in
// ARCHITECTURE.md §4.3, e.g. `slack:${channel_id}:${thread_ts}`.
export type ChannelNativeRef = string;

export type SessionStatus = 'active' | 'idle' | 'ended';

export type AuthorRole = 'user' | 'agent' | 'system';

export interface Session {
  readonly id: SessionId;
  readonly tenantId: TenantId;
  readonly channelKind: ChannelKind;
  readonly channelNativeRef: ChannelNativeRef;
  readonly startedAt: Date;
  readonly lastActiveAt: Date;
  readonly status: SessionStatus;
  // JSONB array — channel adapters store whatever shape suits them
  // (Slack user IDs as plain strings, Discord member objects, etc.).
  readonly participants: readonly unknown[];
  readonly metadata: Readonly<Record<string, unknown>>;
  // Distillation watermark — turns with seq_no <= this have been processed.
  readonly distilledThroughSeqNo: bigint;
}

export interface TurnInput {
  readonly authorRole: AuthorRole;
  readonly authorRef?: Readonly<Record<string, unknown>>;
  readonly contentText: string;
  readonly contentExtra?: Readonly<Record<string, unknown>>;
  // Token usage, tool-call summaries, etc.
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface Turn extends TurnInput {
  readonly id: TurnId;
  readonly seqNo: bigint;
  readonly sessionId: SessionId;
  readonly createdAt: Date;
}

// Open kind. Common values: 'idle_timeout' (JobRunner-fired after
// SessionPolicy.idleTimeoutMinutes), 'channel_close' (CLI process exit,
// Slack channel archive), 'user_left'. Channel adapters can introduce
// their own kinds — SessionPolicy.shouldEndOn decides per channel whether
// the kind closes the session.
export interface SessionLifecycleEvent {
  readonly kind: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

// Trigger taxonomy from `docs/design/knowledge-store.md` §5.1. `rolling` is
// disabled by default; see design doc for per-trigger policy.
export type DistillationCriteria =
  | { readonly kind: 'session_ended'; readonly sessionId: SessionId }
  | { readonly kind: 'idle'; readonly idleSinceMin: number }
  | { readonly kind: 'manual'; readonly sessionId: SessionId }
  | {
      readonly kind: 'rolling';
      readonly sessionId: SessionId;
      readonly everyNTurns: number;
    };
