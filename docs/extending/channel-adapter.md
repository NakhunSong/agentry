# Channel adapter

A channel adapter teaches agentry to talk to a new transport — Slack today,
Discord / Microsoft Teams / a CLI / a webhook tomorrow. This guide walks
the contract using `packages/adapter-channel-slack` as the reference.

## What you implement

Every adapter ships at minimum **three ports** plus an optional fourth:

| Port | Required? | Role |
|---|---|---|
| `InboundChannel` | yes | Long-running listener; pushes `IncomingEvent`s to the framework |
| `OutboundChannel` | yes | One-shot `reply(target, content)` |
| `SessionPolicy` | yes | How the channel maps an event to a session and decides when one ends |
| `SessionFirstTouch` | no | Bootstrap work on a session's first contact (e.g., Slack thread history backfill) |

All four live in `@agentry/core`'s `ports/` directory. The composition
root maps `channelKind: ChannelKind` (an open string like `'slack'`,
`'discord'`, `'cli'`) to the concrete instance.

## Boundary rules (non-negotiable)

- An adapter package only imports from `@agentry/core` (enforced by
  `dependency-cruiser`). No imports from other adapters, `runtime`, or
  `apps`.
- TypeScript: ESM only (`NodeNext` resolution), strict mode +
  `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` +
  `verbatimModuleSyntax`. Use `import type` for type-only imports;
  `.js` extension on every relative import even though the source is
  `.ts`.
- No `any`. Define proper types at every boundary. Use the same
  `Logger` interface from core if you need observability.

## InboundChannel

```ts
interface InboundChannel {
  readonly kind: ChannelKind;
  start(handler: (event: IncomingEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
}
```

The contract has two load-bearing rules:

1. **`handler(event)` MUST return promptly** — typically before the
   agent has produced its reply. Slack enforces a 3-second ack budget;
   any blocking work in the handler will time out and trigger a
   redelivery storm. The framework's `HandleIncomingMessage` does only
   `findOrCreate(session)` + `JobRunner.enqueue(...)` then returns —
   adapters that need bootstrap work belong in `SessionFirstTouch`
   (which runs *inside* the queued job, not on the ack path).
2. **`start()` resolves only when listening stops** — either the
   `AbortSignal` fires or the underlying transport closes. The
   framework's shutdown sequence calls `signal.abort()` and awaits
   every inbound channel's `start()` promise.

### Slack reference

`SlackInboundChannel` (in `packages/adapter-channel-slack/src/slack-inbound-channel.ts`):

- Verifies OAuth scopes against `SLACK_REQUIRED_SCOPES` before
  registering Bolt listeners — fails fast on misconfig instead of
  hitting a runtime "missing_scope" 24 hours later.
- Single-shot `start()` — a second call would register a duplicate
  Bolt event handler and double every event. The composition root
  builds a new instance per restart.
- The `app_mention` handler maps the envelope to `IncomingEvent` and
  awaits `handler(live)` — that's it. Backfill belongs to
  `SessionFirstTouch`, not here.
- The handler wraps in `try/catch` and **swallows** errors with
  `log.error` rather than letting Bolt leave the request un-acked.
  An unhandled throw causes Slack to redeliver — idempotency would
  catch the dup but you'd burn cycles on every redelivery.

```ts
app.event('app_mention', async ({ event, body, logger }) => {
  try {
    const live = mapAppMentionToIncomingEvent({ event, ...body });
    await handler(live);
  } catch (err) {
    logger.error({ err }, 'slack app_mention handling failed');
  }
});
```

## OutboundChannel

```ts
interface OutboundChannel {
  readonly kind: ChannelKind;
  reply(target: ReplyTarget, content: ReplyContent): Promise<ReplyAck>;
}
```

One-shot reply only. There is intentionally no `update(messageRef, content)`
at MVP — many transports (email, generic HTTP) don't support edit, and
adding it later when a real UX gap appears is cheaper than removing it.

`ReplyTarget` carries the same `threading` blob the inbound channel
attached to the original `IncomingEvent` — adapters cooperate with
themselves by reading whatever opaque routing keys they originally set
(Slack: `channel` + `thread_ts`; Discord: `thread_id`; etc.). The
framework treats `threading` as black-box.

`ReplyAck` returns the adapter-native message id (Slack `ts`, Discord
`message_id`) plus a `postedAt` timestamp.

## SessionPolicy

```ts
interface SessionPolicy {
  readonly channelKind: ChannelKind;
  computeNativeRef(event: IncomingEvent): ChannelNativeRef;
  idleTimeoutMinutes(): number;
  shouldEndOn(event: SessionLifecycleEvent): boolean;
  toAgentContext?(event: IncomingEvent): Readonly<Record<string, string>>;
}
```

- `computeNativeRef` — pure, sync; produces the channel-specific
  session key. The framework feeds this to
  `SessionStore.findOrCreate(channelKind, ref, tenantId)`. Slack uses
  `slack:${channel}:${thread_ts}`; a CLI adapter might use
  `cli:${process.env.AGENT_SESSION_ID}`. Convention: `<kind>:<scope>`.
- `idleTimeoutMinutes` — when `JobRunner` fires the idle timer, this
  controls when an active session transitions to `idle`. Slack
  defaults to 24h.
- `shouldEndOn` — predicate over framework-observed lifecycle events
  (idle timer, transport close, user-left). Slack only ends on
  `channel_close`; everything else stays.
