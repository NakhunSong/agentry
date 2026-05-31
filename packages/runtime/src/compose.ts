import { VoyageEmbeddingProvider } from '@agentry/adapter-embedding-voyage';
import { InMemoryJobRunner } from '@agentry/adapter-jobrunner-memory';
import { PgBossJobRunner } from '@agentry/adapter-jobrunner-pgboss';
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
  McpServerConfig,
  OutboundChannel,
  SessionFirstTouch,
  SessionPolicy,
  SessionStore,
  TenantId,
} from '@agentry/core';
import { makeHandleIncomingMessage } from '@agentry/core';
import { Pool } from 'pg';
import type { AgentryConfig } from './config/agentry-config.js';
import type { Secrets } from './config/secrets.js';

export interface BuildChannelsDeps {
  readonly sessionStore: SessionStore;
  readonly logger: Logger;
}

export interface BuildChannelsResult {
  readonly inboundChannels?: readonly InboundChannel[];
  readonly outboundChannels?: ReadonlyMap<ChannelKind, OutboundChannel>;
  readonly sessionPolicies?: ReadonlyMap<ChannelKind, SessionPolicy>;
  // Per-channel session-bootstrap hooks. Run inside the JobRunner queue
  // (off the inbound ack path) on each session's first touch.
  readonly sessionFirstTouches?: ReadonlyMap<ChannelKind, SessionFirstTouch>;
  // Per ARCHITECTURE.md §11.1 — channel-adapter MCP servers the runtime
  // forwards to the agent runner.
  readonly mcpServers?: readonly McpServerConfig[];
}

export interface ComposeArgs {
  readonly config: AgentryConfig;
  readonly secrets: Secrets;
  // Test seams; defaults wire to real pg / global fetch / node spawn / stdout.
  readonly poolFactory?: (postgresUrl: string) => Pool;
  readonly fetch?: typeof globalThis.fetch;
  readonly spawn?: SpawnFn;
  readonly loggerDestination?: NodeJS.WritableStream;
  // Channel registry. Empty by default — server boots and serves /health,
  // but `handleIncoming` will throw on dispatch until channels are wired.
  readonly inboundChannels?: readonly InboundChannel[];
  readonly outboundChannels?: ReadonlyMap<ChannelKind, OutboundChannel>;
  readonly sessionPolicies?: ReadonlyMap<ChannelKind, SessionPolicy>;
  // Channel adapters that need access to compose-built infrastructure
  // (e.g. SlackHistoryBackfiller wants the SessionStore) provide a factory
  // here. When supplied, its result wins over the static channel options
  // above; the factory is invoked AFTER storage init and BEFORE
  // makeHandleIncomingMessage. May be sync or async.
  readonly buildChannels?: (
    deps: BuildChannelsDeps,
  ) => BuildChannelsResult | Promise<BuildChannelsResult>;
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

  const jobRunner: JobRunner =
    config.jobRunner === 'pg-boss'
      ? new PgBossJobRunner({
          connectionString: secrets.POSTGRES_URL,
          logger,
          onError: (err, key) => {
            logger.error({ err, key }, 'job failed');
          },
        })
      : new InMemoryJobRunner({
          onError: (err, key) => {
            logger.error({ err, key }, 'job failed');
          },
        });

  const built = args.buildChannels ? await args.buildChannels({ sessionStore, logger }) : undefined;
  const inboundChannels = built?.inboundChannels ?? args.inboundChannels ?? [];
  const outboundChannels = built?.outboundChannels ?? args.outboundChannels ?? new Map();
  const sessionPolicies = built?.sessionPolicies ?? args.sessionPolicies ?? new Map();
  const sessionFirstTouches = built?.sessionFirstTouches;
  const mcpServers = built?.mcpServers ?? [];

  const agentRunner = new ClaudeCliAgentRunner({
    ...(args.spawn !== undefined ? { spawn: args.spawn } : {}),
    ...(mcpServers.length > 0 ? { mcpServers } : {}),
  });

  const handleIncoming = makeHandleIncomingMessage({
    sessionStore,
    knowledgeStore,
    agentRunner,
    jobRunner,
    sessionPolicies,
    outboundChannels,
    ...(sessionFirstTouches !== undefined ? { sessionFirstTouches } : {}),
    resolveTenant: args.resolveTenant ?? (() => DEFAULT_TENANT),
    agentWorkdir: config.agentWorkdir,
    logger,
  });

  // start() after all register() calls — distributed adapters (pg-boss)
  // open their schema and bind workers here. In-memory is a no-op but
  // calling it symmetrically keeps the lifecycle explicit.
  await jobRunner.start();

  return {
    logger,
    sessionStore,
    knowledgeStore,
    agentRunner,
    jobRunner,
    embeddingProvider,
    handleIncoming,
    inboundChannels,
    shutdown: async () => {
      // jobRunner.drain() must complete before pool.end() — the in-flight
      // handlers (memory adapter) or the surviving worker jobs (pg-boss) call
      // recordTurn / knowledgeStore.retrieve against THIS app's pool. (pg-boss
      // also has its own internal pool which it tears down inside stop({close:
      // true}) — that's separate from app pool.)
      await jobRunner.drain();
      await pool.end();
    },
  };
}

function defaultPoolFactory(postgresUrl: string): Pool {
  return new Pool({ connectionString: postgresUrl });
}
