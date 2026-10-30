import { OpenRouterEmbeddingService } from './openrouter-embedding-service.js';
import type {
  BatchingEmbeddingProvider,
  EmbeddingBatch,
  EmbeddingProvider,
  StoryEmbedding,
} from '../domain/embedding.js';

/**
 * Tries several OpenRouter credentials in order and rotates past any that fail.
 *
 * A free account is rate limited, so a call that comes back refused — a timeout,
 * a network error, a 4xx or 5xx — means this credential cannot answer right now.
 * The next account is tried on the same call. A call that answers but carries no
 * usable vector is not a credential failure: the model simply had nothing to say,
 * and rotating would not change that, so that answer is returned as-is.
 *
 * The service last used stays first in line until it fails, so a healthy key is
 * used until it stops answering, and a dead key is skipped without waiting for a
 * cooldown. When every credential fails on one call, the position advances so the
 * next call starts from a different place rather than hammering the same dead key.
 *
 * Every refused call is counted in `usage.requests`, so a run that spent calls on
 * dead keys can still account for them.
 *
 * When every key refuses a batch, the batch is reported as refused with no
 * vectors: the caller (backfill) retries oversized batches one text at a time,
 * which is how a batch the endpoint will not take is recovered without losing the
 * texts it carried. Vectors are mapped back onto the positions of the texts they
 * were asked about, so a vector never lands on the wrong Story.
 */
export class FailoverEmbeddingService implements EmbeddingProvider, BatchingEmbeddingProvider {
  private readonly services: readonly OpenRouterEmbeddingService[];
  private position = 0;

  constructor(services: readonly OpenRouterEmbeddingService[]) {
    this.services = services;
  }

  async embed(text: string): Promise<StoryEmbedding | null> {
    if (this.services.length === 0) return null;
    if (text.trim().length === 0) return null;

    const n = this.services.length;
    for (let offset = 0; offset < n; offset += 1) {
      const service = this.services[(this.position + offset) % n]!;
      const batch = await service.embedBatch([text]);
      // A refused call is a credential or transport failure: try the next key.
      // A call that answered but carried no usable vector is not a failure of
      // this key — the model simply had nothing to say — so we return that null
      // without rotating.
      if (!batch.refused) {
        this.position = (this.position + offset) % n;
        return batch.embeddings[0] ?? null;
      }
    }
    this.position = (this.position + 1) % n;
    return null;
  }

  async embedBatch(texts: readonly string[]): Promise<EmbeddingBatch> {
    const nothing = (requests: number): EmbeddingBatch => ({
      embeddings: texts.map(() => null),
      usage: { requests, tokens: null, credits: null },
      refused: false,
    });
    if (this.services.length === 0 || texts.length === 0) return nothing(0);

    const asked = texts
      .map((text, at) => ({ text, at }))
      .filter(({ text }) => text.trim().length > 0)
      .map(({ at }) => at);
    if (asked.length === 0) return nothing(0);

    const inputs = asked.map((at) => texts[at] as string);
    const askedPositionByAt = new Map(asked.map((at, position) => [at, position]));
    const n = this.services.length;
    let totalRequests = 0;
    for (let offset = 0; offset < n; offset += 1) {
      const service = this.services[(this.position + offset) % n]!;
      const batch = await service.embedBatch(inputs);
      totalRequests += batch.usage.requests;
      if (!batch.refused) {
        this.position = (this.position + offset) % n;
        // The vectors came back ordered over `inputs` (the non-blank texts), so
        // map each one back onto its position in the full `texts` array, leaving
        // blank texts as null. A vector must never land on the wrong Story.
        const embeddings = texts.map((_text, at) => {
          const position = askedPositionByAt.get(at);
          return position === undefined ? null : batch.embeddings[position] ?? null;
        });
        return {
          embeddings,
          usage: {
            requests: totalRequests,
            tokens: batch.usage.tokens,
            credits: batch.usage.credits,
          },
          refused: false,
        };
      }
    }
    // Every key refused the batch: we know nothing about any text in it. Report
    // it as refused so the caller retries oversized batches one text at a time
    // rather than losing every text the batch carried.
    this.position = (this.position + 1) % n;
    return {
      embeddings: texts.map(() => null),
      usage: { requests: totalRequests, tokens: null, credits: null },
      refused: true,
    };
  }
}
