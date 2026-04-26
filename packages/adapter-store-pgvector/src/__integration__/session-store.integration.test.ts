import { Pool } from 'pg';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runMigrations } from '../migrate/runner.js';
import { PgvectorSessionStore } from '../session-store/pgvector-session-store.js';

const integration = process.env.INTEGRATION === '1';

describe.skipIf(!integration)('PgvectorSessionStore', () => {
  let container: StartedTestContainer;
  let pool: Pool;

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
  }, 120_000);

  afterAll(async () => {
    if (pool) await pool.end();
    if (container) await container.stop();
  });

  it('findOrCreate is idempotent on (tenant, channel_kind, channel_native_ref) and touches last_active_at on conflict', async () => {
    const store = new PgvectorSessionStore(pool);
    const first = await store.findOrCreate('slack', 'slack:C1:1.0', 'default');
    expect(first.tenantId).toBe('default');
    expect(first.status).toBe('active');
    expect(first.distilledThroughSeqNo).toBe(0n);

    // Sleep briefly so last_active_at can move forward.
    await new Promise((r) => setTimeout(r, 50));
    const second = await store.findOrCreate('slack', 'slack:C1:1.0', 'default');
    expect(second.id).toBe(first.id);
    expect(second.lastActiveAt.getTime()).toBeGreaterThan(first.lastActiveAt.getTime());
  });

  it('recordTurn populates monotonic seq_no and stores all input fields', async () => {
    const store = new PgvectorSessionStore(pool);
    const session = await store.findOrCreate('slack', 'slack:C-recordTurn:1.0', 'default');

    const t1 = await store.recordTurn(session.id, {
      authorRole: 'user',
      contentText: 'hello',
    });
    const t2 = await store.recordTurn(session.id, {
      authorRole: 'agent',
      contentText: 'hi back',
      authorRef: { agent: 'claude' },
      metadata: { usage: { input: 6, output: 7 } },
    });

    expect(t1.seqNo).toBeLessThan(t2.seqNo);
    expect(t2.authorRef).toEqual({ agent: 'claude' });
    expect(t2.metadata).toEqual({ usage: { input: 6, output: 7 } });
    // Default for omitted optional fields.
    expect(t1.authorRef).toBeUndefined();
    expect(t1.contentExtra).toEqual({});
  });

  it('getRecentTurns returns chronological order (oldest of the window first), bounded by limit', async () => {
    const store = new PgvectorSessionStore(pool);
    const session = await store.findOrCreate('slack', 'slack:C-recent:1.0', 'default');
    for (const text of ['a', 'b', 'c', 'd', 'e']) {
      await store.recordTurn(session.id, {
        authorRole: 'user',
        contentText: text,
      });
    }

    const last3 = await store.getRecentTurns(session.id, 3);
    expect(last3.map((t) => t.contentText)).toEqual(['c', 'd', 'e']);
  });

  it('updateStatus transitions session.status', async () => {
    const store = new PgvectorSessionStore(pool);
    const session = await store.findOrCreate('slack', 'slack:C-status:1.0', 'default');
    expect(session.status).toBe('active');

    await store.updateStatus(session.id, 'idle');
    const after = await pool.query<{ status: string }>(
      'SELECT status FROM sessions WHERE id = $1',
      [session.id],
    );
    expect(after.rows[0]?.status).toBe('idle');
  });

  it('setMetadata merges JSONB shallowly (preserve existing keys, overwrite overlaps)', async () => {
    const store = new PgvectorSessionStore(pool);
    const session = await store.findOrCreate('slack', 'slack:C-metadata:1.0', 'default');

    await store.setMetadata(session.id, { feature_x: true, count: 1 });
    await store.setMetadata(session.id, { count: 2, note: 'updated' });

    const row = await pool.query<{ metadata: Record<string, unknown> }>(
      'SELECT metadata FROM sessions WHERE id = $1',
      [session.id],
    );
    expect(row.rows[0]?.metadata).toEqual({
      feature_x: true,
      count: 2,
      note: 'updated',
    });
  });

  it('listSessionsForDistillation handles all four trigger shapes', async () => {
    const store = new PgvectorSessionStore(pool);
    const idleSession = await store.findOrCreate('slack', 'slack:C-idle:1.0', 'default');
    await store.updateStatus(idleSession.id, 'idle');
    // Backdate last_active_at so the idle filter selects it.
    await pool.query(
      "UPDATE sessions SET last_active_at = now() - interval '120 minutes' WHERE id = $1",
      [idleSession.id],
    );

    const idleResult = await store.listSessionsForDistillation({
      kind: 'idle',
      idleSinceMin: 60,
    });
    expect(idleResult).toContain(idleSession.id);

    const activeSession = await store.findOrCreate('slack', 'slack:C-active:1.0', 'default');
    const idleAgain = await store.listSessionsForDistillation({
      kind: 'idle',
      idleSinceMin: 60,
    });
    expect(idleAgain).not.toContain(activeSession.id);

    const ended = await store.listSessionsForDistillation({
      kind: 'session_ended',
      sessionId: activeSession.id,
    });
    expect(ended).toEqual([activeSession.id]);

    const manual = await store.listSessionsForDistillation({
      kind: 'manual',
      sessionId: activeSession.id,
    });
    expect(manual).toEqual([activeSession.id]);

    const rolling = await store.listSessionsForDistillation({
      kind: 'rolling',
      sessionId: activeSession.id,
      everyNTurns: 20,
    });
    expect(rolling).toEqual([activeSession.id]);

    const missing = await store.listSessionsForDistillation({
      kind: 'manual',
      sessionId: '00000000-0000-0000-0000-000000000000',
    });
    expect(missing).toEqual([]);
  });
});
