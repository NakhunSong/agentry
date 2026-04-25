# agentry — Architecture

> Phase 1 design output. Captures the load-bearing decisions: domain model,
> port interfaces, module boundaries, composition strategy, and per-channel
> conventions. Subsequent phases (Phase 2 KnowledgeStore detail, Phase 3 MVP
> implementation) build against this document without re-litigating boundaries.

## Status

**Approved (Phase 1).** Changes to ports require an issue and an explicit ADR-style
amendment to this document.

---

## 1. Goals & Non-Goals

### Goals

- Build a **fork-friendly framework** for personal Claude-powered agents.
- Plug-in **multiple input channels** (Slack first, others via the same port shape).
- Run on **Claude subscription** via the `claude` CLI subprocess; allow swap to the
  Claude Agent SDK behind a single port.
- Memory that **learns**: episodic turns are stored verbatim; a separate distillation
  pipeline (Phase 2) produces semantic `KnowledgeItem`s with provenance back to
  source turns.
- **Single `docker compose up`** brings up the whole stack on a VPS.
- **Single-direction sync**: framework upgrades push procedural assets and seed
  knowledge to forks; user-generated data is never touched by upstream.

### Non-Goals (this release)

- Multi-agent orchestration. Single agent per session.
- Built-in graph/relational reasoning over knowledge. Phase 2+ as opt-in.
- Streaming UX (placeholder-then-update messages). MVP buffers and posts once.
- Cross-process distributed workers. MVP is single-process.

---

## 2. Architectural Principles

1. **Hexagonal (ports & adapters).** Domain core knows nothing about Slack, Postgres,
   or Claude. Every external collaborator is a port with swappable adapters.
2. **Three memory layers** (Extract → Cognify → Load):
   - Relational (provenance) — where a fact came from
   - Vector (semantic) — what it means
   - Graph (relational reasoning) — how facts connect *(Phase 2+, opt-in)*
3. **Episodic vs semantic separation.** Raw turns are persisted as-is. Distillation
   is a separate, triggered pipeline producing `KnowledgeItem`s.
4. **Procedural memory = `seed/agent-workdir/`.** The framework ships a default
   agent working directory (`CLAUDE.md`, `.claude/`, `.mcp.json`) that becomes the
   agent's procedural memory. Users override per-deployment.
5. **Single-direction sync.** Framework updates may replace `project_seed`-tagged
   knowledge using `externalId` for stable reconciliation. `user_session` and
   `external_sync` items are never touched by upstream.
6. **Manual composition root over DI framework.** Fork users read top-to-bottom
   and edit `compose.ts` directly to swap adapters.

---

## 3. Domain Model

Channel-agnostic entities. Defined in `packages/core/src/domain/`.

```ts
type ChannelKind = string;       // 'slack' | 'discord' | 'cli' | 'http' | ...
type ChannelNativeRef = string;  // channel-specific opaque conversation ref
type TenantId = string;          // multi-tenant boundary; default 'default'

interface Session {
  id: SessionId;
  tenantId: TenantId;
  channelKind: ChannelKind;
  channelNativeRef: ChannelNativeRef;
  startedAt: Date;
  lastActiveAt: Date;
  status: 'active' | 'idle' | 'ended';
  participants: Participant[];
  metadata: Record<string, unknown>;
}

interface Participant {
  channelKind: ChannelKind;
  channelUserId: string;
  displayName?: string;
}

interface Turn {
  id: TurnId;
  sessionId: SessionId;
  authorRole: 'user' | 'agent' | 'system';
  authorRef?: Participant;
  content: TurnContent;
  createdAt: Date;
  metadata: Record<string, unknown>;  // includes token usage from finished events
}

interface TurnContent {
  text: string;
  // Future: attachments, structured blocks
}

interface KnowledgeItem {
  id: KnowledgeId;
  tenantId: TenantId;
  externalId: string | null;             // stable id for project_seed reconciliation
  sourceType: 'project_seed' | 'user_session' | 'external_sync';
  kind: 'fact' | 'decision' | 'qa_pair' | 'procedure';
  text: string;
  embedding?: Float32Array;
  derivedFrom: ProvenanceRef;            // session+turn range OR external source ref
  extractorVersion: string;
  confidence: number;                     // 0..1
  createdAt: Date;
  updatedAt: Date;
  metadata: Record<string, unknown>;
}
```

