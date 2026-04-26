import { describe, expect, it } from 'vitest';
import { runMigrations } from './runner.js';

describe('runMigrations input validation', () => {
  // Validates inputs before opening a DB connection so a bad call never
  // reaches Postgres. Use an unreachable URL to prove no connect attempt is
  // made — if validation were skipped the test would hang or surface a
  // connection error instead of the validation message.
  const unreachable = 'postgres://invalid:invalid@127.0.0.1:1/agentry_test_no_db';

  it('rejects non-integer embeddingDim before connecting', async () => {
    await expect(runMigrations({ databaseUrl: unreachable, embeddingDim: 1.5 })).rejects.toThrow(
      /positive integer/,
    );
  });

  it('rejects zero embeddingDim before connecting', async () => {
    await expect(runMigrations({ databaseUrl: unreachable, embeddingDim: 0 })).rejects.toThrow(
      /positive integer/,
    );
  });

  it('rejects negative embeddingDim before connecting', async () => {
    await expect(runMigrations({ databaseUrl: unreachable, embeddingDim: -8 })).rejects.toThrow(
      /positive integer/,
    );
  });
});
