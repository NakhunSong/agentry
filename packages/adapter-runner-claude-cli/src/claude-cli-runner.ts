import { type ChildProcess, spawn as defaultSpawn, type SpawnOptions } from 'node:child_process';
import { createInterface } from 'node:readline';
import type { AgentEvent, AgentRunInput, AgentRunner, TokenUsage } from '@agentry/core';
import { createParserState, finishedEvent, parseLine } from './stream-parser.js';

export type SpawnFn = (
  command: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

export interface ClaudeCliAgentRunnerOptions {
  readonly claudeBinary?: string;
  readonly spawn?: SpawnFn;
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

  constructor(private readonly options: ClaudeCliAgentRunnerOptions = {}) {}

  async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
    const binary = this.options.claudeBinary ?? 'claude';
    const spawnFn = this.options.spawn ?? defaultSpawn;
    const args = buildArgs(input);

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

function buildArgs(input: AgentRunInput): readonly string[] {
  if (input.resumeKey === undefined) return BASE_CLI_ARGS;
  return [...BASE_CLI_ARGS, '--resume', input.resumeKey];
}
