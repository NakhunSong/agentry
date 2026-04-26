import type { KnowledgeId, SourceId, TenantId } from '../domain/ids.js';
import type { KnowledgeItem, KnowledgeItemInput } from '../domain/knowledge.js';
import type { ItemFilter, RetrievalQuery, RetrievalResult } from '../domain/retrieval.js';
import type { SourceRefInput } from '../domain/source.js';

// Three-layer memory store: relational (provenance) + vector (semantic).
// `searchRelational` is a Phase 2+ opt-in for graph-augmented adapters; not
// yet declared here because the GraphQuery type lands with the graph adapter.
export interface KnowledgeStore {
  recordSource(ref: SourceRefInput): Promise<SourceId>;
  upsertItem(item: KnowledgeItemInput): Promise<KnowledgeId>;
  retrieve(query: RetrievalQuery): Promise<RetrievalResult>;
  deleteBySource(sourceId: SourceId): Promise<void>;
  // Filters internally to source_type='project_seed' so calling with a
  // user-data externalId can't wipe distilled session knowledge.
  deleteByExternalId(tenantId: TenantId, externalId: string): Promise<void>;
  listByTenant(tenantId: TenantId, filter: ItemFilter): AsyncIterable<KnowledgeItem>;
}
