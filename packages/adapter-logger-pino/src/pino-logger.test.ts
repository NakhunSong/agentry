import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { PinoLogger } from './pino-logger.js';

class CaptureStream extends Writable {
  private buffer = '';
  readonly entries: Array<Record<string, unknown>> = [];

  override _write(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.buffer += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
    while (true) {
      const idx = this.buffer.indexOf('\n');
      if (idx < 0) break;
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line) this.entries.push(JSON.parse(line) as Record<string, unknown>);
    }
    callback();
  }
}

const PINO_LEVELS = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
} as const;

describe('PinoLogger', () => {
  it('emits all six levels with correct level numbers, msg, and obj keys', () => {
    const stream = new CaptureStream();
    const logger = PinoLogger.create({ level: 'trace', destination: stream });

    logger.trace({ a: 1 }, 'trace-msg');
    logger.debug({ a: 2 }, 'debug-msg');
    logger.info({ a: 3 }, 'info-msg');
    logger.warn({ a: 4 }, 'warn-msg');
    logger.error({ a: 5 }, 'error-msg');
    logger.fatal({ a: 6 }, 'fatal-msg');

    const levels = Object.keys(PINO_LEVELS) as Array<keyof typeof PINO_LEVELS>;
    expect(stream.entries).toHaveLength(6);
    levels.forEach((name, i) => {
      expect(stream.entries[i]).toMatchObject({
        level: PINO_LEVELS[name],
        msg: `${name}-msg`,
        a: i + 1,
      });
    });
  });

  it('applies constructor bindings to every line', () => {
    const stream = new CaptureStream();
    const logger = PinoLogger.create({
      destination: stream,
      bindings: { tenantId: 't1', adapterKind: 'pino' },
    });

    logger.info({ k: 1 }, 'first');
    logger.info({ k: 2 }, 'second');

    expect(stream.entries).toHaveLength(2);
    for (const entry of stream.entries) {
      expect(entry).toMatchObject({ tenantId: 't1', adapterKind: 'pino' });
    }
  });

  it('child() merges bindings cumulatively across nesting', () => {
    const stream = new CaptureStream();
    const root = PinoLogger.create({ destination: stream });
    const a = root.child({ tenantId: 't1' });
    const b = a.child({ sessionId: 's1' });
    b.info({ k: 1 }, 'hello');

    const entry = stream.entries.at(-1);
    expect(entry).toMatchObject({ tenantId: 't1', sessionId: 's1', msg: 'hello' });
  });

  it('child() inner bindings override outer on key collision (pino convention)', () => {
    const stream = new CaptureStream();
    const root = PinoLogger.create({ destination: stream });
    const a = root.child({ sessionId: 'A' });
    const b = a.child({ sessionId: 'B' });
    b.info({ k: 1 });

    const entry = stream.entries.at(-1);
    expect(entry?.sessionId).toBe('B');
  });

  it('level filter suppresses calls below the threshold', () => {
    const stream = new CaptureStream();
    const logger = PinoLogger.create({ level: 'warn', destination: stream });

    logger.trace({}, 'trace');
    logger.debug({}, 'debug');
    logger.info({}, 'info');
    logger.warn({}, 'warn');
    logger.error({}, 'error');

    const msgs = stream.entries.map((e) => e.msg);
    expect(msgs).toEqual(['warn', 'error']);
  });

  it("level: 'silent' suppresses all output", () => {
    const stream = new CaptureStream();
    const logger = PinoLogger.create({ level: 'silent', destination: stream });

    logger.error({}, 'this should not appear');
    logger.fatal({}, 'neither should this');

    expect(stream.entries).toHaveLength(0);
  });
});