**Why `sourceType` and `externalId` together**: `sourceType` separates upgrade-safe
buckets (`project_seed` may be wholesale-replaced on framework upgrade);
`externalId` enables stable insert/update/delete reconciliation within a bucket
(prevents wholesale rebuild and preserves IDs that existing references may rely on).

**Why `tenantId` from day one**: schema cost is near-zero now; retrofit cost is
high. Single-deployment fork uses `'default'` and ignores it.

---

## 4. Ports

All ports live in `packages/core/src/ports/`. Adapters live in `packages/adapter-*/`.

### 4.1 InboundChannel / OutboundChannel — issue #6

```ts
interface InboundChannel {
  readonly kind: ChannelKind;
  /**
   * Long-running listener. The handler MUST return promptly after enqueuing
   * the work — typically before the agent has produced its response. Channels
   * with strict ack windows (Slack: 3s) rely on this contract.
   */
  start(handler: (e: IncomingEvent) => Promise<void>, signal: AbortSignal): Promise<void>;
}

interface IncomingEvent {
  channelKind: ChannelKind;
  channelNativeRef: ChannelNativeRef;
  author: Participant;
  payload: TurnContent;
  threading: ThreadingMetadata;
  receivedAt: Date;
  idempotencyKey: string;     // adapter-computed; protects against duplicate webhooks
}

interface OutboundChannel {
  readonly kind: ChannelKind;
  reply(target: ReplyTarget, content: ReplyContent): Promise<ReplyAck>;
}
```

**Decisions**

- **Handler is enqueue-and-return, not await-completion.** The Slack adapter MUST
  ack within 3s; the handler's job is to push to `JobRunner` and return.
- **Inbound and Outbound are separate ports.** Cross-channel routing (read Slack,
  reply via email) is supported by the framework even if no adapter does it yet.
- **`idempotencyKey` is mandatory** on `IncomingEvent`. Slack Events API and most
  webhook protocols redeliver on timeout.
- **Outbound is one-shot for MVP.** No `update(messageRef, content)`. Many transports
  (email, generic HTTP) don't support edit; the abstraction stays clean. Revisit
  when a real UX gap appears.

### 4.2 AgentRunner — issue #7

```ts
interface AgentRunner {
  readonly kind: 'claude_cli' | 'claude_sdk' | string;
  run(input: AgentRunInput): AsyncIterable<AgentEvent>;
}

interface AgentRunInput {
  sessionId: SessionId;
  workdir: string;             // path to agent-workdir (procedural memory)
  prompt: string;
  /**
   * Opaque cache hint. Adapters MAY use this for prompt caching but MUST NOT
   * rely on it for correctness — the canonical session source is SessionStore.
   */
  resumeKey?: string;
  context?: { retrievedKnowledge: RetrievedItem[] };
  abortSignal?: AbortSignal;
}

type AgentEvent =
  | { type: 'text_delta'; text: string }
  | { type: 'tool_call'; name: string; input: unknown }
  | { type: 'tool_result'; name: string; output: unknown }
  | { type: 'finished'; reason: 'complete' | 'error' | 'aborted'; usage: TokenUsage; resumeKey?: string }
  | { type: 'error'; message: string; recoverable: boolean };
```

**Decisions**

- **SessionStore is canonical, claude CLI is stateless.** Each invocation
  reconstructs the prompt from system instructions + retrieved knowledge +
  recent turns. We do not rely on `--resume` for correctness because (a)
  injected RAG between turns breaks CLI's prompt cache assumptions, (b)
  distillation needs to read turns directly, (c) SDK swap stays symmetric.
  `resumeKey` is documented as a cache hint only.
- **AsyncIterable for streaming.** Maps cleanly to CLI `--output-format stream-json`
  and to SDK event streams.
- **Runner does not dispatch tools.** Tool execution happens inside `claude` CLI.
  The runner only surfaces `tool_call` / `tool_result` as observable events.
- **Token usage is always persisted.** `finished.usage` lands in `Turn.metadata`.

### 4.3 SessionStore + per-channel SessionPolicy — issue #8

