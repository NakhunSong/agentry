// Text → vector embedding port. Adapters declare model + dimension; the
// composition root validates dimension against the KnowledgeStore at startup
// (mismatch is fatal — see ARCHITECTURE.md §4.6). Batching, retries, and
// rate-limit policy live in the adapter; this port is pure declaration.
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimension: number;
  embed(texts: readonly string[]): Promise<readonly Float32Array[]>;
}
