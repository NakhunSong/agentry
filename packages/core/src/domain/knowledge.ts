import type { KnowledgeId, SessionId, SourceId, TenantId } from './ids.js';

export type KnowledgeKind = 'fact' | 'decision' | 'qa_pair' | 'procedure';

export type SourceType = 'project_seed' | 'user_session' | 'external_sync';

// `sessionId` and `turnRange` may be null when the source session was deleted
// after the item was distilled — the text and embedding survive but precise
// provenance is lost. `provenanceLostAt` records when.
export type ProvenanceRef =
  | {
      readonly kind: 'session';
      readonly sessionId: SessionId | null;
      readonly turnRange: readonly [bigint, bigint] | null;
      readonly provenanceLostAt: Date | null;
    }
  | {
      readonly kind: 'external';
      readonly sourceId: SourceId;
      readonly locator: string;
    };

export interface KnowledgeItemInput {
  readonly tenantId: TenantId;
  readonly externalId?: string;
  readonly sourceType: SourceType;
  readonly kind: KnowledgeKind;
  readonly text: string;
  readonly extractorSelfRating: number;
  readonly derivedFrom: ProvenanceRef;
  readonly extractorVersion: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface KnowledgeItem extends KnowledgeItemInput {
  readonly id: KnowledgeId;
  readonly textCanonicalHash: string;
  readonly nConfirmations: number;
  readonly lastReferencedAt: Date;
  readonly confidenceSnapshot: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}
