import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectEnvShadowConflicts, formatEnvShadowError } from './env-shadow-check.js';

describe('detectEnvShadowConflicts', () => {
  let scratchDir: string;
  let envPath: string;

  beforeEach(() => {
    scratchDir = mkdtempSync(join(tmpdir(), 'env-shadow-test-'));
    envPath = join(scratchDir, '.env');
  });

  afterEach(() => {
    rmSync(scratchDir, { recursive: true, force: true });
  });

  it('returns empty when the file does not exist', () => {
    const result = detectEnvShadowConflicts(join(scratchDir, 'missing.env'), {
      SLACK_BOT_TOKEN: 'xoxb-shell',
    });
    expect(result).toEqual([]);
  });

  it('returns empty when shell value matches .env value', () => {
    writeFileSync(envPath, 'SLACK_BOT_TOKEN=xoxb-same\n');
    const result = detectEnvShadowConflicts(envPath, { SLACK_BOT_TOKEN: 'xoxb-same' });
    expect(result).toEqual([]);
  });

  it('returns empty when shell does not have the key', () => {
    writeFileSync(envPath, 'SLACK_BOT_TOKEN=xoxb-only-in-env\n');
    const result = detectEnvShadowConflicts(envPath, {});
    expect(result).toEqual([]);
  });

  it('reports a conflict when shell shadows .env with a different value', () => {
    writeFileSync(envPath, 'SLACK_BOT_TOKEN=xoxb-from-env\n');
    const result = detectEnvShadowConflicts(envPath, { SLACK_BOT_TOKEN: 'xoxb-from-shell' });
    expect(result).toEqual([{ key: 'SLACK_BOT_TOKEN' }]);
  });

  it('skips comments and blank lines', () => {
    writeFileSync(
      envPath,
      ['# comment line', '', '   ', 'SLACK_BOT_TOKEN=xoxb-from-env', '# another'].join('\n'),
    );
    const result = detectEnvShadowConflicts(envPath, { SLACK_BOT_TOKEN: 'xoxb-shell' });
    expect(result).toEqual([{ key: 'SLACK_BOT_TOKEN' }]);
  });

  it('strips matching outer double quotes from .env value', () => {
    writeFileSync(envPath, 'POSTGRES_URL="postgres://a:b@h/d"\n');
    const same = detectEnvShadowConflicts(envPath, { POSTGRES_URL: 'postgres://a:b@h/d' });
    expect(same).toEqual([]);
    const diff = detectEnvShadowConflicts(envPath, { POSTGRES_URL: 'other' });
    expect(diff).toEqual([{ key: 'POSTGRES_URL' }]);
  });

  it('strips matching outer single quotes from .env value', () => {
    writeFileSync(envPath, "VOYAGE_API_KEY='pa-secret'\n");
    const result = detectEnvShadowConflicts(envPath, { VOYAGE_API_KEY: 'pa-secret' });
    expect(result).toEqual([]);
  });

  it('preserves `=` characters in .env values', () => {
    writeFileSync(envPath, 'POSTGRES_URL=postgres://u:p=secret@h/d\n');
    const result = detectEnvShadowConflicts(envPath, {
      POSTGRES_URL: 'postgres://u:p=secret@h/d',
    });
    expect(result).toEqual([]);
  });

  it('honors `export KEY=value` syntax', () => {
    writeFileSync(envPath, 'export SLACK_BOT_TOKEN=xoxb-from-env\n');
    const result = detectEnvShadowConflicts(envPath, { SLACK_BOT_TOKEN: 'xoxb-from-shell' });
    expect(result).toEqual([{ key: 'SLACK_BOT_TOKEN' }]);
  });

  it('reports multiple conflicts in iteration order of .env', () => {
    writeFileSync(envPath, ['SLACK_BOT_TOKEN=a', 'POSTGRES_URL=b', 'VOYAGE_API_KEY=c'].join('\n'));
    const result = detectEnvShadowConflicts(envPath, {
      SLACK_BOT_TOKEN: 'shell-a',
      POSTGRES_URL: 'b',
      VOYAGE_API_KEY: 'shell-c',
    });
    expect(result).toEqual([{ key: 'SLACK_BOT_TOKEN' }, { key: 'VOYAGE_API_KEY' }]);
  });
});

describe('formatEnvShadowError', () => {
  it('lists keys without leaking values', () => {
    const msg = formatEnvShadowError('.env', [{ key: 'SLACK_BOT_TOKEN' }, { key: 'POSTGRES_URL' }]);
    expect(msg).toContain('2 key(s)');
    expect(msg).toContain('.env');
    expect(msg).toContain('SLACK_BOT_TOKEN');
    expect(msg).toContain('POSTGRES_URL');
    // Sanity: any actual secret-shaped value would not appear here because
    // the function only takes the conflict list, but assert anyway to lock
    // in the no-value-leak guarantee.
    expect(msg).not.toMatch(/xoxb-/);
  });
});
