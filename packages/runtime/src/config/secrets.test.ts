import { describe, expect, it } from 'vitest';
import { loadSecrets, SecretsValidationError } from './secrets.js';

const validEnv = {
  SLACK_BOT_TOKEN: 'xoxb-1234567890-abcdefg',
  SLACK_SIGNING_SECRET: '0123456789abcdef0123456789abcdef',
  POSTGRES_URL: 'postgres://user:pass@localhost:5432/agentry',
  VOYAGE_API_KEY: 'pa-test-key',
};

describe('loadSecrets', () => {
  it('returns parsed Secrets when env is valid', () => {
    const secrets = loadSecrets(validEnv);
    expect(secrets.SLACK_BOT_TOKEN).toBe(validEnv.SLACK_BOT_TOKEN);
    expect(secrets.POSTGRES_URL).toBe(validEnv.POSTGRES_URL);
  });

  it('ignores extra env keys not declared in the schema', () => {
    const secrets = loadSecrets({ ...validEnv, UNRELATED_KEY: 'something' });
    expect(secrets).not.toHaveProperty('UNRELATED_KEY');
  });

  it('throws SecretsValidationError listing every missing key', () => {
    let caught: unknown;
    try {
      loadSecrets({});
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SecretsValidationError);
    const err = caught as SecretsValidationError;
    const keys = err.issues.map((i) => i.key);
    expect(keys).toEqual(
      expect.arrayContaining([
        'SLACK_BOT_TOKEN',
        'SLACK_SIGNING_SECRET',
        'POSTGRES_URL',
        'VOYAGE_API_KEY',
      ]),
    );
  });

  it('reports an actionable rule message for invalid prefix', () => {
    let caught: unknown;
    try {
      loadSecrets({ ...validEnv, SLACK_BOT_TOKEN: 'wrong-prefix-token' });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SecretsValidationError);
    const err = caught as SecretsValidationError;
    const slackIssue = err.issues.find((i) => i.key === 'SLACK_BOT_TOKEN');
    expect(slackIssue?.message).toMatch(/xoxb-/);
  });

  it('rejects malformed POSTGRES_URL', () => {
    expect(() => loadSecrets({ ...validEnv, POSTGRES_URL: 'not-a-url' })).toThrow(
      SecretsValidationError,
    );
  });

  it('does NOT echo the offending secret value in the error message', () => {
    const sentinel = 'xoxb-leaked-token-do-not-log-12345';
    let caught: SecretsValidationError | undefined;
    try {
      loadSecrets({
        ...validEnv,
        SLACK_BOT_TOKEN: 'wrong',
        VOYAGE_API_KEY: sentinel,
        POSTGRES_URL: 'http://leaked.example/?secret=tail-leak-9876',
      });
    } catch (error) {
      caught = error as SecretsValidationError;
    }
    expect(caught).toBeInstanceOf(SecretsValidationError);
    const message = caught?.message ?? '';
    expect(message).not.toContain(sentinel);
    expect(message).not.toContain('tail-leak-9876');
    expect(message).not.toContain('wrong');
    for (const issue of caught?.issues ?? []) {
      expect(issue.message).not.toContain(sentinel);
      expect(issue.message).not.toContain('tail-leak-9876');
    }
  });
});