```ts
interface SessionStore {
  findOrCreate(kind: ChannelKind, ref: ChannelNativeRef, tenant: TenantId): Promise<Session>;
  recordTurn(sessionId: SessionId, turn: Omit<Turn, 'id' | 'createdAt'>): Promise<Turn>;
  getRecentTurns(sessionId: SessionId, limit: number): Promise<Turn[]>;
  updateStatus(sessionId: SessionId, status: Session['status']): Promise<void>;
  setMetadata(sessionId: SessionId, patch: Record<string, unknown>): Promise<void>;
  listSessionsForDistillation(criteria: DistillationCriteria): Promise<SessionId[]>;
}

interface SessionPolicy {
  readonly channelKind: ChannelKind;
  computeNativeRef(event: IncomingEvent): ChannelNativeRef;
  idleTimeoutMinutes(): number;
  shouldEndOn(e: SessionLifecycleEvent): boolean;
}
```

**Per-channel policy table**

| Channel | NativeRef computation | Lifecycle |
|---|---|---|
| Slack (channel) | `slack:${channel_id}:${thread_ts}` (thread required) | Idle 24h |
| Slack (DM) | `slack-dm:${channel_id}` (no threads in DMs; channel is the session) | Idle 24h |
| Discord | `${channel_id}:${thread_id ?? message_id}` | Idle 24h |
| CLI | env `AGENT_SESSION_ID` or PID-based | Process exit ends session |
| HTTP | header `X-Conversation-Id` (required) | Explicit DELETE or idle timeout |

**Slack-specific notes**

- **Thread required in channels.** A bare channel mention (no thread context)
  triggers a thread by replying with `thread_ts = message_ts` of the mention.
- **DM is one rolling session per DM channel.** No thread concept exists there.
- **Mid-thread mention is fully supported.** Same `thread_ts` → same session →
  prior bot turns immediately available to the agent.
- **Filling the human-side-conversation gap.** Bot subscribes only to `app_mention`,
  so messages between humans in the thread are not delivered live. On receiving
  an `app_mention` whose `thread_ts` resolves to a session with unseen `ts`s, the
  Slack adapter calls `conversations.replies(channel, thread_ts)` and emits the
  unseen messages as `IncomingEvent`s with `metadata.synthetic = true`. The use
  case persists synthetic events as turns without invoking the agent. Per-key
  `JobRunner` ensures these are recorded before the live mention is processed.
  *Privacy note*: when mentioned, the bot necessarily learns the entire thread
  history — operators must communicate this. An opt-in `message.channels`
  subscription is a Phase 2+ option for always-listening deployments.

**OAuth scope matrix**

| Capability | Required Slack scopes |
|---|---|
| Receive mentions, post replies | `app_mentions:read`, `chat:write` |
| Thread context fetch (lazy `conversations.replies`) | `channels:history` (public), `groups:history` (private) |
| Channel history tool (see §11 Tool Exposure) | above + `channels:read` (resolve names), `groups:read` for private channels |
| DM | `im:history`, `im:read` |

The Slack adapter MUST verify granted scopes at startup and fail fast with an
actionable remediation message if any required scope for a configured capability
is missing.

### 4.4 KnowledgeStore — issue #9

```ts
interface KnowledgeStore {
  recordSource(ref: SourceRef): Promise<SourceId>;
  upsertItem(item: Omit<KnowledgeItem, 'id' | 'createdAt' | 'updatedAt'>): Promise<KnowledgeId>;
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;

  /** Phase 2+ opt-in. */
  searchRelational?(query: GraphQuery): Promise<RetrievedSubgraph>;

  deleteBySource(sourceId: SourceId): Promise<void>;
  deleteByExternalId(tenantId: TenantId, externalId: string): Promise<void>;  // upgrade reconciliation
  listByTenant(tenantId: TenantId, filter: ItemFilter): AsyncIterable<KnowledgeItem>;
}

interface RetrievalQuery {
  text: string;
  tenantId: TenantId;
  mode: 'semantic' | 'hybrid' | 'relational';
  topK: number;
  filters?: ItemFilter;
}
```

**Adapter capability matrix**

| Adapter | semantic | hybrid | relational | Phase |
|---|---|---|---|---|
| `PgvectorStore` | ✓ | partial (BM25 add-on) | — | 1 (MVP) |
| `PgvectorAgeStore` | ✓ | ✓ | ✓ | 2 |
| `CogneeStore` (HTTP sidecar) | ✓ | ✓ | ✓ | 2 (opt-in) |

