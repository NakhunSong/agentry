import { describe, expect, it } from 'vitest';
import type { Logger } from './logger.js';

type Level = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

interface LogEntry {
  readonly level: Level;
  readonly bindings: Readonly<Record<string, unknown>>;
  readonly obj: object;
  readonly msg?: string;
}

// Compile + runtime smoke. The fake records every emit with the merged
// bindings so adapter-style override semantics are observable in tests.
function buildFake(
  initial: Record<string, unknown> = {},
): Logger & { readonly entries: readonly LogEntry[] } {
  const entries: LogEntry[] = [];
  const make = (bindings: Record<string, unknown>): Logger => {
    const emit = (level: Level, obj: object, msg?: string): void => {
      entries.push(msg === undefined ? { level, bindings, obj } : { level, bindings, obj, msg });
    };
    return {
      trace: (obj, msg) => emit('trace', obj, msg),
      debug: (obj, msg) => emit('debug', obj, msg),
      info: (obj, msg) => emit('info', obj, msg),
      warn: (obj, msg) => emit('warn', obj, msg),
      error: (obj, msg) => emit('error', obj, msg),
      fatal: (obj, msg) => emit('fatal', obj, msg),
      // Inner bindings override outer on key collision per pino convention.
      child: (b) => make({ ...bindings, ...(b as Record<string, unknown>) }),
    };
  };
  const root = make(initial);
  return Object.assign(root, {
    get entries() {
      return entries;
    },
  });
}

describe('Logger port', () => {
  it('admits a minimal in-memory implementation with all six levels', () => {
    const logger = buildFake();
    logger.trace({ k: 1 }, 'trace');
    logger.debug({ k: 2 }, 'debug');
    logger.info({ k: 3 }, 'info');
    logger.warn({ k: 4 }, 'warn');
    logger.error({ k: 5 }, 'error');
    logger.fatal({ k: 6 }, 'fatal');

    expect(logger.entries.map((e) => e.level)).toEqual([
      'trace',
      'debug',
      'info',
      'warn',
      'error',
      'fatal',
    ]);
    expect(logger.entries[2]?.obj).toEqual({ k: 3 });
    expect(logger.entries[2]?.msg).toBe('info');
  });

  it('child() merges bindings cumulatively across nesting', () => {
    const logger = buildFake();
    const a = logger.child({ tenantId: 't1' });
    const b = a.child({ sessionId: 's1' });
    b.info({ k: 1 }, 'hello');

    const entry = logger.entries.at(-1);
    expect(entry?.bindings).toEqual({ tenantId: 't1', sessionId: 's1' });
  });

  it('child() inner bindings override outer on key collision (pino convention)', () => {
    const logger = buildFake();
    const a = logger.child({ sessionId: 'A' });
    const b = a.child({ sessionId: 'B' });
    b.info({ k: 1 });

    const entry = logger.entries.at(-1);
    expect(entry?.bindings).toEqual({ sessionId: 'B' });
  });

  it('omitting msg is permitted', () => {
    const logger = buildFake();
    logger.info({ k: 1 });
    expect(logger.entries[0]?.msg).toBeUndefined();
  });
});
