// Slack OAuth scope verifier. Bolt's WebClient does not expose response
// headers, but every Web API response carries `x-oauth-scopes` listing the
// granted scopes (per https://docs.slack.dev/authentication/installing-with-oauth).
// We therefore make a raw fetch against `auth.test` to read both the granted
// scopes and the bot identity in one call.

const SLACK_AUTH_TEST_URL = 'https://slack.com/api/auth.test';

export interface SlackAuthInfo {
  readonly botUserId: string;
  readonly teamId: string;
  readonly grantedScopes: readonly string[];
}

export class SlackScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SlackScopeError';
  }
}

interface AuthTestBody {
  readonly ok: boolean;
  readonly user_id?: string;
  readonly team_id?: string;
  readonly error?: string;
}

export async function verifySlackScopes(
  botToken: string,
  required: readonly string[],
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<SlackAuthInfo> {
  const res = await fetchImpl(SLACK_AUTH_TEST_URL, {
    method: 'POST',
    headers: { Authorization: `Bearer ${botToken}` },
  });
  const grantedHeader = res.headers.get('x-oauth-scopes') ?? '';
  const grantedScopes = grantedHeader
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const body = (await res.json()) as AuthTestBody;
  if (!body.ok) {
    throw new SlackScopeError(`Slack auth.test failed: ${body.error ?? 'unknown error'}`);
  }
  if (!body.user_id || !body.team_id) {
    throw new SlackScopeError('Slack auth.test response missing user_id or team_id');
  }

  const granted = new Set(grantedScopes);
  const missing = required.filter((s) => !granted.has(s));
  if (missing.length > 0) {
    throw new SlackScopeError(
      `Slack bot token is missing required scopes: [${missing.join(', ')}]. ` +
        'Reinstall the app at https://api.slack.com/apps and grant the missing scopes, ' +
        'then update SLACK_BOT_TOKEN.',
    );
  }

  return { botUserId: body.user_id, teamId: body.team_id, grantedScopes };
}