**Decisions**

- **Provenance is mandatory** on every `KnowledgeItem` (`derivedFrom` non-null).
- **`externalId` enables upgrade reconciliation.** Framework ships seed knowledge
  with stable `externalId`s; upgrades replace by id without disturbing user data.
- **`upsertItem` is the only write path.** Adapters compute embedding on insert
  (calling `EmbeddingProvider`) and recompute on text change.

### 4.5 KnowledgeSource — issue #10

```ts
interface KnowledgeSource {
  readonly kind: SourceKind;
  readonly syncMode: 'snapshot' | 'incremental' | 'on_demand';

  /** snapshot/incremental sources produce items in bulk. */
  pull(opts: PullOptions): AsyncIterable<KnowledgeIngestion>;

  /** on-demand sources fetch reactively. */
  fetch?(query: string): Promise<KnowledgeIngestion[]>;
}

interface KnowledgeIngestion {
  text: string;
  sourceRef: SourceRef;
  sourceType: 'project_seed' | 'external_sync';
  externalId?: string;
  hints?: { kind?: KnowledgeItem['kind']; metadata?: Record<string, unknown> };
}
```

**Source → sync mode matrix**

| Source | Sync mode | Rationale |
|---|---|---|
| GitHub repo (code) | incremental (webhook) | Large, frequent changes, freshness matters |
| GitHub issues/PRs | on-demand | Volatile, indexing churn not worth it |
| Notion / Confluence | incremental | Webhook-friendly, well-structured |
| Web page | snapshot | Cheap, set-and-forget |
| Project wiki/MD (project_seed) | snapshot at framework-update time | Single-direction sync |
| Structured DB | NOT a knowledge source | Expose as MCP tool instead |

### 4.6 EmbeddingProvider — issue #23

```ts
interface EmbeddingProvider {
  readonly model: string;       // e.g., 'voyage-3'
  readonly dimension: number;   // declared, validated by KnowledgeStore on init
  embed(texts: string[]): Promise<Float32Array[]>;
}
```

**Default**: Voyage `voyage-3`. Best-in-class retrieval quality at the time of writing.
Alternative `OpenAIEmbeddingProvider` (`text-embedding-3-large`, 3072 dim) ships
as second adapter. Dimension mismatch between provider and store is a startup error.

### 4.7 Logger — issue #24

```ts
interface Logger {
  trace(obj: object, msg?: string): void;
  debug(obj: object, msg?: string): void;
  info(obj: object, msg?: string):  void;
  warn(obj: object, msg?: string):  void;
  error(obj: object, msg?: string): void;
  fatal(obj: object, msg?: string): void;
  child(bindings: object): Logger;
}
```

**Default**: pino. **Standard log keys** (must be present where applicable):
`tenantId`, `sessionId`, `turnId`, `channelKind`, `channelNativeRef`, `traceId`,
`adapterKind`. Use cases create child loggers bound to the current session for
context propagation.

### 4.8 JobRunner — issue #25

```ts
interface JobRunner {
  /**
   * Enqueue a job. Same `key` → serialized FIFO. Different keys → parallel.
   * Resolves after the job is enqueued (NOT after it completes).
   */
  enqueue(opts: { key: string; job: () => Promise<void> }): Promise<void>;
}
```

**Why per-key**: back-to-back messages in the same Slack thread arrive faster than
agent runs complete. Without per-key serialization, two parallel `recordTurn`s and
two parallel agent invocations race on the same session — interleaved or duplicated
state results. Per-key serial guarantees ordered processing within a session.

**MVP adapter**: in-memory `Map<key, Promise>` chain. Single process.

**When to swap to a cross-process queue**

Default production target is **pg-boss** (uses existing Postgres, no new
container — preserves the "single docker compose" promise). BullMQ is an opt-in
alternative for users wanting Bull Board / Redis-backed semantics.

Switch from in-memory if **any one** of the following holds:

| # | Trigger | Why |
|---|---|---|
| 1 | Horizontal scaling: 2+ runtime instances behind a load balancer | In-memory `Map<key, Promise>` is process-local; same `sessionId` arriving at different instances breaks per-key serialization |
| 2 | Restart durability required | In-memory loses queued jobs on deploy / crash |
| 3 | Long-running background jobs regularly exceed 60s | Distillation or full-sync block agent latency in-process; need separate worker |
| 4 | Operational visibility (retry dashboard, DLQ, queue stats) | In-memory adapter exposes none |
| 5 | Per-source rate limiting (GitHub API quotas, etc.) | Centralized throttling natural in queue, awkward in-memory |

