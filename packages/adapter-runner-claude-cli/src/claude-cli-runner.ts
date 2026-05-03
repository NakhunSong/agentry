import { type ChildProcess, spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type {
  AgentEvent,
  AgentRunInput,
  AgentRunner,
  McpServerConfig,
  TokenUsage,
} from '@agentry/core';
import { createParserState, finishedEvent, parseLine } from './stream-parser.js';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ClaudeCliAgentRunnerOptions {
  readonly claudeBinary?: string;
  readonly spawn?: SpawnFn;
  readonly mcpServers?: readonly McpServerConfig[];
  // Test seam: when supplied, the runner writes to this path and skips the
  // process-exit cleanup hook (the test owns lifecycle of the file). In
  // production the runner generates a path under `os.tmpdir()` and registers
  // its own cleanup.
  readonly mcpConfigPath?: string;
}

const ZERO_USAGE: TokenUsage = { input: 0, output: 0 };

const BASE_CLI_ARGS = [
  '-p',
  '--output-format',
  'stream-json',
  '--verbose',
  '--input-format',
  'text',
] as const;

export class ClaudeCliAgentRunner implements AgentRunner {
  readonly kind = 'claude_cli';
  private readonly mcpConfigPath: string | undefined;

  constructor(private readonly options: ClaudeCliAgentRunnerOptions = {}) {
    const servers = options.mcpServers;
    if (servers !== undefined && servers.length > 0) {
      const callerOwnsPath = options.mcpConfigPath !== undefined;
      const configPath = options.mcpConfigPath ?? defaultMcpConfigPath();
      writeMcpConfigJson(configPath, servers);
      if (!callerOwnsPath) registerMcpConfigCleanup(configPath);
      this.mcpConfigPath = configPath;
    } else {
      this.mcpConfigPath = undefined;
    }
  }

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const binary = this.options.claudeBinary ?? 'claude';
    const spawnFn = this.options.spawn ?? defaultSpawn;
    const args = buildArgs(input, this.mcpConfigPath);

    const child = spawnFn(binary, args, {
      cwd: input.workdir,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (child.stdin === null || child.stdout === null || child.stderr === null) {
      yield { type: 'error', message: 'subprocess streams unavailable', recoverable: false };
      yield finishedEvent('error', ZERO_USAGE);
      return;
    }

    let spawnError: Error | undefined;
    child.on('error', (err) => {
      spawnError = err;
    });

    const exitPromise = new Promise<number | null>((resolve) => {
      child.once('exit', resolve);
    });

    child.stdin.on('error', () => {
      // Suppress EPIPE when the child exits before consuming stdin.
    });
    child.stdin.write(input.prompt);
    child.stdin.end();

    let aborted = false;
    const abortSignal = input.abortSignal;
    const onAbort = () => {
      aborted = true;
      child.kill('SIGTERM');
    };
    if (abortSignal) {
      if (abortSignal.aborted) onAbort();
      else abortSignal.addEventListener('abort', onAbort, { once: true });
    }

    let stderrTail = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-1024);
    });

    const state = createParserState();
    let finishedEmitted = false;
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });

    try {
      for await (const line of rl) {
        for (const ev of parseLine(line, state)) {
          if (ev.type === 'finished') finishedEmitted = true;
          yield ev;
        }
      }
    } finally {
      abortSignal?.removeEventListener('abort', onAbort);
    }

    const exitCode = await exitPromise;

    if (finishedEmitted) return;

    if (spawnError) {
      yield { type: 'error', message: spawnError.message, recoverable: false };
      yield finishedEvent('error', ZERO_USAGE, state.sessionId);
      return;
    }

    if (aborted) {
      yield finishedEvent('aborted', ZERO_USAGE, state.sessionId);
      return;
    }

    const tail = stderrTail.trim();
    const message =
      tail.length > 0
        ? `claude exited with code ${exitCode} before emitting result. stderr: ${tail}`
        : `claude exited with code ${exitCode} before emitting result.`;
    yield { type: 'error', message, recoverable: false };
    yield finishedEvent('error', ZERO_USAGE, state.sessionId);
  }
}

function buildArgs(input: AgentRunInput, mcpConfigPath: string | undefined): readonly string[] {
  const args: string[] = [...BASE_CLI_ARGS];
  if (mcpConfigPath !== undefined) {
    args.push('--mcp-config', mcpConfigPath);
  }
  if (input.resumeKey !== undefined) {
    args.push('--resume', input.resumeKey);
  }
  return args;
}

function defaultMcpConfigPath(): string {
  return join(tmpdir(), `agentry-mcp-${process.pid}-${randomUUID()}.json`);
}

interface ClaudeMcpServerJson {
  readonly command: string;
  readonly args?: readonly string[];
  readonly env?: Readonly<Record<string, string>>;
}

function writeMcpConfigJson(filePath: string, servers: readonly McpServerConfig[]): void {
  const entries: Record<string, ClaudeMcpServerJson> = {};
  for (const s of servers) {
    entries[s.name] = {
      command: s.command,
      ...(s.args !== undefined ? { args: s.args } : {}),
      ...(s.env !== undefined ? { env: s.env } : {}),
    };
  }
  writeFileSync(filePath, JSON.stringify({ mcpServers: entries }), { mode: 0o600 });
}

// Exported for unit tests that exercise the unlink semantics directly.
export function cleanupMcpConfig(filePath: string): void {
  try {
    unlinkSync(filePath);
  } catch {
    // best effort — file may have been removed already
  }
}

function registerMcpConfigCleanup(filePath: string): void {
  const cleanup = () => cleanupMcpConfig(filePath);
  // `exit` covers natural termination (event loop drained, process.exit()).
  // SIGINT/SIGTERM are required because Node does NOT fire 'exit' when the
  // process is killed by an unhandled signal. Note: registering ANY listener
  // for SIGINT/SIGTERM suppresses Node's default-fatal behavior. apps/server
  // already registers its own graceful-shutdown handlers, so default-action
  // suppression is already in effect there. Embedders that want default
  // signal-fatal behavior must drive their own process.exit() from a
  // higher-priority handler — this listener does NOT re-raise.
  process.once('exit', cleanup);
  process.once('SIGINT', cleanup);
  process.once('SIGTERM', cleanup);
}
