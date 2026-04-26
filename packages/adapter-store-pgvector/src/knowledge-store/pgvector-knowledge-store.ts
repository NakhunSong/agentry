import type {
  EmbeddingProvider,
  ItemFilter,
  KnowledgeId,
  KnowledgeItem,
  KnowledgeItemInput,
  KnowledgeKind,
  KnowledgeStore,
  ProvenanceRef,
  RetrievalQuery,
  RetrievalResult,
  RetrievedKnowledgeItem,
  SourceId,
  SourceRefInput,
  SourceType,
  TenantId,
} from '@agentry/core';
import { canonicalHash } from '@agentry/core';
import type { Pool } from 'pg';

const LIST_PAGE_SIZE = 200;

interface SourceRow {
  id: string;
}

interface KnowledgeRow {
  id: string;
  tenant_id: string;
  external_id: string | null;
  source_type: string;
  kind: string;
  text: string;
  text_canonical_hash: string;
  // pg returns NUMERIC as string by default to avoid precision loss.
  extractor_self_rating: string;
  n_confirmations: number;
  last_referenced_at: Date;
  confidence_snapshot: string;
  derived_from_kind: 'session' | 'external';
  derived_from_session: string | null;
  derived_from_turn_lo: string | null;
  derived_from_turn_hi: string | null;
  derived_from_source: string | null;
  derived_from_locator: string | null;
  extractor_version: string;
  created_at: Date;
  updated_at: Date;
  metadata: Record<string, unknown>;
}

interface RetrievedRow extends KnowledgeRow {
  // Cosine similarity (1 - distance), surfaced via SELECT expression.
  score: string;
}

export interface PgvectorKnowledgeStoreOptions {
  readonly pool: Pool;
  readonly embeddings: EmbeddingProvider;
}

export class PgvectorKnowledgeStore implements KnowledgeStore {
  private readonly pool: Pool;
  private readonly embeddings: EmbeddingProvider;

  constructor(options: PgvectorKnowledgeStoreOptions) {
    this.pool = options.pool;
    this.embeddings = options.embeddings;
  }

  async recordSource(ref: SourceRefInput): Promise<SourceId> {
    const result = await this.pool.query<SourceRow>(
      `INSERT INTO source_refs (tenant_id, source_kind, locator, metadata)
       VALUES ($1, $2, $3, $4::jsonb)
       ON CONFLICT (tenant_id, source_kind, locator) DO UPDATE
         SET metadata = source_refs.metadata || $4::jsonb
       RETURNING id`,
      [ref.tenantId, ref.sourceKind, ref.locator, JSON.stringify(ref.metadata ?? {})],
    );
    const row = result.rows[0];
    if (!row) throw new Error('recordSource returned no row — should be unreachable');
    return row.id;
  }

