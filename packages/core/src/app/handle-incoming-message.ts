import type { IncomingEvent, ReplyTarget } from '../domain/channel.js';
import { SYNTHETIC_EVENT_METADATA_KEY } from '../domain/channel.js';
import type { SessionId, TenantId } from '../domain/ids.js';
import type { ChannelKind } from '../domain/session.js';
import type { AgentRunner, RetrievedItem, TokenUsage } from '../ports/agent-runner.js';
import type { JobRunner } from '../ports/job-runner.js';
import type { KnowledgeStore } from '../ports/knowledge-store.js';
import type { Logger } from '../ports/logger.js';
import type { OutboundChannel } from '../ports/outbound-channel.js';
import type { SessionPolicy } from '../ports/session-policy.js';
import type { SessionStore } from '../ports/session-store.js';

export interface HandleIncomingMessageDeps {
  readonly sessionStore: SessionStore;
  readonly knowledgeStore: KnowledgeStore;
  readonly agentRunner: AgentRunner;
  readonly jobRunner: JobRunner;
  readonly sessionPolicies: ReadonlyMap<ChannelKind, SessionPolicy>;
  readonly outboundChannels: ReadonlyMap<ChannelKind, OutboundChannel>;
  readonly resolveTenant: (event: IncomingEvent) => TenantId;
  readonly agentWorkdir: string;
  readonly logger: Logger;
  readonly retrievalTopK?: number;
}

export type HandleIncomingMessage = (event: IncomingEvent) => Promise<void>;

const DEFAULT_TOP_K = 5;

interface ProcessOneTurnArgs {
  readonly event: IncomingEvent;
  readonly sessionId: SessionId;
  readonly tenantId: TenantId;
  readonly log: Logger;
  readonly deps: HandleIncomingMessageDeps;
  readonly topK: number;
}

export function makeHandleIncomingMessage(deps: HandleIncomingMessageDeps): HandleIncomingMessage {
  const topK = deps.retrievalTopK ?? DEFAULT_TOP_K;

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
    const log = tenantLog.child({ sessionId: session.id });
    log.info({}, 'session resolved; enqueueing turn');

    await deps.jobRunner.enqueue({
      key: session.id,
      job: () => processOneTurn({ event, sessionId: session.id, tenantId, log, deps, topK }),
    });
  };
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
      prompt: event.payload.text,
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
