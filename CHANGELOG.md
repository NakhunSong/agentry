# Changelog

All notable changes are recorded here. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it leaves pre-1.0. Until then, every published change is breaking by default.

## [Unreleased] — Phase 4 + early Phase 5

### Added
- Extension guides for channel adapters, agent runners, embedding providers, and store adapters (`docs/extending/*`).
- README quick-start with one-table env-var reference and links to every extension guide.
- `CHANGELOG.md` and `CONTRIBUTING.md`; `FOR_ONBOARDING.md` for the codebase tour.

### Changed
- `docs/extending/configuration.md` answers the previously open question on adapter-specific secrets — centralized `SecretsSchema` in `runtime` is the chosen pattern; adapters take plain values via constructor.
- **JobRunner port redesigned** for cross-process adapters (refs #28). Closure-as-job (`enqueue({ key, job })`) replaced with payload + handler-registry (`register(queue, handler)` returning a typed `JobQueue<P>` with `enqueue({ key, payload })`). `drain()` lifted from the in-memory adapter to the port itself. Same per-key FIFO semantics. Use-case factories now register their queue handler at construction (`HANDLE_INCOMING_QUEUE` exported from `@agentry/core`). The worker callback re-reads `Session` via `SessionStore.findByRef` instead of relying on a closure-captured snapshot — multi-process correctness, aligned with §4.9. Breaking change for any downstream `JobRunner` adapter; both in-memory copies in this repo are updated in lockstep.
- **`recordTurn` idempotency** (refs #28). `TurnInput` gains optional `idempotencyKey`; `Turn` exposes it normalized to `string | null`. A second `recordTurn` call with the same `(sessionId, idempotencyKey)` returns the originally-recorded turn without inserting again — the only safe behaviour under pg-boss at-least-once redelivery. Pgvector adds migration `0002_turn_idempotency.sql` (partial unique on `(session_id, idempotency_key) WHERE idempotency_key IS NOT NULL`) and uses a single-statement CTE `INSERT ... ON CONFLICT DO NOTHING` + fallback `SELECT`. `handle-incoming-message` promotes `idempotencyKey` from a metadata field to a first-class column. Agent turns intentionally do NOT carry a key — every retry produces a fresh agent output.

### Added
- **`@agentry/adapter-jobrunner-pgboss`** (closes #28). Cross-process `JobRunner` backed by pg-boss 12 — durable per-session FIFO, retry with exponential backoff, multi-instance distribution. Uses pg-boss `policy: 'key_strict_fifo'` + `singletonKey = key` (the simpler `singleton` policy doesn't serialize same-key jobs across retries under `localConcurrency > 1`; key_strict_fifo blocks across active/retry/failed, verified on integration tests). Defaults: `retryLimit=3`, `retryDelay=30s`, `retryBackoff=true`, `localConcurrency=10`, `stopTimeoutMs=30_000`. Reuses the existing Postgres (`POSTGRES_URL`) — no new container. Selectable via `agentry.config.ts` `jobRunner: 'pg-boss'` (default remains `'memory'`). Full guide at `docs/extending/job-runner.md`. **Operational requirement**: when a handler exhausts its retries, the key stays blocked indefinitely — subsequent same-session messages are accepted but never processed. No alerting is built in; monitor `pgboss.job WHERE state='failed'` and unblock with `boss.retry(name, id)` or `boss.deleteJob(name, id)`. See "Failure mode you must operate" in the job-runner doc.
- **`JobRunner.start()`** lifted onto the port. Distributed adapters open their schema and bind workers here; the in-memory adapter implements it as a no-op (also flips a flag so late `register()` calls throw symmetrically). Compose calls `await jobRunner.start()` once after all `register()` calls.

## Phase 3 — MVP slice (2026-04 → 2026-05)

The first end-to-end vertical slice. After this milestone a developer can fork, configure, and run a Slack bot answering with Claude, with both turns persisted in pgvector.

### Added
- **Slack channel adapter** (`@agentry/adapter-channel-slack`) with `slack-bolt` 4. `app_mention` events become `IncomingEvent`s; threads become sessions keyed by `slack:${channel}:${thread_ts}`. Single shared `WebClient` across outbound + history backfill.
- **Slack OAuth scope verification at startup** — fails fast on misconfig instead of surfacing a runtime `missing_scope` 24 hours later. Required scopes: `app_mentions:read`, `chat:write`, `channels:history`, `groups:history`, `channels:read`, `groups:read`, `users:read`. Manifest changes require app reinstall.
- **Slack thread history backfill** that records prior thread messages as synthetic user turns on a session's first contact. Bot's own past replies are filtered (`bot_id` exclusion) so they don't get recorded as user turns. The backfill runs **off the inbound ack path** — see *Changed* below.
- **Claude CLI subprocess runner** (`@agentry/adapter-runner-claude-cli`) — streams NDJSON events (`text_delta`, `tool_call`, `tool_result`, `finished`, `error`). Honors `--resume <session-id>` for KV-cache continuity across turns. Supports `--mcp-config` forwarding from channel adapters.
- **MCP servers from channel adapters** — `BuildChannelsResult.mcpServers` is plumbed into the runner, materialized as a process-private tempfile (mode 0600 under `os.tmpdir()`, never written to `seed/agent-workdir/`). Cleanup on `exit`, `SIGINT`, AND `SIGTERM`.
- **Slack MCP tools** for the agent: `slack_get_channel_history` (preserves `bot_id` so the agent can read workflow-bot reports), `slack_get_user_info` (resolves `U…` IDs to display names).
- **`agentry-slack` CLI** — `verify-scopes`, `list-channels`, `send-test-message --channel <id> [--text <msg>] [--thread-ts <ts>]`.
- **Channel context header in the agent prompt** — when a channel's `SessionPolicy` returns `toAgentContext(event)`, the framework prepends a `[Channel context]` block (e.g., `channelId: C123`, `threadTs: 1234.5678`). Lets the agent call `slack_get_channel_history(channelId)` without the user spelling out the ID.
- **Postgres + pgvector schema migrations** (`@agentry/adapter-store-pgvector`). `agentry migrate` CLI applies them idempotently; `_agentry_migrations` table records applied filenames.
- **`PgvectorSessionStore`** with `findOrCreate`, `findByRef` (read-only counterpart, no UPSERT side effect), `setMetadata` (shallow JSONB merge), `recordTurn` (per-session monotonic `seq_no`), `listSessionsForDistillation`.
- **`PgvectorKnowledgeStore`** with `recordSource`, `upsertItem` (dedup by `(tenant_id, external_id)` + canonical hash for distilled items), `retrieve` (semantic mode with cosine), `listByTenant` (server-side cursor stream).
- **`VoyageEmbeddingProvider`** — `voyage-3.5` (1024-dim) by default. Batch up to 128 inputs per request; retry-after honored with a 30s cap.
- **In-memory `JobRunner`** with per-key FIFO chains. Same `key` (typically `sessionId`) → strict FIFO; different keys → parallel. `drain()` for graceful shutdown.
- **`SessionFirstTouch` port** for channel-agnostic session-bootstrap work (Slack history backfill is the reference impl). Runs inside the `JobRunner` queue, off the inbound ack path. Failure is swallowed (logged) so a transient backfill error doesn't drop the live mention.
- **`SessionStore.findByRef`** — read-only counterpart of `findOrCreate` for hot-path checks.
- **Env-shadow detection** — `apps/server` fail-fasts at boot if a shell-exported env var shadows a `.env` value. Lists offending keys (no values; token-shape leak guard). Skipped silently when no `.env` file exists.
- **`SecretsSchema` validation** at startup with key-by-key error messages. Bad values are not echoed back in errors.
- **Logger port** + `PinoLogger` adapter with structured JSON output.
- **`docker-compose.yml`** (dev-only) shipping pgvector/pgvector:pg16.
- **Smoke-test recipe** at `docs/recipes/smoke-test.md` — fresh checkout to working bot in ~30 minutes.

### Changed
- **Slack history backfill moved off the ack path.** Previously `SlackInboundChannel.app_mention` awaited backfill BEFORE forwarding the live event, blocking Slack's 3-second ack budget on `findOrCreate` + `conversations.replies` + `setMetadata`. Now: `app_mention` does only `mapAppMentionToIncomingEvent` + `await handler(live)`. Backfill runs as the first step of the queued job. **Hot path** (already-backfilled session) returns in **6ms** with zero Slack API calls; cold path stays at ~378ms for the one-time fetch.
- **Concurrency consolidated to JobRunner per-key FIFO.** The Slack backfiller no longer carries its own `inFlight` Map; single-process dedup is the queue contract, multi-process drift is reconciled via `findByRef` re-read inside the impl.
- **`agentry-slack` CLI signature unified** to options-object instead of positional args (each command takes `{token, …}`).
- **Bot replies hardened** — `seed/agent-workdir/CLAUDE.md` now requires the agent to resolve `U…` IDs to display names before replying. Live test confirms `송낙훈 (nakhun.song)` instead of `U044K34GBLP`.
- **Apps boundary relaxed** to allow `apps/cli` and `apps/server` to import adapters directly (composition root role per ARCHITECTURE.md §7). `runtime` is convenience, not a chokepoint.

### Fixed
- **`ClaudeCliAgentRunner` SIGTERM tempfile leak** — `process.once('exit')` does not fire on signal-kill. Added explicit `SIGINT` and `SIGTERM` cleanup hooks. Live `kill -TERM <pid>` test confirms tempfile is unlinked. Documented the default-fatal-suppression caveat for embedders relying on Node's terminate-on-signal default.
- **Recipe bugs caught during real e2e** — redundant `pnpm install/build` inside the migrate step; missing `-T` on `docker compose exec` heredoc invocations.

### Removed
- `SlackInboundChannel.backfiller` and `SlackInboundChannel.resolveTenant` options — backfill is now `SessionFirstTouch`-driven, tenant resolution is the use case's responsibility.
- `SlackHistoryBackfiller.backfillIfNeeded` and the in-memory `inFlight` Map. Replaced by `SlackHistoryBackfiller.onFirstTouch({session, event})`.

## Phase 2 — KnowledgeStore design (2026-04)

### Added
- `docs/design/knowledge-store.md` — three-layer memory model (relational + vector + graph), Extract → Cognify → Load pipeline, distillation triggers (idle / explicit / scheduled / rolling), per-source canonical hashing for dedup.

## Phase 1 — Architecture (2026-03 → 2026-04)

### Added
- `ARCHITECTURE.md` — ports & adapters layout, directory boundaries, composition root pattern, MCP exposure model.
- Monorepo bootstrap: pnpm workspaces, TypeScript 6 strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax`, ESM only, `tsc --build` with project references, vitest 4, Biome 2 single-tool lint+format, dependency-cruiser 17 layer-rule enforcement.
- Core ports: `InboundChannel`, `OutboundChannel`, `SessionPolicy`, `SessionStore`, `KnowledgeStore`, `AgentRunner`, `JobRunner`, `EmbeddingProvider`, `Logger`, `McpServerConfig`.
- Domain types in `packages/core/src/domain/` — `IncomingEvent`, `Session`, `Turn`, `KnowledgeItem`, `RetrievalQuery`, etc.
- `HandleIncomingMessage` use case wiring all the above.
- `AgentryConfig` (zod) + `SecretsSchema` (zod) — Phase 3-validated tier separation.
- `@agentry/testing` package with in-memory adapters for use-case tests.