  async upsertItem(item: KnowledgeItemInput): Promise<KnowledgeId> {
    const hash = canonicalHash(item.text);
    const [embedding] = await this.embeddings.embed([item.text]);
    if (!embedding) {
      throw new Error('EmbeddingProvider returned no embedding for upsertItem text');
    }
    const initialSnap = snapInitial(item.extractorSelfRating);
    const provenance = provenanceColumns(item.derivedFrom);

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO knowledge_items (
         tenant_id, external_id, source_type, kind, text, text_canonical_hash,
         embedding, extractor_self_rating, n_confirmations, last_referenced_at,
         confidence_snapshot, derived_from_kind, derived_from_session,
         derived_from_turn_lo, derived_from_turn_hi, derived_from_source,
         derived_from_locator, extractor_version, metadata
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7::vector, $8, 1, now(),
         $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb
       )
       ON CONFLICT (tenant_id, source_type, text_canonical_hash) DO UPDATE
         SET
           n_confirmations = knowledge_items.n_confirmations + 1,
           last_referenced_at = now(),
           updated_at = now(),
           confidence_snapshot = LEAST(
             1.0,
             EXCLUDED.extractor_self_rating * 0.6 +
               LEAST(0.5 + 0.1 * knowledge_items.n_confirmations, 1.0) * 0.4
           )
       RETURNING id`,
      [
        item.tenantId,
        item.externalId ?? null,
        item.sourceType,
        item.kind,
        item.text,
        hash,
        vectorToText(embedding),
        item.extractorSelfRating,
        initialSnap,
        provenance.kind,
        provenance.session,
        provenance.turnLo,
        provenance.turnHi,
        provenance.source,
        provenance.locator,
        item.extractorVersion,
        JSON.stringify(item.metadata ?? {}),
      ],
    );
    const row = result.rows[0];
    if (!row) throw new Error('upsertItem returned no row — should be unreachable');
    return row.id;
  }

  async retrieve(query: RetrievalQuery): Promise<RetrievalResult> {
    const [embedding] = await this.embeddings.embed([query.text]);
    if (!embedding) {
      throw new Error('EmbeddingProvider returned no embedding for retrieve query');
    }

    const filters = query.filters;
    const result = await this.pool.query<RetrievedRow>(
      `SELECT
         id, tenant_id, external_id, source_type, kind, text, text_canonical_hash,
         extractor_self_rating, n_confirmations, last_referenced_at, confidence_snapshot,
         derived_from_kind, derived_from_session, derived_from_turn_lo,
         derived_from_turn_hi, derived_from_source, derived_from_locator,
         extractor_version, created_at, updated_at, metadata,
         1 - (embedding <=> $1::vector) AS score
       FROM knowledge_items
       WHERE tenant_id = $2
         AND ($3::text[] IS NULL OR source_type = ANY($3::text[]))
         AND ($4::text[] IS NULL OR kind = ANY($4::text[]))
         AND ($5::numeric IS NULL OR confidence_snapshot >= $5::numeric)
       ORDER BY embedding <=> $1::vector
       LIMIT $6`,
      [
        vectorToText(embedding),
        query.tenantId,
        filters?.sourceTypes ? [...filters.sourceTypes] : null,
        filters?.kinds ? [...filters.kinds] : null,
        filters?.minConfidence ?? null,
        query.topK,
      ],
    );

    const items: RetrievedKnowledgeItem[] = result.rows.map((row) => {
      const item = mapItem(row);
      return {
        item,
        score: Number(row.score),
        // No decay applied at MVP; final == snapshot is the honest "no
        // further policy" value.
        confidenceFinal: item.confidenceSnapshot,
      };
    });

    return { items };
  }

  async deleteBySource(sourceId: SourceId): Promise<void> {
    await this.pool.query('DELETE FROM knowledge_items WHERE derived_from_source = $1', [sourceId]);
  }

  async deleteByExternalId(tenantId: TenantId, externalId: string): Promise<void> {
    // Hard-coded source_type filter prevents user-data wipes per port comment.
    await this.pool.query(
      `DELETE FROM knowledge_items
       WHERE tenant_id = $1 AND source_type = 'project_seed' AND external_id = $2`,
      [tenantId, externalId],
    );
  }

  async *listByTenant(tenantId: TenantId, filter: ItemFilter): AsyncIterable<KnowledgeItem> {
    let offset = 0;
    while (true) {
      const result = await this.pool.query<KnowledgeRow>(
        `SELECT
           id, tenant_id, external_id, source_type, kind, text, text_canonical_hash,
           extractor_self_rating, n_confirmations, last_referenced_at, confidence_snapshot,
           derived_from_kind, derived_from_session, derived_from_turn_lo,
           derived_from_turn_hi, derived_from_source, derived_from_locator,
           extractor_version, created_at, updated_at, metadata
         FROM knowledge_items
         WHERE tenant_id = $1
           AND ($2::text[] IS NULL OR source_type = ANY($2::text[]))
           AND ($3::text[] IS NULL OR kind = ANY($3::text[]))
           AND ($4::numeric IS NULL OR confidence_snapshot >= $4::numeric)
         ORDER BY id
         LIMIT $5 OFFSET $6`,
        [
          tenantId,
          filter.sourceTypes ? [...filter.sourceTypes] : null,
          filter.kinds ? [...filter.kinds] : null,
          filter.minConfidence ?? null,
          LIST_PAGE_SIZE,
          offset,
        ],
      );
      if (result.rows.length === 0) return;
      for (const row of result.rows) yield mapItem(row);
      if (result.rows.length < LIST_PAGE_SIZE) return;
      offset += LIST_PAGE_SIZE;
    }
  }
}

function snapInitial(extractorSelfRating: number): number {
  // n=1 → boost = 0.5; snap = rating*0.6 + 0.5*0.4 = rating*0.6 + 0.2.
  // Range [0.2, 0.8] for rating ∈ [0,1] — well within [0,1] clamp; LEAST
  // is defensive only.
  return Math.min(1.0, extractorSelfRating * 0.6 + 0.2);
}

function vectorToText(v: Float32Array): string {
  // pgvector's text input format: '[1.0,2.0,...]'. Cast via $N::vector at
  // call site. We avoid the pgvector-node package — reading vector columns
  // back is not needed (port doesn't surface embedding) and writes are a
  // single string concatenation.
  let s = '[';
  for (let i = 0; i < v.length; i++) {
    if (i > 0) s += ',';
    s += String(v[i]);
  }
  return `${s}]`;
}

interface ProvenanceColumns {
  readonly kind: 'session' | 'external';
  readonly session: string | null;
  readonly turnLo: string | null;
  readonly turnHi: string | null;
  readonly source: string | null;
  readonly locator: string | null;
}

function provenanceColumns(p: ProvenanceRef): ProvenanceColumns {
  if (p.kind === 'session') {
    return {
      kind: 'session',
      session: p.sessionId,
      turnLo: p.turnRange ? p.turnRange[0].toString() : null,
      turnHi: p.turnRange ? p.turnRange[1].toString() : null,
      source: null,
      locator: null,
    };
  }
  return {
    kind: 'external',
    session: null,
    turnLo: null,
    turnHi: null,
    source: p.sourceId,
    locator: p.locator,
  };
}

function mapProvenance(row: KnowledgeRow): ProvenanceRef {
  if (row.derived_from_kind === 'session') {
    const turnRange =
      row.derived_from_turn_lo !== null && row.derived_from_turn_hi !== null
        ? ([BigInt(row.derived_from_turn_lo), BigInt(row.derived_from_turn_hi)] as const)
        : null;
    return {
      kind: 'session',
      sessionId: row.derived_from_session,
      turnRange,
      // Schema doesn't carry a "lost-at" timestamp; honest null when source
      // is unknown rather than approximating with updated_at.
      provenanceLostAt: null,
    };
  }
  // external: CHECK constraint guarantees derived_from_source is NOT NULL,
  // and adapter writes locator alongside it.
  if (row.derived_from_source === null || row.derived_from_locator === null) {
    throw new Error(
      `external-provenance row ${row.id} has null derived_from_source or derived_from_locator`,
    );
  }
  return {
    kind: 'external',
    sourceId: row.derived_from_source,
    locator: row.derived_from_locator,
  };
}

function mapItem(row: KnowledgeRow): KnowledgeItem {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    ...(row.external_id !== null ? { externalId: row.external_id } : {}),
    sourceType: row.source_type as SourceType,
    kind: row.kind as KnowledgeKind,
    text: row.text,
    textCanonicalHash: row.text_canonical_hash,
    extractorSelfRating: Number(row.extractor_self_rating),
    nConfirmations: row.n_confirmations,
    lastReferencedAt: row.last_referenced_at,
    confidenceSnapshot: Number(row.confidence_snapshot),
    derivedFrom: mapProvenance(row),
    extractorVersion: row.extractor_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata,
  };
}