If none apply (single VPS, single process, light traffic, Slack retry tolerance
acceptable), in-memory remains the right choice. Implementation tracked in #28.

---

## 5. Use Cases

In `packages/core/src/app/`. These compose ports — they are the only place
business logic lives.

### 5.1 HandleIncomingMessage

```
IncomingEvent
   │
   ▼
SessionStore.findOrCreate ──► Session
   │
   ▼ (if Slack synthetic-history needed: emit prior IncomingEvents first)
JobRunner.enqueue(key=sessionId, job=processOneTurn)
   │
   ▼  (per-key serial)
[processOneTurn]
   │
   ├── SessionStore.recordTurn(user)
   ├── KnowledgeStore.retrieve(query=user.text, tenantId)
   ├── AgentRunner.run({ prompt, context.retrievedKnowledge })
   │     └── consume AgentEvents
   ├── SessionStore.recordTurn(agent, metadata.usage)
   └── OutboundChannel.reply(target, response)
```

### 5.2 DistillSession (Phase 2 implementation)

```
trigger (idle timeout / explicit / scheduled)
   │
   ▼
SessionStore.listSessionsForDistillation
   │
   ▼  per session:
[Extract]  AgentRunner.run(special distillation prompt over recent turns)
[Cognify]  EmbeddingProvider.embed(extracted items)
           dedup against existing items by canonical hash + cosine
[Load]     KnowledgeStore.upsertItem (sourceType='user_session', derivedFrom=session+turns)
```

### 5.3 IngestKnowledge

```
trigger (webhook / scheduled / manual)
   │
   ▼
KnowledgeSource.pull(since=lastWatermark)
   │
   ▼  per ingestion:
EmbeddingProvider.embed(text)
KnowledgeStore.upsertItem (sourceType from source, externalId from ingestion)
```

---

## 6. Directory Layout & Module Boundaries — issue #11

**pnpm workspaces monorepo.**

```
agentry/
├── packages/
│   ├── core/                       # domain + ports + use cases (zero runtime deps)
│   │   └── src/{domain,ports,app}/
│   ├── testing/                    # in-memory adapters for use-case tests
│   │   └── src/{session-store,knowledge-store,job-runner,agent-runner,channels}/
│   ├── adapter-channel-slack/      # slack-bolt
│   ├── adapter-runner-claude-cli/  # subprocess + stream-json parser
│   ├── adapter-store-pgvector/     # Postgres + pgvector
│   ├── adapter-source-github/
│   ├── adapter-embedding-voyage/   # default
│   ├── adapter-embedding-openai/   # alternative
│   ├── adapter-logger-pino/        # default
│   ├── adapter-jobrunner-memory/   # MVP default
│   └── runtime/                    # composition root, config schema
├── apps/
│   ├── server/                     # long-running process (Hono)
│   └── cli/                        # `agentry migrate`, `agentry distill`, etc.
├── seed/
│   └── agent-workdir/              # default procedural memory shipped with framework
│       ├── CLAUDE.md
│       ├── .claude/{rules,skills}/
│       └── .mcp.json
├── docs/
│   ├── recipes/                    # docs/recipes/nakbot/ etc.
│   └── extending/                  # how to add channels / sources / runners
├── docker/
│   ├── Dockerfile
│   └── docker-compose.yml
└── ARCHITECTURE.md (this file)
```

**Dependency rules** (enforced by `dependency-cruiser`):

| From | May import |
|---|---|
| `core/` | nothing (zero runtime deps; only types and stdlib) |
| `testing/` | `core/` only |
| `adapter-*/` | `core/` only |
| `runtime/` | `core/` + zero or more `adapter-*` |
| `apps/*` | `runtime/` only |

**Why monorepo**: package-level `dependencies` enforce boundaries naturally. Forks
can publish their own adapter packages. Adapters evolve independently.

**Why a `packages/testing/` package**: without in-memory adapters, every use-case
test would require Postgres + Slack + Claude. Use cases are the most valuable thing
to test; they must be testable in milliseconds.

