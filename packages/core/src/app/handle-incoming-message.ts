import type { IncomingEvent, ReplyTarget } from '../domain/channel.js';
import { SYNTHETIC_EVENT_METADATA_KEY } from '../domain/channel.js';
import type { SessionId, TenantId } from '../domain/ids.js';
import type { ChannelKind } from '../domain/session.js';
import type { AgentRunner, RetrievedItem, TokenUsage } from '../ports/agent-runner.js';
import type { JobRunner } from '../ports/job-runner.js';
import type { KnowledgeStore } from '../ports/knowledge-store.js';
import type { Logger } from '../ports/logger.js';
import type { OutboundChannel } from '../ports/outbound-channel.js';
import type { SessionFirstTouch } from '../ports/session-first-touch.js';
import type { SessionPolicy } from '../ports/session-policy.js';
import type { SessionStore } from '../ports/session-store.js';

export interface HandleIncomingMessageDeps {
  readonly sessionStore: SessionStore;
  readonly knowledgeStore: KnowledgeStore;
  readonly agentRunner: AgentRunner;
  readonly jobRunner: JobRunner;
  readonly sessionPolicies: ReadonlyMap<ChannelKind, SessionPolicy>;
  readonly outboundChannels: ReadonlyMap<ChannelKind, OutboundChannel>;
  // Per-channel session-bootstrap hook. When set for `event.channelKind`,
  // it runs INSIDE the JobRunner queue (off the inbound ack path) and may
  // return synthetic events recorded as user turns before the live event.
  readonly sessionFirstTouches?: ReadonlyMap<ChannelKind, SessionFirstTouch>;
  readonly resolveTenant: (event: IncomingEvent) => TenantId;
  readonly agentWorkdir: string;
  readonly logger: Logger;
  readonly retrievalTopK?: number;
}

export type HandleIncomingMessage = (event: IncomingEvent) => Promise<void>;

const DEFAULT_TOP_K = 5;

// Queue name used by `makeHandleIncomingMessage` to register its job handler
// with the `JobRunner`. Exported so cross-process worker processes (pg-boss,
// BullMQ, ...) can target the same queue when wiring an alternative composition.
export const HANDLE_INCOMING_QUEUE = 'handle-incoming';

// Header for the optional channel-context block prepended to the agent
// prompt. Kept as an exported constant so seed/agent-workdir/CLAUDE.md can
// refer to it by name and stay in sync if it changes.
export const CHANNEL_CONTEXT_HEADER = '[Channel context]';

// Job payload travelling through the `JobRunner` queue. Identifiers + the
// live event only — the use-case handler re-reads `Session` via
// `findByRef` at job-execution time so a multi-process adapter sees fresh
// metadata (same convention as ARCHITECTURE.md §4.9).
export interface HandleIncomingPayload {
  readonly sessionId: SessionId;
  readonly tenantId: TenantId;
  readonly event: IncomingEvent;
}

interface ProcessOneTurnArgs {
  readonly event: IncomingEvent;
  readonly sessionId: SessionId;
  readonly tenantId: TenantId;
  readonly log: Logger;
  readonly deps: HandleIncomingMessageDeps;
  readonly topK: number;
  readonly policy: SessionPolicy;
}

export function makeHandleIncomingMessage(deps: HandleIncomingMessageDeps): HandleIncomingMessage {
  const topK = deps.retrievalTopK ?? DEFAULT_TOP_K;

  const queue = deps.jobRunner.register<HandleIncomingPayload>(
    HANDLE_INCOMING_QUEUE,
    async (payload) => {
      const { event, sessionId, tenantId } = payload;
      const log = deps.logger.child({
        channelKind: event.channelKind,
        idempotencyKey: event.idempotencyKey,
        tenantId,
        sessionId,
      });

      const policy = deps.sessionPolicies.get(event.channelKind);
      if (!policy) {
        // Unreachable in practice — publisher validates before enqueue —
        // but explicit so a cross-process worker that lost the policy
        // registration fails loudly rather than silently.
        log.error({ channelKind: event.channelKind }, 'no session policy for channel kind');
        throw new Error(`No SessionPolicy registered for channel kind: ${event.channelKind}`);
      }

      const firstTouch = deps.sessionFirstTouches?.get(event.channelKind);

      // Re-read session metadata so multi-process workers see other
      // workers' first-touch updates (ARCHITECTURE.md §4.9). For the
      // in-memory adapter this is a cheap Map read. Null here means the
      // session vanished between publisher (findOrCreate) and worker —
      // an invariant violation, not a recoverable state. The id check
      // catches a re-created-under-same-ref scenario where findByRef
      // returns a different session than the publisher saw.
      const session = await deps.sessionStore.findByRef(
        event.channelKind,
        policy.computeNativeRef(event),
        tenantId,
      );
      if (session === null) {
        throw new Error(
          `Session ${sessionId} not found at job execution time (channelKind=${event.channelKind})`,
        );
      }
      if (session.id !== sessionId) {
        throw new Error(
          `Session id drifted: publisher saw ${sessionId}, worker re-read ${session.id}`,
        );
      }

      if (firstTouch !== undefined) {
        let synthetics: readonly IncomingEvent[] = [];
        try {
          synthetics = await firstTouch.onFirstTouch({ session, event });
        } catch (err) {
          // Backfill failure must not drop the live event.
          log.warn({ err }, 'session first-touch failed; proceeding with live event only');
        }
        for (const synth of synthetics) {
          await processOneTurn({
            event: synth,
            sessionId,
            tenantId,
            log,
            deps,
            topK,
            policy,
          });
        }
      }
      await processOneTurn({ event, sessionId, tenantId, log, deps, topK, policy });
    },
  );

  return async function handleIncomingMessage(event: IncomingEvent): Promise<void> {
    const baseLog = deps.logger.child({
      channelKind: event.channelKind,
      idempotencyKey: event.idempotencyKey,
    });

    const policy = deps.sessionPolicies.get(event.channelKind);
    if (!policy) {
      baseLog.error({ channelKind: event.channelKind }, 'no session policy for channel kind');
      throw new Error(`No SessionPolicy registered for channel kind: ${event.channelKind}`);
    }

    const nativeRef = policy.computeNativeRef(event);
    const tenantId = deps.resolveTenant(event);
    const tenantLog = baseLog.child({ tenantId, channelNativeRef: nativeRef });

    const session = await deps.sessionStore.findOrCreate(event.channelKind, nativeRef, tenantId);
    tenantLog.child({ sessionId: session.id }).info({}, 'session resolved; enqueueing turn');

    await queue.enqueue({
      key: session.id,
      payload: { sessionId: session.id, tenantId, event },
    });
  };
}

