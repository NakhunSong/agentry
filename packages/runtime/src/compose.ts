import { VoyageEmbeddingProvider } from '@agentry/adapter-embedding-voyage';
import { InMemoryJobRunner } from '@agentry/adapter-jobrunner-memory';
import { PinoLogger } from '@agentry/adapter-logger-pino';
import { ClaudeCliAgentRunner, type SpawnFn } from '@agentry/adapter-runner-claude-cli';
import { PgvectorKnowledgeStore, PgvectorSessionStore } from '@agentry/adapter-store-pgvector';
import type {
  AgentRunner,
  ChannelKind,
  EmbeddingProvider,
  HandleIncomingMessage,
  InboundChannel,
  IncomingEvent,
  JobRunner,
  KnowledgeStore,
  Logger,
  OutboundChannel,
  SessionPolicy,
  SessionStore,
  TenantId,
} from '@agentry/core';
import { makeHandleIncomingMessage } from '@agentry/core';
import { Pool } from 'pg';
import type { AgentryConfig } from './config/agentry-config.js';
import type { Secrets } from './config/secrets.js';

export interface ComposeArgs {
  readonly config: AgentryConfig;
  readonly secrets: Secrets;
  // Test seams; defaults wire to real pg / global fetch / node spawn / stdout.
  readonly poolFactory?: (postgresUrl: string) => Pool;
  readonly fetch?: typeof globalThis.fetch;
  readonly spawn?: SpawnFn;
  readonly loggerDestination?: NodeJS.WritableStream;
  // Channel registry. Empty by default — server boots and serves /health,
  // but `handleIncoming` will throw on dispatch until channels are wired
  // (i.e. until #18 ships the Slack adapter).
  readonly inboundChannels?: readonly InboundChannel[];
  readonly outboundChannels?: ReadonlyMap<ChannelKind, OutboundChannel>;
  readonly sessionPolicies?: ReadonlyMap<ChannelKind, SessionPolicy>;
  // Single-tenant deployments default to 'default'. Multi-tenant deployments
  // MUST override with a real per-event tenant resolver.
  readonly resolveTenant?: (event: IncomingEvent) => TenantId;
}

export interface RuntimeHandles {
  readonly logger: Logger;
  readonly sessionStore: SessionStore;
  readonly knowledgeStore: KnowledgeStore;
  readonly agentRunner: AgentRunner;
  readonly jobRunner: JobRunner;
  readonly embeddingProvider: EmbeddingProvider;
  readonly handleIncoming: HandleIncomingMessage;
  readonly inboundChannels: readonly InboundChannel[];
  readonly shutdown: () => Promise<void>;
}

const DEFAULT_TENANT: TenantId = 'default';

export async function compose(args: ComposeArgs): Promise<RuntimeHandles> {
  const { config, secrets } = args;

  const logger = PinoLogger.create({
    level: config.logging.level,
    ...(args.loggerDestination !== undefined ? { destination: args.loggerDestination } : {}),
  });

  const pool = (args.poolFactory ?? defaultPoolFactory)(secrets.POSTGRES_URL);

  const embeddingProvider = new VoyageEmbeddingProvider({
    apiKey: secrets.VOYAGE_API_KEY,
    ...(args.fetch !== undefined ? { fetch: args.fetch } : {}),
  });

  const sessionStore = new PgvectorSessionStore(pool);
  const knowledgeStore = new PgvectorKnowledgeStore({
    pool,
    embeddings: embeddingProvider,
  });

  const agentRunner = new ClaudeCliAgentRunner(
    args.spawn !== undefined ? { spawn: args.spawn } : {},
  );

  const jobRunner = new InMemoryJobRunner({
    onError: (err, key) => {
      logger.error({ err, key }, 'job failed');
    },
  });

  const handleIncoming = makeHandleIncomingMessage({
    sessionStore,
    knowledgeStore,
    agentRunner,
    jobRunner,
    sessionPolicies: args.sessionPolicies ?? new Map(),
    outboundChannels: args.outboundChannels ?? new Map(),
    resolveTenant: args.resolveTenant ?? (() => DEFAULT_TENANT),
    agentWorkdir: config.agentWorkdir,
    logger,
  });

  return {
    logger,
    sessionStore,
    knowledgeStore,
    agentRunner,
    jobRunner,
    embeddingProvider,
    handleIncoming,
    inboundChannels: args.inboundChannels ?? [],
    shutdown: async () => {
      // jobRunner.drain() must complete before pool.end() — running jobs may
      // still need the pool to record turns or query knowledge.
      await jobRunner.drain();
      await pool.end();
    },
  };
}

function defaultPoolFactory(postgresUrl: string): Pool {
  return new Pool({ connectionString: postgresUrl });
}
