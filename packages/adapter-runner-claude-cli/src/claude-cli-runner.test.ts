import type { ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import type { AgentEvent } from '@agentry/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ClaudeCliAgentRunner, cleanupMcpConfig } from './claude-cli-runner.js';

class FakeChildProcess extends EventEmitter {
  stdin = new PassThrough();
  stdout = new PassThrough();
  stderr = new PassThrough();
  exitCode: number | null = null;
  killSignal?: NodeJS.Signals | number;

  kill(signal?: NodeJS.Signals | number): boolean {
    this.killSignal = signal;
    return true;
  }

  pushStdoutLine(json: string): void {
    this.stdout.write(`${json}\n`);
  }
  emitExit(code: number | null): void {
    this.exitCode = code;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code);
  }
  emitError(err: Error): void {
    this.emit('error', err);
  }
}

function asChildProcess(fake: FakeChildProcess): ChildProcess {
  return fake as unknown as ChildProcess;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const x of it) result.push(x);
  return result;
}

const baseInput = { sessionId: 's', workdir: '/tmp', prompt: 'hi' } as const;

describe('ClaudeCliAgentRunner', () => {
  it('streams text_delta + finished{complete} for a successful run', async () => {
    const fake = new FakeChildProcess();
    const runner = new ClaudeCliAgentRunner({ spawn: () => asChildProcess(fake) });
    const events = collect(runner.run(baseInput));

    fake.pushStdoutLine('{"type":"system","subtype":"init","session_id":"sid-1"}');
    fake.pushStdoutLine('{"type":"assistant","message":{"content":[{"type":"text","text":"hi"}]}}');
    fake.pushStdoutLine(
      '{"type":"result","subtype":"success","is_error":false,"session_id":"sid-1","usage":{"input_tokens":1,"output_tokens":2}}',
    );
    fake.emitExit(0);

    expect(await events).toEqual([
      { type: 'text_delta', text: 'hi' },
      {
        type: 'finished',
        reason: 'complete',
        usage: { input: 1, output: 2 },
        resumeKey: 'sid-1',
      },
    ]);
  });

  it('writes prompt to stdin and ends it', async () => {
    const fake = new FakeChildProcess();
    let stdinData = '';
    fake.stdin.on('data', (chunk: Buffer) => {
      stdinData += chunk.toString();
    });
    const stdinEnded = new Promise<void>((resolve) => fake.stdin.once('end', resolve));
    const runner = new ClaudeCliAgentRunner({ spawn: () => asChildProcess(fake) });
    const events = collect(runner.run({ ...baseInput, prompt: 'hello world' }));

    await stdinEnded;
    fake.pushStdoutLine(
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":0,"output_tokens":0}}',
    );
    fake.emitExit(0);
    await events;

    expect(stdinData).toBe('hello world');
  });

  it('passes --resume when input.resumeKey is set', async () => {
    const fake = new FakeChildProcess();
    let captured: readonly string[] = [];
    const runner = new ClaudeCliAgentRunner({
      spawn: (_cmd, args) => {
        captured = args;
        return asChildProcess(fake);
      },
    });
    const events = collect(runner.run({ ...baseInput, resumeKey: 'abc-resume' }));
    fake.pushStdoutLine(
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":0,"output_tokens":0}}',
    );
    fake.emitExit(0);
    await events;

    expect(captured).toContain('--resume');
    expect(captured).toContain('abc-resume');
  });

  it('omits --resume when no resumeKey provided', async () => {
    const fake = new FakeChildProcess();
    let captured: readonly string[] = [];
    const runner = new ClaudeCliAgentRunner({
      spawn: (_cmd, args) => {
        captured = args;
        return asChildProcess(fake);
      },
    });
    const events = collect(runner.run(baseInput));
    fake.pushStdoutLine(
      '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":0,"output_tokens":0}}',
    );
    fake.emitExit(0);
    await events;

    expect(captured).not.toContain('--resume');
  });

  it('emits finished{aborted} and signals SIGTERM when AbortSignal fires', async () => {
    const fake = new FakeChildProcess();
    const ac = new AbortController();
    const runner = new ClaudeCliAgentRunner({ spawn: () => asChildProcess(fake) });
    const eventsPromise = collect(runner.run({ ...baseInput, abortSignal: ac.signal }));

    setImmediate(() => {
      ac.abort();
      setImmediate(() => fake.emitExit(null));
    });

    const events = await eventsPromise;
    expect(fake.killSignal).toBe('SIGTERM');
    expect(events.at(-1)).toMatchObject({ type: 'finished', reason: 'aborted' });
  });

  it('emits error + finished{error} on spawn error event (e.g. ENOENT)', async () => {
    const fake = new FakeChildProcess();
    const runner = new ClaudeCliAgentRunner({ spawn: () => asChildProcess(fake) });
    const eventsPromise = collect(runner.run(baseInput));

    setImmediate(() => {
      fake.emitError(new Error('spawn claude ENOENT'));
      fake.emitExit(null);
    });

    const events = await eventsPromise;
    expect(events).toEqual([
      { type: 'error', message: 'spawn claude ENOENT', recoverable: false },
      { type: 'finished', reason: 'error', usage: { input: 0, output: 0 } },
    ]);
  });

  describe('with mcpServers configured', () => {
    let scratchDir: string;

    beforeEach(() => {
      scratchDir = mkdtempSync(join(tmpdir(), 'mcp-runner-test-'));
    });

    afterEach(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });

    it('writes config JSON and adds --mcp-config flag when servers are non-empty', async () => {
      const fake = new FakeChildProcess();
      let captured: readonly string[] = [];
      const configPath = join(scratchDir, 'mcp.json');
      const runner = new ClaudeCliAgentRunner({
        spawn: (_cmd, args) => {
          captured = args;
          return asChildProcess(fake);
        },
        mcpServers: [
          {
            name: 'agentry-slack',
            command: '/usr/bin/node',
            args: ['/abs/path/server.js'],
            env: { SLACK_BOT_TOKEN: 'xoxb-test' },
          },
        ],
        mcpConfigPath: configPath,
      });
      const events = collect(runner.run(baseInput));
      fake.pushStdoutLine(
        '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":0,"output_tokens":0}}',
      );
      fake.emitExit(0);
      await events;

      expect(captured).toContain('--mcp-config');
      const idx = captured.indexOf('--mcp-config');
      expect(captured[idx + 1]).toBe(configPath);

      const written = JSON.parse(readFileSync(configPath, 'utf8'));
      expect(written).toEqual({
        mcpServers: {
          'agentry-slack': {
            command: '/usr/bin/node',
            args: ['/abs/path/server.js'],
            env: { SLACK_BOT_TOKEN: 'xoxb-test' },
          },
        },
      });

      const mode = statSync(configPath).mode & 0o777;
      expect(mode).toBe(0o600);
    });

    it('omits --mcp-config when mcpServers is undefined', async () => {
      const fake = new FakeChildProcess();
      let captured: readonly string[] = [];
      const runner = new ClaudeCliAgentRunner({
        spawn: (_cmd, args) => {
          captured = args;
          return asChildProcess(fake);
        },
      });
      const events = collect(runner.run(baseInput));
      fake.pushStdoutLine(
        '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":0,"output_tokens":0}}',
      );
      fake.emitExit(0);
      await events;

      expect(captured).not.toContain('--mcp-config');
    });

    it('omits --mcp-config when mcpServers is an empty list', async () => {
      const fake = new FakeChildProcess();
      let captured: readonly string[] = [];
      const runner = new ClaudeCliAgentRunner({
        spawn: (_cmd, args) => {
          captured = args;
          return asChildProcess(fake);
        },
        mcpServers: [],
      });
      const events = collect(runner.run(baseInput));
      fake.pushStdoutLine(
        '{"type":"result","subtype":"success","is_error":false,"usage":{"input_tokens":0,"output_tokens":0}}',
      );
      fake.emitExit(0);
      await events;

      expect(captured).not.toContain('--mcp-config');
    });
  });

  describe('cleanupMcpConfig', () => {
    let scratchDir: string;

    beforeEach(() => {
      scratchDir = mkdtempSync(join(tmpdir(), 'mcp-cleanup-test-'));
    });

    afterEach(() => {
      rmSync(scratchDir, { recursive: true, force: true });
    });

    it('unlinks the file when present', () => {
      const path = join(scratchDir, 'present.json');
      writeFileSync(path, '{}');
      expect(existsSync(path)).toBe(true);
      cleanupMcpConfig(path);
      expect(existsSync(path)).toBe(false);
    });

    it('is idempotent when the file is already gone', () => {
      const path = join(scratchDir, 'missing.json');
      expect(existsSync(path)).toBe(false);
      expect(() => cleanupMcpConfig(path)).not.toThrow();
    });
  });

  describe('cleanup registration on signals', () => {
    it('registers exit, SIGINT, and SIGTERM listeners when the runner owns the tempfile path', () => {
      const onceSpy = vi.spyOn(process, 'once');
      const fake = new FakeChildProcess();
      // mcpConfigPath omitted ⇒ runner generates its own path AND registers
      // cleanup. We assert against process.once instead of the actual signal
      // path so the test does not pollute os.tmpdir() across runs.
      try {
        new ClaudeCliAgentRunner({
          spawn: () => asChildProcess(fake),
          mcpServers: [{ name: 'agentry-x', command: '/usr/bin/node', args: ['/abs/x.js'] }],
        });
        const registeredEvents = onceSpy.mock.calls.map((c) => c[0]);
        expect(registeredEvents).toContain('exit');
        expect(registeredEvents).toContain('SIGINT');
        expect(registeredEvents).toContain('SIGTERM');
      } finally {
        // Drive the cleanup synchronously so the auto-generated tempfile is
        // unlinked immediately instead of relying on `exit` at test-runner
        // shutdown.
        for (const [event, handler] of onceSpy.mock.calls) {
          if (event === 'exit' && typeof handler === 'function') {
            handler();
            break;
          }
        }
        onceSpy.mockRestore();
      }
    });
  });

  it('emits error + finished{error} when child exits without a result line, including stderr tail', async () => {
    const fake = new FakeChildProcess();
    const runner = new ClaudeCliAgentRunner({ spawn: () => asChildProcess(fake) });
    const eventsPromise = collect(runner.run(baseInput));

    setImmediate(() => {
      fake.stderr.write('panic: something went wrong\n');
      fake.emitExit(1);
    });

    const events = await eventsPromise;
    expect(events).toHaveLength(2);
    const errorEv = events[0] as Extract<AgentEvent, { type: 'error' }>;
    expect(errorEv.type).toBe('error');
    expect(errorEv.message).toContain('exited with code 1');
    expect(errorEv.message).toContain('panic');
    expect(events[1]).toMatchObject({ type: 'finished', reason: 'error' });
  });
});
