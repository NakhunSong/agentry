import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';
import { substituteEmbeddingDim } from './template.js';

const ADAPTER_KEY = 'pgvector';
const ADVISORY_LOCK_KEY = 'agentry_migrations_pgvector';

// Resolves to <package>/migrations/ both at dev (src/migrate/runner.ts) and
// runtime (dist/migrate/runner.js) — '..' walks up one directory level each.
const DEFAULT_MIGRATIONS_URL = new URL('../../migrations/', import.meta.url);

export interface MigrationOptions {
  readonly databaseUrl: string;
  readonly embeddingDim: number;
  readonly migrationsDir?: string;
  readonly logger?: (msg: string) => void;
}

export interface MigrationsResult {
  readonly applied: ReadonlyArray<string>;
  readonly skipped: ReadonlyArray<string>;
}

export async function runMigrations(opts: MigrationOptions): Promise<MigrationsResult> {
  // Validate before opening a connection so a bad call never reaches Postgres.
  // template.substituteEmbeddingDim re-validates per file; the duplication is
  // intentional and pinned by runner.test.ts.
  if (!Number.isInteger(opts.embeddingDim) || opts.embeddingDim <= 0) {
    throw new Error(`embeddingDim must be a positive integer, got ${String(opts.embeddingDim)}`);
  }

  const log = opts.logger ?? (() => {});
  const dir = opts.migrationsDir ?? fileURLToPath(DEFAULT_MIGRATIONS_URL);
  const versions = await listMigrationFiles(dir);

  if (versions.length === 0) {
    log(`no migrations found in ${dir}`);
    return { applied: [], skipped: [] };
  }

  const client = new Client({ connectionString: opts.databaseUrl });
  await client.connect();

  const applied: string[] = [];
  const skipped: string[] = [];

  try {
    await ensureTracker(client);
    // Serialize concurrent migrate runs across processes — second runner
    // blocks until the first commits, then sees the tracker rows and skips.
    await client.query('SELECT pg_advisory_lock(hashtext($1))', [ADVISORY_LOCK_KEY]);
    try {
      const alreadyApplied = await loadApplied(client);

      for (const version of versions) {
        if (alreadyApplied.has(version)) {
          skipped.push(version);
          log(`skip ${version} (already applied)`);
          continue;
        }

        const filePath = path.join(dir, version);
        const raw = await readFile(filePath, 'utf8');
        const sql = substituteEmbeddingDim(raw, opts.embeddingDim);

        await client.query('BEGIN');
        try {
          await client.query(sql);
          await client.query('INSERT INTO _agentry_migrations (adapter, version) VALUES ($1, $2)', [
            ADAPTER_KEY,
            version,
          ]);
          await client.query('COMMIT');
        } catch (err) {
          await client
            .query('ROLLBACK')
            .catch((rollbackErr: unknown) =>
              log(`rollback after ${version} failed: ${String(rollbackErr)}`),
            );
          throw err;
        }

        applied.push(version);
        log(`applied ${version}`);
      }
    } finally {
      await client
        .query('SELECT pg_advisory_unlock(hashtext($1))', [ADVISORY_LOCK_KEY])
        .catch((unlockErr: unknown) => log(`advisory unlock failed: ${String(unlockErr)}`));
    }
  } finally {
    await client.end();
  }

  return { applied, skipped };
}

async function ensureTracker(client: Client): Promise<void> {
  await client.query(`
    CREATE TABLE IF NOT EXISTS _agentry_migrations (
      adapter    TEXT NOT NULL,
      version    TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (adapter, version)
    )
  `);
}

async function loadApplied(client: Client): Promise<Set<string>> {
  const result = await client.query<{ version: string }>(
    'SELECT version FROM _agentry_migrations WHERE adapter = $1',
    [ADAPTER_KEY],
  );
  return new Set(result.rows.map((row) => row.version));
}

// Lexical sort assumes zero-padded version prefixes (e.g. 0001_, 0002_).
// Without padding "10_" sorts before "2_". Migration filenames are
// developer-controlled, so this is a convention rather than a runtime check.
async function listMigrationFiles(dir: string): Promise<string[]> {
  const entries = await readdir(dir);
  return entries.filter((f) => f.endsWith('.sql')).sort();
}
