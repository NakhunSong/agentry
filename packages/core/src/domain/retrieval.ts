import type { TenantId } from './ids.js';
import type { KnowledgeItem, KnowledgeKind, SourceType } from './knowledge.js';

export type RetrievalMode = 'semantic' | 'hybrid' | 'relational';

export interface ItemFilter {
  readonly sourceTypes?: readonly SourceType[];
  readonly kinds?: readonly KnowledgeKind[];
  readonly minConfidence?: number;
}

export interface RetrievalQuery {
  readonly text: string;
  readonly tenantId: TenantId;
  readonly mode: RetrievalMode;
  readonly topK: number;
  readonly filters?: ItemFilter;
  // Multiplies confidence_snapshot by exp(-days_since_last_referenced / 90)
  // so curators can surface recently-referenced items. MVP retrieval defaults
  // to the snapshot only.
  readonly applyRecencyDecay?: boolean;
}

export interface RetrievedKnowledgeItem {
  readonly item: KnowledgeItem;
  readonly score: number;
  readonly confidenceFinal?: number;
  readonly lowConfidence?: boolean;
}

export interface RetrievalResult {
  readonly items: readonly RetrievedKnowledgeItem[];
}