- `toAgentContext` (optional) — returns string-valued context the
  framework prepends to the agent prompt under
  `CHANNEL_CONTEXT_HEADER`. The Slack policy returns
  `{channelId, threadTs}` so the agent can call
  `slack_get_channel_history(channelId)` without the user spelling
  out the ID. Implement this whenever your channel adapter ships
  MCP tools that need self-aware context.

## SessionFirstTouch (optional)

```ts
interface SessionFirstTouch {
  onFirstTouch(input: { session: Session; event: IncomingEvent }): Promise<readonly IncomingEvent[]>;
}
```

Channel-agnostic session-bootstrap hook. Invoked **inside the
`JobRunner` queue** — off the inbound ack path — on each session's
first contact. Returns synthetic `IncomingEvent`s the framework
records as user turns BEFORE the live event's agent run.

Implementations own their "already done" flag (typically via
`session.metadata`) and reconcile single-process FIFO + multi-process
drift via `SessionStore.findByRef`.

**Failure semantics**: if `onFirstTouch` throws, the use case logs
and still processes the live event. Synthetic delivery is
best-effort.

The Slack reference (`SlackHistoryBackfiller`) does:

1. Closure-snapshot check on `session.metadata.slackBackfilled` — if
   true, return `[]` (cheap path; no I/O).
2. `findByRef` re-read for the multi-process race — if a sibling
   worker already flipped the flag between `findOrCreate` and now,
   return `[]` (no `setMetadata`, no Slack API).
3. Otherwise fetch `conversations.replies(limit: 1000)`, map to
   synthetic events (filter bot messages and the live mention),
   `setMetadata({slackBackfilled: true})`, return synthetics.

The hot path measured live: **6ms** (DB read + closure check, zero
Slack API calls). Cold path: ~378ms (one `conversations.replies`).

Skip implementing `SessionFirstTouch` entirely if your channel has
no per-session bootstrap (a CLI adapter, an HTTP webhook). The
framework simply doesn't invoke it for that channel kind.

## Wiring it into the composition root

```ts
// apps/server/src/main.ts (excerpt)
const handles = await compose({
  config,
  secrets,
  buildChannels: ({ sessionStore, logger }) => {
    const policy = new MyChannelPolicy();
    const outbound = new MyOutboundChannel({ apiKey: secrets.MY_API_KEY });
    const firstTouch = new MyFirstTouch({ sessionStore, sessionPolicy: policy, logger }); // optional
    const inbound = new MyInboundChannel({ apiKey: secrets.MY_API_KEY, port: 4000 });
    return {
      inboundChannels: [inbound],
      outboundChannels: new Map([[policy.channelKind, outbound]]),
      sessionPolicies: new Map([[policy.channelKind, policy]]),
      sessionFirstTouches: new Map([[policy.channelKind, firstTouch]]), // omit if not implementing
      mcpServers: [...], // optional, see agent-runner guide
    };
  },
});
```

The `buildChannels` factory receives `{sessionStore, logger}` from
compose so adapters can take them as constructor args.

## Adapter MCP tools (optional)

Adapters that expose tools to the agent — letting it call
`slack_get_channel_history(channelId)` mid-conversation — ship an
MCP server config via `BuildChannelsResult.mcpServers`. See
`packages/adapter-channel-slack/src/slack-mcp-config.ts` for the
Slack reference. The runtime forwards the config to the
`AgentRunner`, which wires it into the agent process's MCP client.

## Test seams

Slack tests inject a fake `App` (Bolt) and a fake `fetch` so unit
tests skip the real HTTP listener and Slack auth:

```ts
const ch = new SlackInboundChannel({
  ...baseOpts,
  app: fakeApp(),     // skips Bolt's HTTP bind
  fetch: fakeFetchOk(['app_mentions:read', 'chat:write']), // skips auth.test
});
```

Constructor seams (preferred over module-level singletons or env
checks) keep your tests deterministic without `process.env` stubbing.

The boundary tax: depcruiser forbids adapter packages from importing
`@agentry/testing`, so you can't reuse `silentLogger` or other
testing fakes. Either inline a minimal `Logger` shape in the test file
(see `slack-inbound-channel.test.ts`) or accept the duplication.

## Common gotchas

- **Slack manifest changes require reinstall.** Adding a scope to
  `SLACK_REQUIRED_SCOPES` doesn't auto-grant it on existing installs;
  the `verifySlackScopes` call at startup will throw and the operator
  must reinstall the app.
- **Idempotency.** `IncomingEvent.idempotencyKey` is your hook for
  dedup; the framework records it on the user turn so a redelivery
  doesn't double-write. Compute it from a transport-stable id (Slack:
  `event_id`, never `ts`).
- **Threading is opaque.** `ThreadingMetadata` is `Readonly<Record<string, unknown>>`
  — the framework never reads it. Your adapter is the sole reader on
  both ends; pick keys you control. Slack uses
  `{channel, thread_ts, message_ts, team_id}`.
- **Synthetic events get `metadata.synthetic = true`.** The use case
  records them as user turns then short-circuits — no agent run, no
  reply. Don't forget the flag when emitting from `SessionFirstTouch`.
- **DM support is a separate concern.** Slack DMs would need a
  different `channelKind` (e.g., `'slack-dm'`) plus its own
  `SessionPolicy.computeNativeRef` — DMs key by user, not thread.
  Deferred until a real driver appears.
