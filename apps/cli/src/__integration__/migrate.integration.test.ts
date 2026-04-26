import { Client } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../cli.js';

const integration = process.env.INTEGRATION === '1';

describe.skipIf(!integration)('agentry migrate (CLI e2e)', () => {
  let container: StartedTestContainer;
  let databaseUrl: string;

  beforeAll(async () => {
    container = await new GenericContainer('pgvector/pgvector:pg17')
      .withEnvironment({
        POSTGRES_USER: 'agentry',
        POSTGRES_PASSWORD: 'agentry',
        POSTGRES_DB: 'agentry',
      })
      .withExposedPorts(5432)
      .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
      .start();

    const host = container.getHost();
    const port = container.getMappedPort(5432);
    databaseUrl = `postgres://agentry:agentry@${host}:${port}/agentry`;
  }, 120_000);

  afterAll(async () => {
    if (container) await container.stop();
  });

  it('applies migrations against a real container', async () => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(
      ['migrate'],
      { POSTGRES_URL: databaseUrl, EMBEDDING_DIM: '1024' },
      {
        out: (m) => out.push(m),
        err: (m) => err.push(m),
      },
    );
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toMatch(/applied: 1, skipped: 0/);

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const r = await client.query<{ count: string }>(
        "SELECT count(*)::text FROM tenants WHERE id = 'default'",
      );
      expect(r.rows[0]?.count).toBe('1');
    } finally {
      await client.end();
    }
  });

  it('is idempotent on second invocation', async () => {
    const out: string[] = [];
    const code = await runCli(
      ['migrate'],
      { POSTGRES_URL: databaseUrl },
      {
        out: (m) => out.push(m),
        err: (m) => {
          throw new Error(`unexpected stderr: ${m}`);
        },
      },
    );
    expect(code).toBe(0);
    expect(out.join('\n')).toMatch(/applied: 0, skipped: 1/);
  });
});
