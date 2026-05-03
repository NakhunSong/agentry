import { WebClient } from '@slack/web-api';
import { SLACK_REQUIRED_SCOPES } from '../slack-inbound-channel.js';
import { SlackScopeError, verifySlackScopes } from '../slack-scope-verifier.js';

const USAGE = `Usage: agentry-slack <command> [args]

Commands:
  verify-scopes
      Verify SLACK_BOT_TOKEN has all required OAuth scopes.
      Required env: SLACK_BOT_TOKEN

  list-channels
      List public + private channels the bot is a member of (with IDs).
      Required env: SLACK_BOT_TOKEN

  send-test-message --channel <id> [--text <msg>] [--thread-ts <ts>]
      Post a message to a channel as the bot. For ops smoke testing only.
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

export type SlackWebClientFactory = (token: string) => WebClient;

const DEFAULT_WEB_CLIENT_FACTORY: SlackWebClientFactory = (token) => new WebClient(token);

export interface RunSlackCliOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly io?: RunSlackCliIo;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly webClientFactory?: SlackWebClientFactory;
}

export async function runSlackCli(
  argv: readonly string[],
  options: RunSlackCliOptions = {},
): Promise<number> {
  const env = options.env ?? process.env;
  const io = options.io ?? DEFAULT_IO;
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const factory = options.webClientFactory ?? DEFAULT_WEB_CLIENT_FACTORY;

  const command = argv[0];
  const rest = argv.slice(1);

  if (command === 'verify-scopes') {
    return verifyScopesCommand(env, io, fetchImpl);
  }
  if (command === 'list-channels') {
    return listChannelsCommand(env, io, factory);
  }
  if (command === 'send-test-message') {
    return sendTestMessageCommand(rest, env, io, factory);
  }

  io.err(USAGE);
  return 1;
}

// Returns the token, or null after writing the missing-token error to io.err.
// Centralized so adding a fourth command doesn't reintroduce the guard.
function requireBotToken(env: NodeJS.ProcessEnv, io: RunSlackCliIo): string | null {
  const token = env.SLACK_BOT_TOKEN;
  if (token === undefined || token.length === 0) {
    io.err('SLACK_BOT_TOKEN must be set in the environment');
    return null;
  }
  return token;
}

async function verifyScopesCommand(
  env: NodeJS.ProcessEnv,
  io: RunSlackCliIo,
  fetchImpl: typeof globalThis.fetch,
): Promise<number> {
  const token = requireBotToken(env, io);
  if (token === null) return 1;

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

interface SlackChannelSummary {
  readonly id?: string;
  readonly name?: string;
  readonly is_member?: boolean;
  readonly is_private?: boolean;
}

async function listChannelsCommand(
  env: NodeJS.ProcessEnv,
  io: RunSlackCliIo,
  factory: SlackWebClientFactory,
): Promise<number> {
  const token = requireBotToken(env, io);
  if (token === null) return 1;

  const client = factory(token);
  try {
    // Single page, capped at 200. Bots are typically in <100 channels;
    // pagination support will land if production usage hits the cap.
    const res = await client.conversations.list({
      types: 'public_channel,private_channel',
      limit: 200,
      exclude_archived: true,
    });
    if (!res.ok || !res.channels) {
      io.err(`conversations.list failed: ${res.error ?? 'unknown'}`);
      return 1;
    }
    const member = (res.channels as readonly SlackChannelSummary[]).filter(
      (c) => c.is_member === true,
    );
    if (member.length === 0) {
      io.out('No channels — invite the bot first via /invite @<bot> in the target channel');
      return 0;
    }
    for (const c of member) {
      const id = c.id ?? '';
      const name = c.name ?? '';
      const visibility = c.is_private === true ? 'private' : 'public';
      io.out(`${id}\t${name}\t(${visibility})`);
    }
    return 0;
  } catch (err) {
    io.err(`list-channels failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

async function sendTestMessageCommand(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  io: RunSlackCliIo,
  factory: SlackWebClientFactory,
): Promise<number> {
  const token = requireBotToken(env, io);
  if (token === null) return 1;

  const flags = parseFlags(args);
  const channel = flags.get('channel');
  if (channel === undefined || channel.length === 0) {
    io.err('send-test-message requires --channel <id>');
    return 1;
  }
  const text = flags.get('text') ?? 'agentry-slack send-test-message smoke';
  const threadTs = flags.get('thread-ts');

  const client = factory(token);
  try {
    const res = await client.chat.postMessage({
      channel,
      text,
      ...(threadTs !== undefined && threadTs.length > 0 ? { thread_ts: threadTs } : {}),
    });
    if (!res.ok || !res.ts) {
      io.err(`chat.postMessage failed: ${res.error ?? 'response missing ts'}`);
      return 1;
    }
    io.out(`posted ts=${res.ts} channel=${channel}`);
    return 0;
  } catch (err) {
    io.err(`send-test-message failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function parseFlags(argv: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (typeof a !== 'string' || !a.startsWith('--')) continue;
    const next = argv[i + 1];
    if (typeof next !== 'string') continue;
    out.set(a.slice(2), next);
    i++;
  }
  return out;
}
