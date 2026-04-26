import type { SessionId } from '../domain/ids.js';

// Agent-context shape — intentionally minimal so storage internals don't leak
// into the runner. The richer store-side result lives in `RetrievedKnowledgeItem`
// (`domain/retrieval.ts`); a use case maps store results into this view.
export interface RetrievedItem {
  readonly text: string;
  readonly score?: number;
}

export interface TokenUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

export interface AgentRunInput {
  readonly sessionId: SessionId;
  readonly workdir: string;
  readonly prompt: string;
  readonly resumeKey?: string;
  readonly context?: { readonly retrievedKnowledge: readonly RetrievedItem[] };
  readonly abortSignal?: AbortSignal;
}

export type AgentEvent =
  | { readonly type: 'text_delta'; readonly text: string }
  | { readonly type: 'tool_call'; readonly name: string; readonly input: unknown }
  | { readonly type: 'tool_result'; readonly name: string; readonly output: unknown }
  | {
      readonly type: 'finished';
      readonly reason: 'complete' | 'error' | 'aborted';
      readonly usage: TokenUsage;
      readonly resumeKey?: string;
    }
  | { readonly type: 'error'; readonly message: string; readonly recoverable: boolean };

export interface AgentRunner {
  readonly kind: string;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}
