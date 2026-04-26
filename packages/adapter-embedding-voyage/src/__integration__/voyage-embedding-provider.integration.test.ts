import { describe, expect, it } from 'vitest';
import { VoyageEmbeddingProvider } from '../voyage-embedding-provider.js';

const integration = process.env.INTEGRATION === '1';
const apiKey = process.env.VOYAGE_API_KEY;

describe.skipIf(!integration || !apiKey)('VoyageEmbeddingProvider (real API)', () => {
  it('returns Float32Array of declared dimension for voyage-3.5', async () => {
    const provider = new VoyageEmbeddingProvider({ apiKey: apiKey ?? '' });

    const out = await provider.embed(['hello agentry']);

    expect(out).toHaveLength(1);
    expect(out[0]).toBeInstanceOf(Float32Array);
    expect(out[0]?.length).toBe(provider.dimension);
  }, 30_000);

  it('preserves order across multiple inputs', async () => {
    const provider = new VoyageEmbeddingProvider({ apiKey: apiKey ?? '' });

    const out = await provider.embed(['cat', 'dog', 'bird']);

    expect(out).toHaveLength(3);
    // Distinct inputs should produce distinct vectors.
    expect(out[0]?.[0]).not.toBe(out[1]?.[0]);
    expect(out[1]?.[0]).not.toBe(out[2]?.[0]);
  }, 30_000);
});
