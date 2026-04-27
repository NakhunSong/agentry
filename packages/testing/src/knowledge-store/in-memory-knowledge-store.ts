import type {
  ItemFilter,
  KnowledgeId,
  KnowledgeItem,
  KnowledgeItemInput,
  KnowledgeStore,
  RetrievalQuery,
  RetrievalResult,
  RetrievedKnowledgeItem,
  SourceId,
  SourceRefInput,
  TenantId,
} from '@agentry/core';
import { canonicalize } from '@agentry/core';

// In-memory store keeps `textCanonicalHash` set to the canonicalized text
// itself (the field is `string`-typed, no contract on format). That lets
// `retrieve` substring-match without recomputing canonicalize per item.
export class InMemoryKnowledgeStore implements KnowledgeStore {
  private readonly items = new Map<KnowledgeId, KnowledgeItem>();
  private readonly sources = new Map<SourceId, SourceRefInput>();
  private idSeq = 0;
  private sourceSeq = 0;

  async recordSource(ref: SourceRefInput): Promise<SourceId> {
    this.sourceSeq += 1;
    const id: SourceId = `source-${this.sourceSeq}`;
    this.sources.set(id, ref);
    return id;
  }

  async upsertItem(input: KnowledgeItemInput): Promise<KnowledgeId> {
    const canonical = canonicalize(input.text);
    for (const [id, existing] of this.items) {
      if (existing.tenantId === input.tenantId && existing.textCanonicalHash === canonical) {
        const now = new Date();
        this.items.set(id, {
          ...existing,
          nConfirmations: existing.nConfirmations + 1,
          lastReferencedAt: now,
          updatedAt: now,
        });
        return id;
      }
    }
    this.idSeq += 1;
    const id: KnowledgeId = `knowledge-${this.idSeq}`;
    const now = new Date();
    const created: KnowledgeItem = {
      ...input,
      id,
      textCanonicalHash: canonical,
      nConfirmations: 1,
      lastReferencedAt: now,
      confidenceSnapshot: input.extractorSelfRating,
      createdAt: now,
      updatedAt: now,
    };
    this.items.set(id, created);
    return id;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const lowered = canonicalize(query.text);
    if (lowered.length === 0) return { items: [] };
    const results: RetrievedKnowledgeItem[] = [];
    for (const item of this.items.values()) {
      if (!this.matchesFilter(item, query.tenantId, query.filters)) continue;
      const itemText = item.textCanonicalHash;
      if (!itemText.includes(lowered) && !lowered.includes(itemText)) continue;
      results.push({ item, score: 0.5, confidenceFinal: item.confidenceSnapshot });
    }
    results.sort((a, b) => (b.confidenceFinal ?? 0) - (a.confidenceFinal ?? 0));
    return { items: results.slice(0, query.topK) };
  }

  async deleteBySource(sourceId: SourceId): Promise<void> {
    this.sources.delete(sourceId);
    for (const [id, item] of this.items) {
      if (item.derivedFrom.kind === 'external' && item.derivedFrom.sourceId === sourceId) {
        this.items.delete(id);
      }
    }
  }

  async deleteByExternalId(tenantId: TenantId, externalId: string): Promise<void> {
    for (const [id, item] of this.items) {
      if (item.sourceType !== 'project_seed') continue;
      if (item.tenantId !== tenantId) continue;
      if (item.externalId !== externalId) continue;
      this.items.delete(id);
    }
  }

  async *listByTenant(tenantId: TenantId, filter: ItemFilter): AsyncIterable<KnowledgeItem> {
    for (const item of this.items.values()) {
      if (this.matchesFilter(item, tenantId, filter)) yield item;
    }
  }

  private matchesFilter(item: KnowledgeItem, tenantId: TenantId, filter?: ItemFilter): boolean {
    if (item.tenantId !== tenantId) return false;
    if (filter?.sourceTypes && !filter.sourceTypes.includes(item.sourceType)) return false;
    if (filter?.kinds && !filter.kinds.includes(item.kind)) return false;
    if (filter?.minConfidence !== undefined && item.confidenceSnapshot < filter.minConfidence) {
      return false;
    }
    return true;
  }
}
