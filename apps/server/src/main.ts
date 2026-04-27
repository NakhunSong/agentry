import { AgentryConfigSchema, compose, loadSecrets } from '@agentry/runtime';
import { serve } from '@hono/node-server';
import { Hono } from 'hono';

function parsePort(raw: string): number {
  const port = Number.parseInt(raw, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT: ${raw}`);
  }
  return port;
}

async function main(): Promise<void> {
  const secrets = loadSecrets();
  const config = AgentryConfigSchema.parse({
    agentWorkdir: process.env['AGENT_WORKDIR'] ?? './seed/agent-workdir',
    logging: { level: process.env['LOG_LEVEL'] ?? 'info' },
  });

  const handles = await compose({ config, secrets });
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

  const port = parsePort(process.env['PORT'] ?? '3000');
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
