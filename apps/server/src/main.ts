import {
  SlackHistoryBackfiller,
  SlackInboundChannel,
  SlackOutboundChannel,
  SlackSessionPolicy,
  slackMcpServerConfig,
} from '@agentry/adapter-channel-slack';
import type { ChannelKind, OutboundChannel, SessionPolicy } from '@agentry/core';
import { AgentryConfigSchema, compose, loadSecrets } from '@agentry/runtime';
import { serve } from '@hono/node-server';
import { WebClient } from '@slack/web-api';
import { Hono } from 'hono';
import { detectEnvShadowConflicts, formatEnvShadowError } from './env-shadow-check.js';

function parsePort(raw: string, label: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid ${label}: ${raw}`);
  }
  return port;
}

async function main(): Promise<void> {
  // Run BEFORE loadSecrets so the user sees the env-shadow error message
  // (which points at the root cause) instead of a downstream Slack/DB
  // auth-failure that hides it. Skipped silently when the .env file is
  // absent (e.g., production deployments injecting env vars directly).
  const envFilePath = process.env.AGENTRY_ENV_FILE ?? '.env';
  const conflicts = detectEnvShadowConflicts(envFilePath, process.env);
  if (conflicts.length > 0) {
    throw new Error(formatEnvShadowError(envFilePath, conflicts));
  }

  const secrets = loadSecrets();
  const config = AgentryConfigSchema.parse({
    agentWorkdir: process.env.AGENT_WORKDIR ?? './seed/agent-workdir',
    logging: { level: process.env.LOG_LEVEL ?? 'info' },
  });
  const slackPort = parsePort(process.env.SLACK_PORT ?? '3001', 'SLACK_PORT');

  const handles = await compose({
    config,
    secrets,
    buildChannels: ({ sessionStore }) => {
      // Single shared WebClient: SlackOutboundChannel posts replies; the
      // backfiller fetches conversations.replies. Two clients would just
      // duplicate connection pools.
      const slackClient = new WebClient(secrets.SLACK_BOT_TOKEN);
      const policy = new SlackSessionPolicy();
      const outbound = new SlackOutboundChannel({
        botToken: secrets.SLACK_BOT_TOKEN,
        client: slackClient,
      });
      const backfiller = new SlackHistoryBackfiller({
        webClient: slackClient,
        sessionStore,
        sessionPolicy: policy,
      });
      const inbound = new SlackInboundChannel({
        botToken: secrets.SLACK_BOT_TOKEN,
        signingSecret: secrets.SLACK_SIGNING_SECRET,
        port: slackPort,
        backfiller,
      });
      return {
        inboundChannels: [inbound],
        outboundChannels: new Map<ChannelKind, OutboundChannel>([[policy.channelKind, outbound]]),
        sessionPolicies: new Map<ChannelKind, SessionPolicy>([[policy.channelKind, policy]]),
        mcpServers: [slackMcpServerConfig({ botToken: secrets.SLACK_BOT_TOKEN })],
      };
    },
  });
  const log = handles.logger;
  const ac = new AbortController();

  const app = new Hono();
  app.get('/health', (c) =>
    c.json({
      status: 'ok',
      adapters: {
        sessionStore: 'pgvector',
        knowledgeStore: 'pgvector',
        agentRunner: handles.agentRunner.kind,
        embeddingProvider: handles.embeddingProvider.model,
        jobRunner: 'in-memory',
      },
      inboundChannels: handles.inboundChannels.map((ch) => ch.kind),
    }),
  );

  const port = parsePort(process.env.PORT ?? '3000', 'PORT');
  const server = serve({ fetch: app.fetch, port }, (info) => {
    log.info({ port: info.port }, 'agentry server listening');
  });

  let shutdownPromise: Promise<void> | null = null;
  // exitCode is applied in `finally` so shutdown failures still set the
  // intended code instead of silently leaving the default 0 — important
  // for k8s / ECS error reporting.
  const startShutdown = (reason: string, exitCode = 0): Promise<void> => {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      try {
        log.info({ reason }, 'shutting down');
        ac.abort();
        await Promise.allSettled(inboundPromises);
        await handles.shutdown();
        await new Promise<void>((resolve) => {
          server.close((err) => {
            if (err) log.error({ err }, 'server.close error');
            resolve();
          });
        });
      } finally {
        // Setting exitCode (not exit()) lets the event loop drain naturally
        // — pino may still flush queued lines before the process exits.
        process.exitCode = exitCode;
      }
    })();
    return shutdownPromise;
  };

  const inboundPromises = handles.inboundChannels.map((ch) =>
    ch.start(handles.handleIncoming, ac.signal).catch((err: unknown) => {
      log.error({ err, kind: ch.kind }, 'inbound channel failed');
      void startShutdown('inbound-failure', 1);
    }),
  );

  process.on('SIGTERM', () => void startShutdown('SIGTERM'));
  process.on('SIGINT', () => void startShutdown('SIGINT'));
  process.on('unhandledRejection', (err) => {
    log.error({ err }, 'unhandledRejection');
  });
  process.on('uncaughtException', (err) => {
    log.error({ err }, 'uncaughtException');
    void startShutdown('uncaughtException', 1);
  });
}

main().catch((err: unknown) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
