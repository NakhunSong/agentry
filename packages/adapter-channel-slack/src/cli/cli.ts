import { SLACK_REQUIRED_SCOPES } from '../slack-inbound-channel.js';
import { SlackScopeError, verifySlackScopes } from '../slack-scope-verifier.js';

const USAGE = `Usage: agentry-slack <command>

Commands:
  verify-scopes    Verify SLACK_BOT_TOKEN has all required OAuth scopes.
                   Required env: SLACK_BOT_TOKEN
`;

export interface RunSlackCliIo {
  readonly out: (msg: string) => void;
  readonly err: (msg: string) => void;
}

const DEFAULT_IO: RunSlackCliIo = {
  out: (msg) => {
    console.log(msg);
  },
  err: (msg) => {
    console.error(msg);
  },
};

export async function runSlackCli(
  argv: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  io: RunSlackCliIo = DEFAULT_IO,
  fetchImpl: typeof globalThis.fetch = globalThis.fetch,
): Promise<number> {
  const command = argv[0];

  if (command === 'verify-scopes') {
    return verifyScopesCommand(env, io, fetchImpl);
  }

  io.err(USAGE);
  return 1;
}

async function verifyScopesCommand(
  env: NodeJS.ProcessEnv,
  io: RunSlackCliIo,
  fetchImpl: typeof globalThis.fetch,
): Promise<number> {
  const token = env.SLACK_BOT_TOKEN;
  if (token === undefined || token.length === 0) {
    io.err('SLACK_BOT_TOKEN must be set in the environment');
    return 1;
  }

  try {
    const info = await verifySlackScopes(token, SLACK_REQUIRED_SCOPES, fetchImpl);
    io.out(
      `verify-scopes ok — bot ${info.botUserId} in team ${info.teamId} has all ${SLACK_REQUIRED_SCOPES.length} required scopes`,
    );
    return 0;
  } catch (err) {
    if (err instanceof SlackScopeError) {
      io.err(err.message);
      return 1;
    }
    io.err(`verify-scopes failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}
