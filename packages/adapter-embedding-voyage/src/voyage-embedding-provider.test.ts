import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoyageEmbeddingProvider } from './voyage-embedding-provider.js';

interface VoyageDataItem {
  embedding: number[];
  index: number;
}

function okResponse(data: VoyageDataItem[]): Response {
  return new Response(
    JSON.stringify({ object: 'list', data, model: 'voyage-3.5', usage: { total_tokens: 1 } }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function errorResponse(
  status: number,
  body = 'error',
  headers: Record<string, string> = {},
): Response {
  return new Response(body, { status, headers });
}

function makeEmbedding(value: number, dim = 1024): number[] {
  return Array.from({ length: dim }, () => value);
}

describe('VoyageEmbeddingProvider', () => {
  describe('constructor + declarative properties', () => {
    it('declares model and dimension for voyage-3.5 default', () => {
      const provider = new VoyageEmbeddingProvider({ apiKey: 'k' });
      expect(provider.model).toBe('voyage-3.5');
      expect(provider.dimension).toBe(1024);
    });
  });

  describe('embed (single batch)', () => {
    it('returns Float32Array[] with correct dimension and order', async () => {
      const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        okResponse([
          { index: 0, embedding: makeEmbedding(0.1) },
          { index: 1, embedding: makeEmbedding(0.2) },
        ]),
      );
      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });

      const out = await provider.embed(['hello', 'world']);

      expect(out).toHaveLength(2);
      expect(out[0]).toBeInstanceOf(Float32Array);
      expect(out[0]?.length).toBe(1024);
      expect(out[0]?.[0]).toBeCloseTo(0.1);
      expect(out[1]?.[0]).toBeCloseTo(0.2);

      expect(fetchMock).toHaveBeenCalledOnce();
      const [url, init] = fetchMock.mock.calls[0] ?? [];
      expect(url).toBe('https://api.voyageai.com/v1/embeddings');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer k');
      expect(JSON.parse(String(init?.body))).toEqual({
        input: ['hello', 'world'],
        model: 'voyage-3.5',
      });
    });

    it('sorts response by index defensively', async () => {
      const fetchMock = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        okResponse([
          { index: 1, embedding: makeEmbedding(0.2) },
          { index: 0, embedding: makeEmbedding(0.1) },
        ]),
      );
      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });

      const out = await provider.embed(['a', 'b']);

      expect(out[0]?.[0]).toBeCloseTo(0.1);
      expect(out[1]?.[0]).toBeCloseTo(0.2);
    });

    it('returns [] for empty input without calling fetch', async () => {
      const fetchMock = vi.fn<typeof globalThis.fetch>();
      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });

      const out = await provider.embed([]);

      expect(out).toEqual([]);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('throws if response item count mismatches input count', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(okResponse([{ index: 0, embedding: makeEmbedding(0.1) }]));
      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });

      await expect(provider.embed(['a', 'b'])).rejects.toThrow(/1 embeddings for 2 inputs/);
    });
  });

  describe('embed (multi-batch)', () => {
    it('splits at batchSize and concatenates in input order', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(
          okResponse([
            { index: 0, embedding: makeEmbedding(1) },
            { index: 1, embedding: makeEmbedding(2) },
          ]),
        )
        .mockResolvedValueOnce(
          okResponse([
            { index: 0, embedding: makeEmbedding(3) },
            { index: 1, embedding: makeEmbedding(4) },
          ]),
        )
        .mockResolvedValueOnce(okResponse([{ index: 0, embedding: makeEmbedding(5) }]));

      const provider = new VoyageEmbeddingProvider({
        apiKey: 'k',
        fetch: fetchMock,
        batchSize: 2,
      });

      const out = await provider.embed(['a', 'b', 'c', 'd', 'e']);

      expect(out.map((v) => v[0])).toEqual([1, 2, 3, 4, 5]);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });
  });

  describe('retry behavior', () => {
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['setTimeout'] });
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it('retries on 429 and succeeds', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(errorResponse(429, 'rate limited'))
        .mockResolvedValueOnce(okResponse([{ index: 0, embedding: makeEmbedding(0.1) }]));

      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });
      const promise = provider.embed(['hi']);
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(out).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retries on 500 and succeeds', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(errorResponse(500))
        .mockResolvedValueOnce(errorResponse(503))
        .mockResolvedValueOnce(okResponse([{ index: 0, embedding: makeEmbedding(0.1) }]));

      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });
      const promise = provider.embed(['hi']);
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(out).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('throws after exhausting retries on 429', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(errorResponse(429, 'still rate limited'));

      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });
      const promise = provider.embed(['hi']);
      const expectation = expect(promise).rejects.toThrow(/429/);
      await vi.runAllTimersAsync();
      await expectation;

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('does not retry on 4xx other than 429', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValue(errorResponse(401, 'unauthorized'));

      const provider = new VoyageEmbeddingProvider({ apiKey: 'bad', fetch: fetchMock });

      await expect(provider.embed(['hi'])).rejects.toThrow(/401/);
      expect(fetchMock).toHaveBeenCalledOnce();
    });

    it('retries on network error', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockRejectedValueOnce(new Error('ECONNRESET'))
        .mockResolvedValueOnce(okResponse([{ index: 0, embedding: makeEmbedding(0.1) }]));

      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });
      const promise = provider.embed(['hi']);
      await vi.runAllTimersAsync();
      const out = await promise;

      expect(out).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('throws original error after exhausting retries on network error', async () => {
      const fetchMock = vi.fn<typeof globalThis.fetch>().mockRejectedValue(new Error('ECONNRESET'));

      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });
      const promise = provider.embed(['hi']);
      const expectation = expect(promise).rejects.toThrow('ECONNRESET');
      await vi.runAllTimersAsync();
      await expectation;

      expect(fetchMock).toHaveBeenCalledTimes(3);
    });

    it('honors Retry-After header (seconds) on 429', async () => {
      const fetchMock = vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(errorResponse(429, 'rate limited', { 'Retry-After': '5' }))
        .mockResolvedValueOnce(okResponse([{ index: 0, embedding: makeEmbedding(0.1) }]));

      const provider = new VoyageEmbeddingProvider({ apiKey: 'k', fetch: fetchMock });
      const promise = provider.embed(['hi']);

      // After the first response, the adapter sleeps 5000ms (Retry-After), not
      // the 200ms exponential default. Advance by 200ms first — the second
      // fetch must NOT have fired yet.
      await vi.advanceTimersByTimeAsync(200);
      expect(fetchMock).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(5000);
      const out = await promise;
      expect(out).toHaveLength(1);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });
  });
});