---

## 7. Composition Root — issue #12

**Manual composition root, no DI framework.** `packages/runtime/src/compose.ts`:

```ts
export async function compose(config: AgentryConfig): Promise<RuntimeHandles> {
  const logger      = makePinoLogger(config.logging);
  const jobRunner   = new MemoryJobRunner();
  const embedder    = new VoyageEmbeddingProvider(config.embedding);
  const sessionStore   = new PgvectorSessionStore({ ...config.postgres, logger });
  const knowledgeStore = new PgvectorKnowledgeStore({ ...config.postgres, embedder, logger });
  const runner      = new ClaudeCliAgentRunner({ workdir: config.agentWorkdir, logger });

  const inboundChannels = config.channels.map(c => createInboundChannel(c, { logger }));
  const outboundChannels = createOutboundMap(config.channels, { logger });

  const handleIncoming = makeHandleIncomingMessage({
    sessionStore, knowledgeStore, runner, outboundChannels, jobRunner, logger,
  });

  const inboundHandlers = inboundChannels.map(ch =>
    ch.start(handleIncoming, abortSignal)
  );

  return { inboundChannels, shutdown: makeShutdown(...) };
}
```

**Why no DI framework**:

- Fork users read top-to-bottom and see every wiring decision
- TypeScript types prove correctness — no runtime resolution surprises
- `tsyringe` / `awilix` add decorator metadata + learning curve
- The customization surface for forks is exactly one file

**Config**: `agentry.config.ts` (TypeScript file, `zod`-validated). Env var
interpolation supported. CLI override for ad-hoc overrides.

---

## 8. Migrations & Operational Notes

- **Each storage adapter ships its own migrations.** `apps/cli` exposes
  `agentry migrate` which iterates registered adapters. Composition root does NOT
  auto-migrate on startup — operator runs it explicitly.
- **No subprocess pooling for `claude` CLI in MVP.** ~1–2s spawn cost per turn
  is acceptable for Slack-paced UX. Lifecycle complexity not worth marginal latency.
- **Token usage is persisted per turn** (`Turn.metadata.usage`). Aggregations are
  query-time concerns, not storage concerns.

---

## 9. Open Items Tracked Outside This Document

| Concern | Where tracked |
|---|---|
| KnowledgeStore SQL schema, distillation prompts | Phase 2 issues #13–#17 |
| Slack adapter implementation | Phase 3 issue #18 |
| Claude CLI runner implementation | Phase 3 issue #19 |
| Postgres + pgvector migrations | Phase 3 issue #20 |
| Reference recipe: Nakbot | Phase 3 issue #22 |
| Documentation site | Phase 4 epic #4 |
| Docker compose & VPS deploy | Phase 5 epic #5 |
| `project_seed` upgrade procedure (uses `externalId`) | Phase 4 / Phase 5 |
| Optional `message.channels` subscription for always-listening Slack | Post-MVP |
| placeholder-then-update streaming UX | Post-MVP, port revision required |
| Cross-process JobRunner (BullMQ / pg-boss) | Phase 5 |

---

## 10. Configuration & Secrets — issue #27

Three-tier separation. Each value belongs to exactly one tier; mixing tiers leaks
secrets into git or scatters configuration.

| Tier | Examples | Storage |
|---|---|---|
| **Secret** (never in git) | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`, `VOYAGE_API_KEY`, `POSTGRES_URL` | Env vars only. `.env` (gitignored) → `docker-compose env_file` → `process.env`. `zod`-validated at startup; missing values cause immediate fail. |
| **Configuration** (workspace/deployment-specific) | Channel allowlists, idle timeout, embedding model name, distillation triggers | `agentry.config.ts` (TypeScript, committable). Values come from env interpolation: `channels: process.env.SLACK_ALLOWED_CHANNELS?.split(',')`. |
| **Runtime-resolved** (dynamic) | Slack channel IDs from `#channel-name` mentions, user info, message timestamps | Not pre-configured. Agent resolves via tools (§11) at run time. |

**Why prefer runtime resolution for IDs over pre-configured channel lists**:

- Avoids redeploy whenever a new channel is added
- Naturally constrains the bot to channels it's actually invited to (Slack scope semantics enforce this — `channels:history` only sees joined channels)
- Matches users' natural language ("check #other-channel") with no operator setup

