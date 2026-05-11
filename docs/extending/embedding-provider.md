# Embedding provider

An embedding provider turns text into vectors. The default —
`VoyageEmbeddingProvider` in `packages/adapter-embedding-voyage` — calls
the Voyage API; this guide covers the contract for swapping in OpenAI,
Cohere, a self-hosted model, etc.

## Contract

```ts
interface EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}
```

The port is small on purpose. Three constraints worth internalizing:

- **`dimension` is declared, not inferred.** The composition root reads
  it at startup and the `KnowledgeStore` checks it against the actual
  pgvector column dimension. A mismatch is fatal — see the EMBEDDING_DIM
  gotcha below.
- **Output preserves input order.** `embed(['a', 'b'])[0]` is the vector
  for `'a'`. Adapters that batch internally must reassemble.
- **Empty input is allowed**, returns `[]`. Adapters that error on empty
  request bodies (some APIs do) should short-circuit.

Batching, retries, and rate-limit policy belong inside the adapter — the
port is pure declaration.

## Reference: `VoyageEmbeddingProvider`

```ts
const embeddings = new VoyageEmbeddingProvider({
  apiKey: secrets.VOYAGE_API_KEY,
  model: 'voyage-3.5',     // optional; default 'voyage-3.5'
  batchSize: 128,          // optional
  maxRetries: 3,           // optional
});
```

Patterns worth copying:

- **Model → dimension as a static map.**
  ```ts
  const MODEL_DIMENSIONS: Record<VoyageModel, number> = {
    'voyage-3.5': 1024,
  };
  ```
  No per-call lookup against an API; the dimension is a compile-time
  fact for each model. Adding `voyage-3-large` is a one-line table edit
  plus widening the `VoyageModel` union.
- **`fetch` constructor seam.**
  ```ts
  this.fetchFn = options.fetch ?? globalThis.fetch;
  ```
  Tests pass a `vi.fn()` that returns canned responses; production uses
  the global fetch. No HTTP mocking framework needed.
- **Batching via slicing**, not request multiplexing. Voyage's API
  accepts up to N inputs per request — the adapter slices the input
  array and concatenates results back in order.
- **Retry-After respected, capped at 30s.** A misconfigured server
  returning `Retry-After: 86400` should not pause your bot for a day.
  Cap it at a sane upper bound.

## Wiring

Already done in `compose.ts`:

```ts
const embeddingProvider = new VoyageEmbeddingProvider({
  apiKey: secrets.VOYAGE_API_KEY,
  ...(args.fetch !== undefined ? { fetch: args.fetch } : {}),
});
```

Swapping providers means substituting this constructor — typically by
forking compose or building a parallel runtime. There's no per-channel
or per-deployment slot for embedding providers; the choice is one per
runtime.

## EMBEDDING_DIM ↔ Postgres column dimension

The single most common operational pitfall. Pgvector columns are
declared with a fixed dimension at migration time:

```sql
ALTER TABLE knowledge_items ADD COLUMN embedding vector(1024);
```

If the embedding provider ships vectors of a different size, every
`KnowledgeStore.upsertItem` call fails with `expected 1024 dimensions,
not N`.

The migrator reads `EMBEDDING_DIM` from env at apply time and bakes it
into the column:

```bash
EMBEDDING_DIM=1024 \
POSTGRES_URL=postgres://... \
node apps/cli/dist/main.js migrate
```

When swapping providers (e.g., switching from `voyage-3.5` (1024) to
`text-embedding-3-large` (3072)):

1. **Drop and recreate the volume** if you can: `docker compose down -v`.
   The migrator runs from scratch with the new dim.
2. **Otherwise** add a migration that does `ALTER COLUMN embedding TYPE
   vector(NEW_DIM) USING NULL` + clears the data. There's no in-place
   resize that preserves vectors — the embedding space is different.

Document the chosen dim in your fork's README so operators don't
discover it via a runtime crash.

## Testing

The Voyage adapter ships two test surfaces:

- `voyage-embedding-provider.test.ts` — unit tests with `fetch` injection
  for batching, retry-after honoring, error-shape parsing, dimension
  consistency.
- `__integration__/` — live-API tests that hit voyageai.com when
  `VOYAGE_API_KEY` is set in env. Skipped in CI; run on demand to verify
  the API contract hasn't drifted.

When implementing your own provider, mirror this split. The unit suite
catches API shape changes during refactors; the integration suite
catches the API itself drifting (which has happened — historically
Voyage renamed `voyage-3` to `voyage-3.5`).

## Common gotchas

- **Returning `number[]` instead of `Float32Array`.** The pgvector
  driver does the right thing with both, but the contract is
  `Float32Array` and stricter consumers (e.g., a future
  `VectorStoreDirectIngest`) will assume it. `Float32Array.from(arr)`
  is the conversion.
- **Throwing on empty input.** Some APIs reject `inputs: []` with a
  400. The port contract requires `embed([])` to return `[]`; handle
  the empty case before constructing the request.
- **Forgetting `dimension`.** It's a `readonly` property, easy to
  forget in a class skeleton. The `KnowledgeStore` startup check will
  catch it (NaN vs the column dim) but the error message is opaque —
  worth declaring up front.
- **Token-budget drift.** Voyage charges per-token, per-model. Tests
  with real API calls cost real money; gate them on `VOYAGE_API_KEY`
  presence, not on a `--integration` flag, so a CI job that
  accidentally sets the key doesn't drain credit.
