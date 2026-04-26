// Structured logger contract. Mirrors the pino API (the default adapter)
// — six level methods plus `child()` for bindings propagation. Per
// ARCHITECTURE.md §4.7, recommended standard keys are: `tenantId`,
// `sessionId`, `turnId`, `channelKind`, `channelNativeRef`, `traceId`,
// `adapterKind`. Use cases create child loggers bound to the current
// session for context propagation.
//
// `obj: object` (not `Record<string, unknown>`) preserves compatibility
// with pino-shaped subclasses callers may want to pass; primitives are
// rejected at the type level so `info('hello')` won't compile.
export interface Logger {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string): void;
  warn(obj: object, msg?: string): void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
  // Returns a new logger; bindings are merged into every subsequent log
  // line. Inner bindings override outer on key collision (pino convention).
  child(bindings: object): Logger;
}
