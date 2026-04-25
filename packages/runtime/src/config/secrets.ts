import { z } from 'zod';

export const SecretsSchema = z.object({
  SLACK_BOT_TOKEN: z.string().startsWith('xoxb-', 'must start with "xoxb-"'),
  SLACK_SIGNING_SECRET: z.string().min(1, 'must not be empty'),
  POSTGRES_URL: z.url(),
  VOYAGE_API_KEY: z.string().min(1, 'must not be empty'),
});

export type Secrets = z.infer<typeof SecretsSchema>;

export interface SecretsIssue {
  readonly key: string;
  readonly message: string;
}

export class SecretsValidationError extends Error {
  readonly issues: ReadonlyArray<SecretsIssue>;

  constructor(issues: ReadonlyArray<SecretsIssue>) {
    const lines = issues.map((i) => `  - ${i.key}: ${i.message}`).join('\n');
    super(
      `Invalid or missing environment variables:\n${lines}\n\n` +
        'See .env.example for required keys. ' +
        'Set them via shell, an env file (Node 22+: `node --env-file=.env ...`), ' +
        'or a secret manager loader.',
    );
    this.name = 'SecretsValidationError';
    this.issues = issues;
  }
}

export function loadSecrets(env: NodeJS.ProcessEnv = process.env): Secrets {
  const result = SecretsSchema.safeParse(env);
  if (result.success) return result.data;

  const issues: SecretsIssue[] = result.error.issues.map((issue) => ({
    key: issue.path.join('.'),
    message: issue.message,
  }));
  throw new SecretsValidationError(issues);
}
