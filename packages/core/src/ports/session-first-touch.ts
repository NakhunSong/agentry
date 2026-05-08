import type { IncomingEvent } from '../domain/channel.js';
import type { Session } from '../domain/session.js';

export interface SessionFirstTouchInput {
  readonly session: Session;
  readonly event: IncomingEvent;
}

// Channel-agnostic session lifecycle hook invoked once per session inside
// the JobRunner queue (off the inbound ack path). Returns synthetic events
// the use case records as user turns BEFORE the live event's agent run.
//
// Implementations own their own "already done" flag — typically via
// `session.metadata` — and reconcile single-process races via the
// JobRunner per-key FIFO contract plus an in-impl fresh re-read
// (`SessionStore.findByRef`) to defend against multi-process drift.
//
// Failure semantics: if `onFirstTouch` throws, the use case logs and still
// processes the live event. Synthetic-event delivery is best-effort.
export interface SessionFirstTouch {
  onFirstTouch(input: SessionFirstTouchInput): Promise<readonly IncomingEvent[]>;
}
