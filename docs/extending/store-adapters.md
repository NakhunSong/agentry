# Store adapters

agentry persists two domain concepts: **sessions/turns** (episodic memory)
and **knowledge items** (semantic memory). The default —
`PgvectorSessionStore` + `PgvectorKnowledgeStore` in
`packages/adapter-store-pgvector` — uses Postgres + pgvector. This guide
covers the contract for swapping in another backend (SQLite + sqlite-vss,
DuckDB, Qdrant + Postgres, an external vector DB, etc.).

> **Recommendation up front**: don't swap unless you have a concrete
> driver. pgvector + Postgres covers the MVP slice with one container, no
> separate vector service, ACID guarantees on session writes, and a
> migration path that already ships. The "split vector + relational"
> patterns are higher operational cost without compensating wins until
> you're at scale or have a hard deployment constraint.

## Two ports, separate decisions

**Session store** is operationally hot (every turn writes; every mention
reads-or-creates). **Knowledge store** is operationally rare (ingestion
+ retrieval). Splitting backends per port is sometimes the right call
(e.g., Postgres for sessions, Qdrant for knowledge); the framework treats
them independently.

## SessionStore

```ts
interface SessionStore {
  findOrCreate(channelKind, channelNativeRef, tenantId): Promise<Session>;
  findByRef(channelKind, channelNativeRef, tenantId): Promise<Session | null>;
  recordTurn(sessionId, turn: TurnInput): Promise<Turn>;
  getRecentTurns(sessionId, limit): Promise<readonly Turn[]>;
  updateStatus(sessionId, status: SessionStatus): Promise<void>;
  setMetadata(sessionId, patch: Readonly<Record<string, unknown>>): Promise<void>;
  listSessionsForDistillation(criteria): Promise<readonly SessionId[]>;
}
```

### Load-bearing semantics

- **`findOrCreate` is UPSERT.** Atomic; concurrent calls for the same
  `(channelKind, ref, tenantId)` resolve to the same session id. Pgvector
  uses `INSERT ... ON CONFLICT DO UPDATE RETURNING *`. SQLite needs
  `INSERT OR IGNORE` + a follow-up `SELECT`; document that fact in your
  adapter so reviewers know the two-statement window is intentional.
- **`findByRef` is read-only.** Lifted in PR #70 for ack-path hot loops:
  the Slack `SessionFirstTouch` impl checks "is this session already
  backfilled?" without an UPSERT roundtrip. Implementations MUST NOT
  bump `last_active_at` or any other side-effect column. Pgvector
  integration test asserts this with a before/after comparison; the
  same test pattern catches drift in any backend.
- **`recordTurn` returns the persisted `Turn`** including `seqNo` (server-
  assigned monotonically per session) and `createdAt`. Don't compute
  `seqNo` in the adapter caller; it's a server-side concern with
  concurrency implications (pgvector uses `RETURNING seq_no` from a
  stored `nextval` per session).
