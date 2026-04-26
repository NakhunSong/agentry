import { runMigrations } from '@agentry/adapter-store-pgvector';

const USAGE = `Usage: agentry <command>

Commands:
  migrate    Apply Postgres + pgvector schema migrations.
             Required env: POSTGRES_URL
             Optional env: EMBEDDING_DIM (default: 1024)
`;

const DEFAULT_EMBEDDING_DIM = 1024;

export interface RunCliIo {
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

const DEFAULT_IO: RunCliIo = {
  out: (msg) => {
    console.log(msg);
  },
  err: (msg) => {
    console.error(msg);
  },
};

export async function runCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: RunCliIo = DEFAULT_IO,
): Promise<number> {
  const command = argv[0];

  if (command === 'migrate') {
    return migrateCommand(env, io);
  }

  io.err(USAGE);
  return 1;
}

async function migrateCommand(env: NodeJS.ProcessEnv, io: RunCliIo): Promise<number> {
  const databaseUrl = env.POSTGRES_URL;
  if (!databaseUrl) {
    io.err('POSTGRES_URL must be set in the environment');
    return 1;
  }

  const rawDim = env.EMBEDDING_DIM;
  const embeddingDim = rawDim === undefined ? DEFAULT_EMBEDDING_DIM : Number(rawDim);
  if (!Number.isInteger(embeddingDim) || embeddingDim <= 0) {
    io.err(`EMBEDDING_DIM must be a positive integer, got ${String(rawDim)}`);
    return 1;
  }

  try {
    const result = await runMigrations({
      databaseUrl,
      embeddingDim,
      logger: io.out,
    });
    io.out(`migrate done — applied: ${result.applied.length}, skipped: ${result.skipped.length}`);
    return 0;
  } catch (err) {
    io.err(`migrate failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
