import type { KnowledgeItemInput } from '@agentry/core';
import { describe, expect, it } from 'vitest';
import { InMemoryKnowledgeStore } from './in-memory-knowledge-store.js';

function input(text: string, tenantId = 'tenant-1'): KnowledgeItemInput {
  return {
    tenantId,
    sourceType: 'user_session',
    kind: 'fact',
    text,
    extractorSelfRating: 0.8,
    derivedFrom: {
      kind: 'session',
      sessionId: 'session-1',
      turnRange: [1n, 2n],
      provenanceLostAt: null,
    },
    extractorVersion: 'test-1',
  };
}

describe('InMemoryKnowledgeStore', () => {
  it('upserts new items and bumps confirmations on duplicate', async () => {
    const store = new InMemoryKnowledgeStore();
    const id1 = await store.upsertItem(input('Hello world'));
    const id2 = await store.upsertItem(input('hello world'));
    expect(id1).toBe(id2);
  });

  it('retrieves items matching the query text by substring (canonicalized)', async () => {
    const store = new InMemoryKnowledgeStore();
    await store.upsertItem(input('Slack thread is the session unit'));
    await store.upsertItem(input('Voyage embeddings default to voyage-3.5'));
    const result = await store.retrieve({
      text: 'voyage',
      tenantId: 'tenant-1',
      mode: 'semantic',
      topK: 5,
    });
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.item.text).toContain('Voyage');
  });

  it('respects tenant isolation', async () => {
    const store = new InMemoryKnowledgeStore();
    await store.upsertItem(input('tenant-1 secret', 'tenant-1'));
    const result = await store.retrieve({
      text: 'secret',
      tenantId: 'tenant-2',
      mode: 'semantic',
      topK: 5,
    });
    expect(result.items).toHaveLength(0);
  });

  it('returns empty when query is empty', async () => {
    const store = new InMemoryKnowledgeStore();
    await store.upsertItem(input('anything'));
    const result = await store.retrieve({
      text: '',
      tenantId: 'tenant-1',
      mode: 'semantic',
      topK: 5,
    });
    expect(result.items).toHaveLength(0);
  });
});
