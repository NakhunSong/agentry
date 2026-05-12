# Agent runner

An agent runner translates the framework's "produce a reply" intent into
actual model calls. The default — `ClaudeCliAgentRunner` in
`packages/adapter-runner-claude-cli` — shells out to the Anthropic
`claude` CLI; this guide covers what the contract requires so you can
swap it for a direct API client (Anthropic SDK, OpenAI, local LLM,
mock for tests, etc.).

## Contract

```ts
interface AgentRunner {
  readonly kind: string;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}

interface AgentRunInput {
  readonly sessionId: SessionId;
  readonly workdir: string;
  readonly prompt: string;
  readonly resumeKey?: string;
  readonly context?: { readonly retrievedKnowledge: readonly RetrievedItem[] };
  readonly abortSignal?: AbortSignal;
}

type AgentEvent =
  | { type: 'text_delta';  text: string }
  | { type: 'tool_call';   name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'finished';    reason: 'complete' | 'error' | 'aborted'; usage: TokenUsage; resumeKey?: string }
  | { type: 'error';       message: string; recoverable: boolean };
```

The shape is deliberately close to a streaming completion API so adapter
code is short.

### Three rules the framework relies on

1. **Always end with `finished`.** Even on errors. Even on early termination.
   `HandleIncomingMessage` reads `usage` and `reason` off this event to
   record the agent turn. Skipping it leaves the use case waiting forever.
2. **Yield `text_delta` for streamed output, accumulated by the use case.**
   The use case concatenates them into the agent turn's `contentText` and
   posts the assembled string via `OutboundChannel.reply`. There's no
   per-delta flush at the channel layer at MVP.
3. **`error` events do not replace `finished`.** If your runner surfaces
   an `error`, also emit `finished` with `reason: 'error'`. The use case
   uses `error` to decide whether to skip the reply; `finished` to record
   the turn metadata.

`tool_call` and `tool_result` are pass-through — the use case doesn't
interpret them at MVP, but they're in the type so future observability
features (token-usage logs, tool-use audit trail) don't need a port
change.

### `workdir` is the agent's procedural memory root

The framework passes `input.workdir` as the working directory. For
Claude CLI, this is where the subprocess looks for `CLAUDE.md`,
`.claude/skills/`, `.claude/rules/`, and `.mcp.json`. agentry ships a
default at `seed/agent-workdir/` and forks override per deployment. A
direct-API runner would read these manually and stitch them into the
system prompt.

### `resumeKey` is opaque

The framework passes `resumeKey` through unchanged on the next turn.
Claude CLI uses it for `--resume <session-id>` so the model retains
prior-turn KV cache. A direct-API runner without resume support can
ignore it (and never emit it back); the framework will record `undefined`
and pass `undefined` next time.

## Reference: `ClaudeCliAgentRunner`

Key implementation patterns worth copying:

**Spawn seam for testability**
```ts
constructor(private readonly options: ClaudeCliAgentRunnerOptions = {}) { ... }
async *run(input: AgentRunInput): AsyncIterable<AgentEvent> {
  const spawnFn = this.options.spawn ?? defaultSpawn;
  const child = spawnFn(binary, args, { cwd: input.workdir, ... });
  ...
}
```

Tests inject a fake `spawn` that returns a synthetic `ChildProcess` with
controllable stdout — no real subprocess needed.

**Stream parser owns frame state**
The CLI emits NDJSON (one JSON object per line). `stream-parser.ts`
holds a state machine that translates lines into `AgentEvent`s. Keep
parsing isolated from spawn/IO logic so it's unit-testable in isolation.

**MCP config tempfile lifecycle**
When `options.mcpServers` is non-empty, the runner writes a
process-private JSON file under `os.tmpdir()` (mode 0600, name includes
the PID), passes its path to the CLI via `--mcp-config`, and registers
cleanup hooks for `exit`, `SIGINT`, AND `SIGTERM`. The third one is
non-obvious: `process.once('exit')` does NOT fire on signal-kill, so
without the explicit `SIGTERM` listener the tempfile leaks on
`kill -TERM` in containerized deployments. See PR #69 for the live
verification.

> **Default-fatal suppression caveat**: registering ANY signal listener
> in Node suppresses the default terminate-on-signal behavior. Embedders
> who relied on that (e.g., a script that just exits when SIGTERM hits)
> must drive their own `process.exit()` after cleanup. `apps/server`
> already does this through the shutdown handler; embedders importing
> the runner directly need to match.

## Wiring

Through compose:

```ts
// packages/runtime/src/compose.ts (excerpt — already done in the runtime)
const agentRunner = new ClaudeCliAgentRunner({
  ...(args.spawn !== undefined ? { spawn: args.spawn } : {}),
  ...(mcpServers.length > 0 ? { mcpServers } : {}),
});
```

To swap in your own runner, you'd either:

- **Fork `compose.ts`** and substitute the constructor (heaviest, but the
  test seams come along for free).
- **Build a parallel runtime** in `packages/runtime-myrunner/` that
  shares storage adapters but constructs your runner. Useful when
  multiple deployments use different runners and you don't want a flag
  fight inside one compose.

There is intentionally no `agentRunner` slot in `BuildChannelsResult`
today — runner choice is deeper than a per-channel decision (one runner
typically serves all channels). If you need per-channel runners (an
internal Slack bot using GPT-4 while a CLI bot uses Claude), file an
issue with the driver and the contract will get a slot.

## MCP servers

`McpServerConfig` (in `packages/core/src/domain/mcp-server.ts`) is the
DTO channel adapters use to expose tools to the agent. The runtime
collects every adapter's MCP servers from `BuildChannelsResult.mcpServers`
and passes the union to the runner constructor. The runner's job is to
materialize them in the format the underlying agent expects — for
Claude CLI, an `.mcp.json` file at a path passed via `--mcp-config`.

A direct-API runner would convert `McpServerConfig[]` to the SDK's
`tools` parameter shape, or reject MCP servers entirely (with a
descriptive error at construction) if it doesn't support them.

## Testing

Two flavors of test for runner adapters:

1. **Unit tests with a fake spawn / fake transport.** Verify event
   sequencing — does the runner yield `finished` on every termination
   path? Does an `error` event still get followed by `finished`? Does
   `abortSignal.abort()` produce `reason: 'aborted'`?
2. **Integration test with the real binary / SDK.** Smaller — typically
   one happy-path "say hello" to confirm the prompt + workdir wiring
   actually works end-to-end. Skip in CI by default; run on demand
   during development. The Claude CLI runner uses `__fixtures__/` for
   recorded NDJSON streams the parser tests can replay deterministically.

## Common gotchas

- **Forgetting `finished` on early return.** If you `return` from your
  generator before yielding `finished`, the use case waits indefinitely.
  Even the "subprocess streams unavailable" sad path in the Claude CLI
  runner emits an `error` AND a `finished` before returning.
- **Yielding text after `finished`.** The use case stops consuming once
  it sees `finished`. Late `text_delta`s are silently dropped — usually
  a bug in your buffering, not the framework.
- **Token usage on error.** Emit zero usage (`{ input: 0, output: 0 }`)
  rather than `undefined` — the type is required. Some adapters know
  partial usage even on error and should report it; that's fine.
- **`workdir` doesn't get auto-created.** The framework passes whatever
  string the operator configured — typically `./seed/agent-workdir` —
  and assumes it exists. If your runner needs to bootstrap a fresh
  directory per session, do it inside `run()` before spawning.
