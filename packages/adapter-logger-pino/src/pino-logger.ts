import type { Logger } from '@agentry/core';
import pino, { type Logger as PinoBase } from 'pino';

// pino accepts seven level filters; the port (#54) only declares six call
// methods. `silent` is a *threshold* (suppress all output), not a level you
// emit at — it's coherent to expose here without growing the port surface.
export type PinoLogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal' | 'silent';

export interface PinoLoggerOptions {
  readonly level?: PinoLogLevel;
  readonly bindings?: Readonly<Record<string, unknown>>;
  // Pass a Writable for tests; default is pino's default (stdout). pino
  // writes synchronously when given a plain Writable (no SonicBoom buffering).
  readonly destination?: NodeJS.WritableStream;
}

export class PinoLogger implements Logger {
  // Private constructor + static factory so callers can't bypass the
  // options bag; `child()` is the only path that wraps a pre-built pino
  // instance, preserving pino's native child-binding inheritance.
  private constructor(private readonly inner: PinoBase) {}

  static create(options: PinoLoggerOptions = {}): PinoLogger {
    const opts = { level: options.level ?? 'info' };
    let p = options.destination ? pino(opts, options.destination) : pino(opts);
    if (options.bindings) p = p.child(options.bindings);
    return new PinoLogger(p);
  }

  trace(obj: object, msg?: string): void {
    this.inner.trace(obj, msg);
  }

  debug(obj: object, msg?: string): void {
    this.inner.debug(obj, msg);
  }

  info(obj: object, msg?: string): void {
    this.inner.info(obj, msg);
  }

  warn(obj: object, msg?: string): void {
    this.inner.warn(obj, msg);
  }

  error(obj: object, msg?: string): void {
    this.inner.error(obj, msg);
  }

  fatal(obj: object, msg?: string): void {
    this.inner.fatal(obj, msg);
  }

  // The port's `child(bindings)` is binding-only by design. For per-child
  // level overrides or msgPrefix (pino-native features), construct a fresh
  // `PinoLogger.create({ level, bindings })` instead.
  child(bindings: object): Logger {
    return new PinoLogger(this.inner.child(bindings));
  }
}
