import { describe, expect, it } from 'vitest';
import type {
  ItemFilter,
  KnowledgeId,
  KnowledgeItem,
  KnowledgeItemInput,
  RetrievalQuery,
  RetrievalResult,
  SourceId,
  SourceRefInput,
  TenantId,
} from '../index.js';
import type { KnowledgeStore } from './knowledge-store.js';

// Compile-time smoke test: constructs a minimal in-memory implementation
// inline to prove the interface is implementable without false constraints.
// This is NOT a reusable adapter — concrete adapters land in their own
// packages.
function buildFake(): KnowledgeStore & {
  readonly seenInputs: KnowledgeItemInput[];
} {
  const seenInputs: KnowledgeItemInput[] = [];
  let sourceCounter = 0;
  let itemCounter = 0;

  return {
    seenInputs,
    async recordSource(_ref: SourceRefInput): Promise<SourceId> {
      sourceCounter += 1;
      return `source-${sourceCounter}`;
    },
    async upsertItem(item: KnowledgeItemInput): Promise<KnowledgeId> {
      seenInputs.push(item);
      itemCounter += 1;
      return `item-${itemCounter}`;
    },
    async retrieve(_query: RetrievalQuery): Promise<RetrievalResult> {
      return { items: [] };
    },
    async deleteBySource(_sourceId: SourceId): Promise<void> {
      // no-op
    },
    async deleteByExternalId(_tenantId: TenantId, _externalId: string): Promise<void> {
      // no-op
    },
    async *listByTenant(_tenantId: TenantId, _filter: ItemFilter): AsyncIterable<KnowledgeItem> {
      // empty
    },
  };
}

describe('KnowledgeStore port', () => {
  it('admits a minimal in-memory implementation', async () => {
    const store = buildFake();

    const sourceId = await store.recordSource({
      tenantId: 'default',
      sourceKind: 'manual',
      locator: 'inline-fixture',
    });
    expect(sourceId).toBe('source-1');

    const itemId = await store.upsertItem({
      tenantId: 'default',
      sourceType: 'user_session',
      kind: 'fact',
      text: 'agentry is a pluggable Claude agent framework',
      extractorSelfRating: 0.7,
      derivedFrom: {
        kind: 'session',
        sessionId: 'sess-1',
        turnRange: [1n, 3n],
        provenanceLostAt: null,
      },
      extractorVersion: 'test-extractor-0',
    });
    expect(itemId).toBe('item-1');
    expect(store.seenInputs[0]?.text).toMatch(/agentry/);

    const result = await store.retrieve({
      text: 'agentry',
      tenantId: 'default',
      mode: 'semantic',
      topK: 5,
    });
    expect(result.items).toEqual([]);

    await store.deleteBySource(sourceId);
    await store.deleteByExternalId('default', 'seed-1');

    const collected: KnowledgeItem[] = [];
    for await (const item of store.listByTenant('default', {})) {
      collected.push(item);
    }
    expect(collected).toEqual([]);
  });

  it('admits external-derived items', async () => {
    const store = buildFake();
    const itemId = await store.upsertItem({
      tenantId: 'default',
      sourceType: 'project_seed',
      kind: 'procedure',
      text: 'how to bootstrap the workspace',
      extractorSelfRating: 0.9,
      derivedFrom: {
        kind: 'external',
        sourceId: 'source-1',
        locator: 'docs/bootstrap.md',
      },
      extractorVersion: 'test-extractor-0',
      externalId: 'seed-bootstrap',
    });
    expect(itemId).toBe('item-1');
  });
});