function buildAgentPrompt(event: IncomingEvent, policy: SessionPolicy): string {
  const ctx = policy.toAgentContext?.(event);
  if (!ctx) return event.payload.text;
  const keys = Object.keys(ctx);
  if (keys.length === 0) return event.payload.text;
  const lines = keys.map((k) => `- ${k}: ${ctx[k]}`).join('\n');
  return `${CHANNEL_CONTEXT_HEADER}\n${lines}\n\n${event.payload.text}`;
}

async function processOneTurn(args: ProcessOneTurnArgs): Promise<void> {
  const { event, sessionId, tenantId, log, deps, topK } = args;
  const authorRef: Record<string, unknown> = {
    channelUserId: event.author.channelUserId,
  };
  if (event.author.displayName !== undefined) {
    authorRef['displayName'] = event.author.displayName;
  }

  await deps.sessionStore.recordTurn(sessionId, {
    authorRole: 'user',
    authorRef,
    contentText: event.payload.text,
    metadata: { idempotencyKey: event.idempotencyKey },
  });

  if (event.metadata?.[SYNTHETIC_EVENT_METADATA_KEY] === true) {
    log.info({}, 'synthetic event — history-only, skipping agent run');
    return;
  }

  const retrieval = await deps.knowledgeStore.retrieve({
    text: event.payload.text,
    tenantId,
    mode: 'semantic',
    topK,
  });
  const retrievedKnowledge: RetrievedItem[] = retrieval.items.map((r) => ({
    text: r.item.text,
    score: r.score,
  }));

  let accumulatedText = '';
  let usage: TokenUsage | undefined;
  let finishReason: 'complete' | 'error' | 'aborted' = 'complete';

  try {
    for await (const ev of deps.agentRunner.run({
      sessionId,
      workdir: deps.agentWorkdir,
      prompt: buildAgentPrompt(event, args.policy),
      context: { retrievedKnowledge },
    })) {
      if (ev.type === 'text_delta') {
        accumulatedText += ev.text;
      } else if (ev.type === 'finished') {
        usage = ev.usage;
        finishReason = ev.reason;
      } else if (ev.type === 'error') {
        log.error(
          { message: ev.message, recoverable: ev.recoverable },
          'agent surfaced error event',
        );
        finishReason = 'error';
        break;
      }
    }
  } catch (err) {
    log.error({ err }, 'agent runner threw');
    finishReason = 'error';
  }

  const agentMetadata: Record<string, unknown> = { finishReason };
  if (usage !== undefined) agentMetadata['usage'] = usage;
  await deps.sessionStore.recordTurn(sessionId, {
    authorRole: 'agent',
    contentText: accumulatedText,
    metadata: agentMetadata,
  });

  if (finishReason !== 'complete') {
    log.warn({ finishReason }, 'agent did not complete — skipping reply');
    return;
  }

  const outbound = deps.outboundChannels.get(event.channelKind);
  if (!outbound) {
    log.error({ channelKind: event.channelKind }, 'no outbound channel for kind');
    throw new Error(`No OutboundChannel registered for channel kind: ${event.channelKind}`);
  }
  const target: ReplyTarget = {
    channelKind: event.channelKind,
    channelNativeRef: event.channelNativeRef,
    threading: event.threading,
  };
  await outbound.reply(target, { text: accumulatedText });
  log.info({}, 'reply posted');
}
