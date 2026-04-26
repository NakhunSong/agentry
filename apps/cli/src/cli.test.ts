import { describe, expect, it } from 'vitest';
import { runCli } from './cli.js';

function captureIo(): {
  out: string[];
  err: string[];
  io: { out: (m: string) => void; err: (m: string) => void };
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      out: (m) => out.push(m),
      err: (m) => err.push(m),
    },
  };
}

describe('runCli', () => {
  it('prints usage and exits 1 when no command is given', async () => {
    const { err, io } = captureIo();
    const code = await runCli([], {}, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: agentry <command>/);
  });

  it('prints usage and exits 1 on unknown command', async () => {
    const { err, io } = captureIo();
    const code = await runCli(['unknown'], {}, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/Usage: agentry <command>/);
  });

  it('migrate fails fast when POSTGRES_URL is missing', async () => {
    const { err, io } = captureIo();
    const code = await runCli(['migrate'], {}, io);
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/POSTGRES_URL/);
  });

  it('migrate fails fast on non-numeric EMBEDDING_DIM', async () => {
    const { err, io } = captureIo();
    const code = await runCli(
      ['migrate'],
      { POSTGRES_URL: 'postgres://x', EMBEDDING_DIM: 'not-a-number' },
      io,
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/EMBEDDING_DIM/);
  });

  it('migrate fails fast on zero EMBEDDING_DIM', async () => {
    const { err, io } = captureIo();
    const code = await runCli(
      ['migrate'],
      { POSTGRES_URL: 'postgres://x', EMBEDDING_DIM: '0' },
      io,
    );
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/EMBEDDING_DIM/);
  });
});