- **`setMetadata` is a shallow merge.** Pgvector implements it with
  PostgreSQL's `||` operator on `JSONB`. A nested `slack: { backfilled:
  true }` write would clobber sibling `slack.*` keys — that's why the
  Slack adapter uses flat-prefixed keys like `slackBackfilled` (see
  ARCHITECTURE.md §4.3 + the `SLACK_BACKFILLED_METADATA_KEY` constant).
  If your backend can do an atomic deeper merge cheaply, document the
  upgrade — the use case will benefit from a per-key conditional update
  someday.
- **`listSessionsForDistillation`** powers the Phase 2 distillation
  trigger; criteria-driven, returns ids only (the distillation
  pipeline batches the actual reads). MVP can return `[]` if you're
  not running distillation yet — the use case handles empty gracefully.

### Session/turn data model

See `packages/core/src/domain/session.ts` for the canonical types. Notes
the schema must enforce:

- `(tenantId, channelKind, channelNativeRef)` is unique per session.
- Turns belong to a session via `sessionId`; `seqNo` is dense and
  per-session monotonic (not global).
- `metadata` and `participants` are JSONB-shaped — adapters store opaque
  blobs.
- `distilledThroughSeqNo` is `bigint` — needed because long-lived
  sessions can exceed `int32` over years.

## KnowledgeStore

```ts
interface KnowledgeStore {
  recordSource(ref: SourceRefInput): Promise<SourceId>;
  upsertItem(item: KnowledgeItemInput): Promise<KnowledgeId>;
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
  deleteBySource(sourceId: SourceId): Promise<void>;
  deleteByExternalId(tenantId: TenantId, externalId: string): Promise<void>;
  listByTenant(tenantId: TenantId, filter: ItemFilter): AsyncIterable<KnowledgeItem>;
}
```

### Load-bearing semantics

- **`upsertItem` is dedup-aware.** Pgvector uses
  `UNIQUE(tenant_id, external_id)` for source-derived items and a
  canonical-hash check for distilled items. Adapters MUST honor the
  uniqueness contract — a duplicate write should update, not insert.
  The schema (`packages/adapter-store-pgvector/src/migrate/0001_init.sql`)
  is the spec.
- **`retrieve` accepts a `RetrievalQuery`** with `text` (the embedding
  query string), `tenantId`, `mode: 'semantic' | 'hybrid' | 'relational'`,
  `topK`, optional `filters`, and optional `applyRecencyDecay`. The
  adapter handles the embedding (it owns the `EmbeddingProvider`
  reference) and the vector search. `'hybrid'` and `'relational'` modes
  are reserved for Phase 2+ graph-augmented adapters — a `'semantic'`-only
  adapter is the MVP minimum (throw on the other modes with a
  descriptive error until your adapter implements them).
- **`listByTenant` is `AsyncIterable`.** Streaming on purpose — knowledge
  bases can outgrow memory. Pgvector returns server-side cursor results
  page by page; an in-memory or smaller-scale adapter can `yield* arr`
  but the consumer code shouldn't have to change.
- **`deleteByExternalId` filters by `source_type='project_seed'`
  internally** — defense-in-depth against an `external_id` collision
  across source types under future schema relaxation. Honor the same
  filter even if your schema makes the collision impossible today.

### Dimension consistency

The knowledge store and the embedding provider must agree on vector
dimension. Pgvector validates this once at composition time (the column
type carries it). Other backends (Qdrant collections, FAISS indexes)
typically validate per-write — fail fast at startup by throwing from
the store constructor when its declared dimension and
`embeddingProvider.dimension` disagree, rather than letting writes
silently fail later.

See `docs/extending/embedding-provider.md` for the EMBEDDING_DIM
operational story.

## Migrations

Pgvector ships its schema as numbered SQL files
(`migrate/0001_init.sql`) plus a `runMigrations` runner that records
applied filenames in `_agentry_migrations`. The CLI (`apps/cli`)
exposes this as `agentry migrate`. Reapplying a migration is a no-op.

If you implement an alternative store, ship a migrator with the same
shape — file-per-migration, idempotent runner, recorded in a tracking
table. The smoke recipe (`docs/recipes/smoke-test.md`) calls one
command and your adapter has to match.

## Wiring

Already done in `compose.ts`:

```ts
const sessionStore = new PgvectorSessionStore(pool);
const knowledgeStore = new PgvectorKnowledgeStore({
  pool,
  embeddings: embeddingProvider,
});
```

To swap stores: fork compose, substitute the constructors, update the
migrator entry point. There's no per-deployment slot — store choice is
runtime-wide.

## Integration test recipe

Pgvector ships an `__integration__/` suite that spins up a test database
and exercises the contract end-to-end:

- `findOrCreate` is atomic under concurrent calls.
- `findByRef` returns null on miss + doesn't touch `last_active_at`.
- `recordTurn` produces dense per-session `seqNo`s.
- `setMetadata` merges shallowly (and which keys collide).
- `upsertItem` updates on duplicate `external_id`.
- `retrieve` ranks by cosine similarity (or whatever your backend uses)
  and respects `tenantId` isolation.

When implementing a new store, mirror this suite. Contract conformance
is a per-backend matter — use the suite as a checklist + safety net.

## Common gotchas

- **`tenantId` isolation.** Every read MUST filter by `tenantId`.
  Multi-tenant deployments rely on this for data isolation; the use
  case passes it through every call but the adapter is the enforcer.
  pgvector tests assert cross-tenant returns empty — copy the assertion.
- **`bigint` for `seqNo` and `distilledThroughSeqNo`.** TS `number`
  doesn't fit. Pgvector returns `bigint` from `pg`; SQLite needs
  manual conversion. Don't downcast.
- **Connection pool lifecycle.** Pgvector's `pool.end()` is called
  during `shutdown()` AFTER `jobRunner.drain()` — running jobs may
  still need pool access to record their final turns. If your store
  has the same separation, make the same call ordering explicit in
  your shutdown sequence.
- **`AsyncIterable` cleanup.** `listByTenant` consumers may abandon the
  iterator early (early `return` from a `for await`). Implementations
  must handle the implicit `return()` call and release server-side
  resources (cursors, connections). Pgvector uses `try/finally` around
  the cursor.