**Schema validation pattern**:

```ts
import { z } from 'zod';

const SecretsSchema = z.object({
  SLACK_BOT_TOKEN:      z.string().startsWith('xoxb-'),
  SLACK_SIGNING_SECRET: z.string().min(1),
  POSTGRES_URL:         z.string().url(),
  VOYAGE_API_KEY:       z.string().min(1),
  // ...
});

export const secrets = SecretsSchema.parse(process.env);
```

Production deployments may swap env loading for a secret manager (Vault, AWS
Secrets Manager, Doppler) by wrapping the loader. The `secrets` consumer surface
stays stable — adapters don't know where the value came from.

---

## 11. Tool Exposure to the Agent — issue #26

The agent (Claude) gains capabilities in two ways. Both are first-class. Adapters
choose per tool which mechanism fits.

### 11.1 MCP servers (recommended for structured, high-frequency tools)

Each adapter MAY ship a stdio MCP server in `<adapter-package>/mcp/`. The
composition root collects enabled servers and writes (or merges into)
`seed/agent-workdir/.mcp.json` at startup. Claude CLI auto-loads them.

Use MCP for:
- High-frequency calls during a conversation (channel history fetch, message search)
- Structured I/O where shell quoting would be brittle (Korean channel names, JSON results)
- Tools that benefit from explicit JSON Schema (Claude reasons about argument shape better)

Example: `adapter-channel-slack/mcp/` exposes `slack_resolve_channel`,
`slack_get_channel_history`, `slack_search_messages`, `slack_get_user_info`.
This is what makes the Nakbot-style "check QA reports in #other-channel"
use case work without custom code in user forks.

### 11.2 CLI tools (recommended for ops + ad-hoc)

Each adapter MAY ship CLI binaries in `<adapter-package>/bin/`. The agent invokes
them via the built-in Bash tool. CLI tools are also runnable by human operators —
that dual-purpose is the point.

Use CLI for:
- Operations also useful to humans (`agentry-slack list-channels`, `agentry migrate`, `agentry distill --session <id>`)
- One-shot or low-frequency commands
- Tools where shell composability matters (`| jq`, redirects, piping into other tools)

### 11.3 Picking between them

| Tool intent | MCP | CLI |
|---|---|---|
| Agent calls during every conversation | ✓ | |
| Operator runs from terminal | | ✓ |
| Both agent and operator | ship both, share a library inside the adapter package | |

Don't ship the same capability twice if it's not needed — pick the dominant
consumer and start there. The Slack adapter ships MCP for `slack_*` tools
(agent-driven) and CLI for `verify-scopes`, `send-test-message`, `list-channels`
(ops-driven).

### 11.4 Composition wiring

```ts
const slackChannel = new SlackInboundChannel(config.slack);
const slackMcp     = new SlackMcpServer(config.slack);  // opt-in
const slackCli     = registerSlackCli(config.slack);    // installed as bin/

const mcpServers = [slackMcp /*, ...*/].filter(s => s.enabled);
mergeAgentWorkdirMcpJson(seedDir, mcpServers);
```

The agent-workdir's existing `.mcp.json` (user customizations) is preserved during
the merge — framework-managed entries are namespaced.

---

## 12. Glossary

- **Episodic memory**: raw `Turn`s stored verbatim. Source of truth for what
  happened in conversations.
- **Semantic memory**: distilled `KnowledgeItem`s with embeddings and provenance.
  Derived from episodic memory by the distillation pipeline.
- **Procedural memory**: agent working directory contents (`CLAUDE.md`, `.claude/`,
  `.mcp.json`) — the agent's "skills" and "rules". Shipped by the framework,
  overridable per deployment.
- **Provenance**: `derivedFrom` reference on a `KnowledgeItem` that points back to
  source turns or external source refs. Required for all items.
- **Tenant**: isolation boundary. Single deployments use `'default'`. Schema
  carries `tenantId` everywhere as future-proofing.
- **NativeRef**: channel-specific opaque conversation identifier. Computed by the
  channel's `SessionPolicy.computeNativeRef`.
- **Synthetic event**: an `IncomingEvent` emitted by the channel adapter for prior
  messages it discovered after the fact (e.g., Slack thread history fetch). Marked
  `metadata.synthetic = true`; persisted as a turn but does not invoke the agent.
