import { Client } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate/runner.js';

const integration = process.env.INTEGRATION === '1';

describe.skipIf(!integration)('runMigrations against pgvector container', () => {
  let container: StartedTestContainer;
  let databaseUrl: string;
  const embeddingDim = 1024;

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

  it('applies all migrations on a fresh database', async () => {
    const result = await runMigrations({ databaseUrl, embeddingDim });
    expect(result.applied).toEqual(['0001_init.sql']);
    expect(result.skipped).toEqual([]);

    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const tables = await client.query<{ table_name: string }>(`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name
      `);
      expect(tables.rows.map((r) => r.table_name)).toEqual(
        expect.arrayContaining([
          '_agentry_migrations',
          'knowledge_items',
          'sessions',
          'source_refs',
          'tenants',
          'turns',
        ]),
      );

      const extensions = await client.query<{ extname: string }>(
        "SELECT extname FROM pg_extension WHERE extname IN ('vector','pgcrypto')",
      );
      expect(extensions.rows.map((r) => r.extname).sort()).toEqual(['pgcrypto', 'vector']);

      const embeddingCol = await client.query<{ type: string }>(`
        SELECT format_type(atttypid, atttypmod) AS type
        FROM pg_attribute
        WHERE attrelid = 'knowledge_items'::regclass AND attname = 'embedding'
      `);
      expect(embeddingCol.rows[0]?.type).toBe(`vector(${embeddingDim})`);

      const hnsw = await client.query<{ indexdef: string }>(`
        SELECT indexdef FROM pg_indexes
        WHERE tablename = 'knowledge_items'
          AND indexname = 'knowledge_items_embedding_idx'
      `);
      expect(hnsw.rows[0]?.indexdef).toMatch(/USING hnsw/);

      const tenant = await client.query("SELECT id FROM tenants WHERE id = 'default'");
      expect(tenant.rowCount).toBe(1);

      const tracker = await client.query<{ version: string }>(
        "SELECT version FROM _agentry_migrations WHERE adapter = 'pgvector'",
      );
      expect(tracker.rows.map((r) => r.version)).toEqual(['0001_init.sql']);
    } finally {
      await client.end();
    }
  });

  it('is idempotent on re-run', async () => {
    const result = await runMigrations({ databaseUrl, embeddingDim });
    expect(result.applied).toEqual([]);
    expect(result.skipped).toEqual(['0001_init.sql']);
  });

  it('enforces canonical_uniq on (tenant_id, source_type, text_canonical_hash)', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const embedding = `[${new Array(embeddingDim).fill(0).join(',')}]`;
      const sql = `
        INSERT INTO knowledge_items (
          tenant_id, source_type, kind, text, text_canonical_hash, embedding,
          extractor_self_rating, confidence_snapshot,
          derived_from_kind, derived_from_session,
          extractor_version
        ) VALUES (
          'default', 'user_session', 'fact',
          $1, $2, $3,
          0.5, 0.5,
          'session', NULL,
          'test-canonical'
        )
      `;
      const hash = 'a'.repeat(64);
      await client.query(sql, ['first text', hash, embedding]);

      await expect(
        client.query(sql, ['different text but same hash', hash, embedding]),
      ).rejects.toThrow(/knowledge_items_canonical_uniq|duplicate key/);
    } finally {
      await client.end();
    }
  });

  it('enforces seed_external_uniq on (tenant_id, external_id) where external_id is not null', async () => {
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      const embedding = `[${new Array(embeddingDim).fill(0).join(',')}]`;
      const sql = `
        INSERT INTO knowledge_items (
          tenant_id, external_id, source_type, kind,
          text, text_canonical_hash, embedding,
          extractor_self_rating, confidence_snapshot,
          derived_from_kind, derived_from_session,
          extractor_version
        ) VALUES (
          'default', 'seed-shared-id', 'project_seed', 'fact',
          $1, $2, $3,
          0.6, 0.6,
          'session', NULL,
          'test-seed'
        )
      `;
      await client.query(sql, ['seed text A', 'b'.repeat(64), embedding]);

      await expect(client.query(sql, ['seed text B', 'c'.repeat(64), embedding])).rejects.toThrow(
        /knowledge_items_seed_external_uniq|duplicate key/,
      );
    } finally {
      await client.end();
    }
  });
});
