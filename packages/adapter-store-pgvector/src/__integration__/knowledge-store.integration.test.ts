import type { EmbeddingProvider } from '@agentry/core';
import { Pool } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgvectorKnowledgeStore } from '../knowledge-store/pgvector-knowledge-store.js';
import { runMigrations } from '../migrate/runner.js';

const integration = process.env.INTEGRATION === '1';

class DeterministicFakeEmbeddings implements EmbeddingProvider {
  readonly model = 'fake-1024';
  readonly dimension = 1024;
  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    return texts.map((text) => {
      const v = new Float32Array(1024);
      let h = 0;
      for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
      // Spread per-text hash across the vector so cosine distance varies
      // per input — keeps retrieve ordering deterministic but distinct.
      v[0] = h / 1e9;
      v[1] = text.length / 100;
      v[2] = (text.charCodeAt(0) || 0) / 255;
      return v;
    });
  }
}

describe.skipIf(!integration)('PgvectorKnowledgeStore', () => {
  let container: StartedTestContainer;
  let pool: Pool;
  let store: PgvectorKnowledgeStore;

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

    const databaseUrl = `postgres://agentry:agentry@${container.getHost()}:${container.getMappedPort(5432)}/agentry`;
    await runMigrations({ databaseUrl, embeddingDim: 1024 });
    pool = new Pool({ connectionString: databaseUrl });
    store = new PgvectorKnowledgeStore({ pool, embeddings: new DeterministicFakeEmbeddings() });
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  describe('recordSource', () => {
    it('is idempotent on (tenantId, sourceKind, locator) and merges metadata', async () => {
      const a = await store.recordSource({
        tenantId: 'default',
        sourceKind: 'github',
        locator: 'org/repo#README',
        metadata: { branch: 'main' },
      });
      const b = await store.recordSource({
        tenantId: 'default',
        sourceKind: 'github',
        locator: 'org/repo#README',
        metadata: { commit: 'abc' },
      });
      expect(b).toBe(a);

      const row = (await pool.query('SELECT metadata FROM source_refs WHERE id = $1', [a])).rows[0];
      expect(row.metadata).toEqual({ branch: 'main', commit: 'abc' });
    });
  });

  describe('upsertItem', () => {
    it('inserts a new item with computed snap and session provenance', async () => {
      const id = await store.upsertItem({
        tenantId: 'default',
        sourceType: 'user_session',
        kind: 'fact',
        text: 'The sky is blue.',
        extractorSelfRating: 0.8,
        derivedFrom: {
          kind: 'session',
          sessionId: null,
          turnRange: null,
          provenanceLostAt: null,
        },
        extractorVersion: 'test-1',
      });

      const row = (
        await pool.query(
          'SELECT n_confirmations, confidence_snapshot, derived_from_kind FROM knowledge_items WHERE id = $1',
          [id],
        )
      ).rows[0];
      expect(row.n_confirmations).toBe(1);
      // 0.8 * 0.6 + 0.2 = 0.68
      expect(Number(row.confidence_snapshot)).toBeCloseTo(0.68, 2);
      expect(row.derived_from_kind).toBe('session');
    });

    it('persists non-null turnRange when referenced turns exist', async () => {
      const sessionRes = await pool.query<{ id: string }>(
        `INSERT INTO sessions (tenant_id, channel_kind, channel_native_ref, started_at, last_active_at, status)
         VALUES ('default', 'cli', 'turn-prov-test', now(), now(), 'active')
         RETURNING id`,
      );
      const sessionId = sessionRes.rows[0]?.id ?? '';
      const turnRes = await pool.query<{ seq_no: string }>(
        `INSERT INTO turns (session_id, author_role, content_text)
         VALUES ($1, 'user', 'first'), ($1, 'agent', 'second')
         RETURNING seq_no`,
        [sessionId],
      );
      const lo = BigInt(turnRes.rows[0]?.seq_no ?? '0');
      const hi = BigInt(turnRes.rows[1]?.seq_no ?? '0');

      const id = await store.upsertItem({
        tenantId: 'default',
        sourceType: 'user_session',
        kind: 'fact',
        text: `provenance round-trip ${sessionId}`,
        extractorSelfRating: 0.5,
        derivedFrom: { kind: 'session', sessionId, turnRange: [lo, hi], provenanceLostAt: null },
        extractorVersion: 'test-1',
      });
      const row = (
        await pool.query(
          'SELECT derived_from_session, derived_from_turn_lo, derived_from_turn_hi FROM knowledge_items WHERE id = $1',
          [id],
        )
      ).rows[0];
      expect(row.derived_from_session).toBe(sessionId);
      expect(BigInt(row.derived_from_turn_lo)).toBe(lo);
      expect(BigInt(row.derived_from_turn_hi)).toBe(hi);
    });

    it('on canonical-hash conflict bumps n_confirmations and recomputes snap', async () => {
      const baseInput = {
        tenantId: 'default',
        sourceType: 'user_session' as const,
        kind: 'fact' as const,
        derivedFrom: {
          kind: 'session' as const,
          sessionId: null,
          turnRange: null,
          provenanceLostAt: null,
        },
        extractorVersion: 'test-1',
      };
      const idA = await store.upsertItem({
        ...baseInput,
        text: 'Pluto is a planet',
        extractorSelfRating: 0.7,
      });
      const idB = await store.upsertItem({
        ...baseInput,
        text: 'pluto is a planet.', // canonicalizes to the same key
        extractorSelfRating: 0.5,
      });
      expect(idB).toBe(idA);

      const row = (
        await pool.query(
          'SELECT n_confirmations, confidence_snapshot FROM knowledge_items WHERE id = $1',
          [idA],
        )
      ).rows[0];
      expect(row.n_confirmations).toBe(2);
      // EXCLUDED rating = 0.5; boost(2) = 0.5 + 0.1 * (n_old=1) = 0.6
      // snap = 0.5 * 0.6 + 0.6 * 0.4 = 0.54
      expect(Number(row.confidence_snapshot)).toBeCloseTo(0.54, 2);
    });

    it('persists external provenance correctly', async () => {
      const sourceId = await store.recordSource({
        tenantId: 'default',
        sourceKind: 'web',
        locator: 'https://example.com/article',
      });
      const id = await store.upsertItem({
        tenantId: 'default',
        sourceType: 'external_sync',
        kind: 'fact',
        text: 'External fact body',
        extractorSelfRating: 0.9,
        derivedFrom: {
          kind: 'external',
          sourceId,
          locator: 'https://example.com/article#para1',
        },
        extractorVersion: 'test-1',
      });

      const row = (
        await pool.query(
          'SELECT derived_from_kind, derived_from_source, derived_from_locator FROM knowledge_items WHERE id = $1',
          [id],
        )
      ).rows[0];
      expect(row.derived_from_kind).toBe('external');
      expect(row.derived_from_source).toBe(sourceId);
      expect(row.derived_from_locator).toBe('https://example.com/article#para1');
    });
  });

  describe('retrieve', () => {
    const tenantId = 'default';
    const baseInput = {
      tenantId,
      sourceType: 'project_seed' as const,
      kind: 'fact' as const,
      derivedFrom: {
        kind: 'session' as const,
        sessionId: null,
        turnRange: null,
        provenanceLostAt: null,
      },
      extractorVersion: 'test-1',
    };

    beforeAll(async () => {
      // Use distinct external_ids to avoid colliding with earlier upsert tests.
      await store.upsertItem({
        ...baseInput,
        externalId: 'rt-1',
        text: 'apple is a fruit',
        extractorSelfRating: 0.9,
      });
      await store.upsertItem({
        ...baseInput,
        externalId: 'rt-2',
        kind: 'decision',
        text: 'we choose typescript',
        extractorSelfRating: 0.5,
      });
      await store.upsertItem({
        ...baseInput,
        externalId: 'rt-3',
        sourceType: 'user_session',
        text: 'banana is yellow',
        extractorSelfRating: 0.7,
      });
    });

    it('returns topK results ordered by score desc', async () => {
      const result = await store.retrieve({
        tenantId,
        text: 'apple is a fruit',
        mode: 'semantic',
        topK: 2,
      });
      expect(result.items).toHaveLength(2);
      // Score is 1 - cosine_distance; descending order.
      expect(result.items[0]?.score).toBeGreaterThanOrEqual(result.items[1]?.score ?? 0);
      expect(result.items[0]?.confidenceFinal).toBe(result.items[0]?.item.confidenceSnapshot);
    });

    it('filters by sourceTypes', async () => {
      const result = await store.retrieve({
        tenantId,
        text: 'anything',
        mode: 'semantic',
        topK: 10,
        filters: { sourceTypes: ['user_session'] },
      });
      expect(result.items.every((r) => r.item.sourceType === 'user_session')).toBe(true);
    });

    it('filters by kinds', async () => {
      const result = await store.retrieve({
        tenantId,
        text: 'anything',
        mode: 'semantic',
        topK: 10,
        filters: { kinds: ['decision'] },
      });
      expect(result.items.every((r) => r.item.kind === 'decision')).toBe(true);
    });

    it('filters by minConfidence', async () => {
      const result = await store.retrieve({
        tenantId,
        text: 'anything',
        mode: 'semantic',
        topK: 10,
        filters: { minConfidence: 0.7 },
      });
      expect(result.items.every((r) => r.item.confidenceSnapshot >= 0.7)).toBe(true);
    });
  });

  describe('deleteBySource', () => {
    it('removes only items derived from that source', async () => {
      const sourceId = await store.recordSource({
        tenantId: 'default',
        sourceKind: 'web',
        locator: 'https://delete-me.example/page',
      });
      const targetId = await store.upsertItem({
        tenantId: 'default',
        sourceType: 'external_sync',
        kind: 'fact',
        text: 'Doomed external item',
        extractorSelfRating: 0.5,
        derivedFrom: { kind: 'external', sourceId, locator: 'https://delete-me.example/page#x' },
        extractorVersion: 'test-1',
      });
      const survivorId = await store.upsertItem({
        tenantId: 'default',
        sourceType: 'user_session',
        kind: 'fact',
        text: 'Survivor item',
        extractorSelfRating: 0.5,
        derivedFrom: { kind: 'session', sessionId: null, turnRange: null, provenanceLostAt: null },
        extractorVersion: 'test-1',
      });

      await store.deleteBySource(sourceId);

      const target = await pool.query('SELECT id FROM knowledge_items WHERE id = $1', [targetId]);
      const survivor = await pool.query('SELECT id FROM knowledge_items WHERE id = $1', [
        survivorId,
      ]);
      expect(target.rowCount).toBe(0);
      expect(survivor.rowCount).toBe(1);
    });
  });

  describe('deleteByExternalId', () => {
    it('removes only project_seed items with the given externalId; ignores other source_types', async () => {
      // The schema's `(tenant_id, external_id) UNIQUE WHERE external_id IS NOT
      // NULL` index makes externalId globally unique per tenant — collision
      // across source_types isn't structurally possible. The hard-coded
      // `source_type = 'project_seed'` filter is defense-in-depth: should the
      // schema ever loosen, a stale user-data externalId still can't wipe
      // distilled knowledge. Verify by inserting a non-matching user_session
      // row alongside, and checking only the project_seed row is deleted.
      const seedId = await store.upsertItem({
        tenantId: 'default',
        externalId: 'doomed-seed',
        sourceType: 'project_seed',
        kind: 'fact',
        text: 'project seed fact for doomed-seed',
        extractorSelfRating: 0.5,
        derivedFrom: { kind: 'session', sessionId: null, turnRange: null, provenanceLostAt: null },
        extractorVersion: 'test-1',
      });
      const survivorId = await store.upsertItem({
        tenantId: 'default',
        sourceType: 'user_session',
        kind: 'fact',
        text: 'unrelated user-session fact that must survive',
        extractorSelfRating: 0.5,
        derivedFrom: { kind: 'session', sessionId: null, turnRange: null, provenanceLostAt: null },
        extractorVersion: 'test-1',
      });

      await store.deleteByExternalId('default', 'doomed-seed');

      const seed = await pool.query('SELECT id FROM knowledge_items WHERE id = $1', [seedId]);
      const survivor = await pool.query('SELECT id FROM knowledge_items WHERE id = $1', [
        survivorId,
      ]);
      expect(seed.rowCount).toBe(0);
      expect(survivor.rowCount).toBe(1);
    });
  });

  describe('listByTenant', () => {
    it('paginates across more than one page (>200 rows)', async () => {
      // Create a fresh tenant so this test's row count is independent of
      // earlier tests' inserts.
      await pool.query("INSERT INTO tenants (id, display_name) VALUES ('list-test', 'List Test')");

      const target = 250;
      for (let i = 0; i < target; i++) {
        await store.upsertItem({
          tenantId: 'list-test',
          sourceType: 'project_seed',
          kind: 'fact',
          text: `paged item ${i}`,
          extractorSelfRating: 0.5,
          derivedFrom: {
            kind: 'session',
            sessionId: null,
            turnRange: null,
            provenanceLostAt: null,
          },
          extractorVersion: 'test-1',
        });
      }

      let count = 0;
      for await (const _ of store.listByTenant('list-test', {})) {
        count += 1;
      }
      expect(count).toBe(target);
    }, 60_000);
  });
});
