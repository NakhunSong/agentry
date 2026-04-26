import type { EmbeddingProvider } from '@agentry/core';

export type VoyageModel = 'voyage-3.5';

const MODEL_DIMENSIONS: Record<VoyageModel, number> = {
  'voyage-3.5': 1024,
};

const VOYAGE_ENDPOINT = 'https://api.voyageai.com/v1/embeddings';
const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_BATCH_SIZE = 128;
const RETRY_AFTER_CAP_MS = 30_000;

export interface VoyageEmbeddingProviderOptions {
  readonly apiKey: string;
  readonly model?: VoyageModel;
  readonly fetch?: typeof globalThis.fetch;
  readonly maxRetries?: number;
  readonly batchSize?: number;
}

interface VoyageResponseItem {
  readonly embedding: readonly number[];
  readonly index: number;
}

interface VoyageResponse {
  readonly data: readonly VoyageResponseItem[];
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  readonly model: VoyageModel;
  readonly dimension: number;

  private readonly apiKey: string;
  private readonly fetchFn: typeof globalThis.fetch;
  private readonly maxRetries: number;
  private readonly batchSize: number;

  constructor(options: VoyageEmbeddingProviderOptions) {
    this.model = options.model ?? 'voyage-3.5';
    this.dimension = MODEL_DIMENSIONS[this.model];
    this.apiKey = options.apiKey;
    this.fetchFn = options.fetch ?? globalThis.fetch;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE;
  }

  async embed(texts: readonly string[]): Promise<readonly Float32Array[]> {
    if (texts.length === 0) return [];

    const results: Float32Array[] = new Array(texts.length);
    for (let start = 0; start < texts.length; start += this.batchSize) {
      const batch = texts.slice(start, start + this.batchSize);
      const batchResult = await this.embedBatch(batch);
      for (let i = 0; i < batchResult.length; i++) {
        const vec = batchResult[i];
        if (vec === undefined) {
          throw new Error(
            `Voyage API returned ${batchResult.length} embeddings for ${batch.length} inputs at batch starting ${start}`,
          );
        }
        results[start + i] = vec;
      }
    }
    return results;
  }

  private async embedBatch(texts: readonly string[]): Promise<Float32Array[]> {
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      const isLastAttempt = attempt === this.maxRetries - 1;

      let response: Response;
      try {
        response = await this.fetchFn(VOYAGE_ENDPOINT, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ input: texts, model: this.model }),
        });
      } catch (err) {
        if (isLastAttempt) throw err;
        await sleep(exponentialBackoffMs(attempt));
        continue;
      }

      if (response.ok) {
        const json = (await response.json()) as VoyageResponse;
        // Voyage's contract says `index` matches input order, but sort defensively
        // — the EmbeddingProvider port (#44) pins order preservation, and the
        // cost is O(n log n) on a small batch.
        const sorted = [...json.data].sort((a, b) => a.index - b.index);
        if (sorted.length !== texts.length) {
          throw new Error(
            `Voyage API returned ${sorted.length} embeddings for ${texts.length} inputs`,
          );
        }
        return sorted.map((item) => Float32Array.from(item.embedding));
      }

      const retryable = response.status === 429 || response.status >= 500;
      if (retryable && !isLastAttempt) {
        const waitMs =
          response.status === 429
            ? (parseRetryAfter(response.headers.get('retry-after')) ??
              exponentialBackoffMs(attempt))
            : exponentialBackoffMs(attempt);
        await sleep(waitMs);
        continue;
      }

      // Body may contain useful diagnostics (e.g. token-limit-exceeded), but
      // never includes the apiKey since we never echo it back.
      const body = await response.text().catch(() => '');
      throw new Error(`Voyage API ${response.status}: ${body}`);
    }
    // Loop either returns or throws on every iteration; this is unreachable.
    throw new Error('embedBatch retry loop exited unexpectedly');
  }
}

function exponentialBackoffMs(attempt: number): number {
  return 2 ** attempt * 200;
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, RETRY_AFTER_CAP_MS);
  }
  // HTTP-date form per RFC 7231.
  const dateMs = Date.parse(header);
  if (Number.isFinite(dateMs)) {
    const delta = dateMs - Date.now();
    if (delta > 0) return Math.min(delta, RETRY_AFTER_CAP_MS);
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
