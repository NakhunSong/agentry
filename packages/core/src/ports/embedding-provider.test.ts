import { describe, expect, it } from 'vitest';
import type { EmbeddingProvider } from './embedding-provider.js';

// Compile + runtime smoke: a minimal in-memory implementation proves the
// interface is implementable without false constraints. Concrete adapter
// (VoyageEmbeddingProvider) lands in its own package.
function buildFake(dimension: number): EmbeddingProvider {
  return {
    model: 'test-1',
    dimension,
    async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
      return texts.map((text) => {
        const v = new Float32Array(dimension);
        // Per-text hash in v[0] gives each input a distinct output, so an
        // adapter that mis-mapped Voyage's `data[].index` would fail the
        // order-preservation assertion below.
        let h = 0;
        for (let i = 0; i < text.length; i++) {
          h = (h * 31 + text.charCodeAt(i)) | 0;
        }
        v[0] = h;
        return v;
      });
    },
  };
}

describe('EmbeddingProvider port', () => {
  it('admits a minimal in-memory implementation', async () => {
    const fake = buildFake(8);

    expect(fake.model).toBe('test-1');
    expect(fake.dimension).toBe(8);

    const out = await fake.embed(['hello', 'world', 'agentry']);
    expect(out).toHaveLength(3);
    for (const vec of out) {
      expect(vec).toBeInstanceOf(Float32Array);
      expect(vec.length).toBe(8);
    }

    // Order preservation: distinct inputs produce distinct outputs at the
    // matching index. Pins the contract Voyage's `data[].index` mapping
    // depends on.
    expect(out[0]?.[0]).not.toBe(out[1]?.[0]);
    expect(out[1]?.[0]).not.toBe(out[2]?.[0]);
  });

  it('handles empty input', async () => {
    const fake = buildFake(4);
    const out = await fake.embed([]);
    expect(out).toEqual([]);
  });
});
