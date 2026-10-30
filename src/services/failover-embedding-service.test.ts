import { afterEach, describe, expect, it, vi } from 'vitest';

import { FailoverEmbeddingService } from './failover-embedding-service.js';
import { OpenRouterEmbeddingService } from './openrouter-embedding-service.js';
import { OPENROUTER_EMBEDDING_MODEL_DEFAULT } from '../config.js';

const ENDPOINT = 'https://embeddings.test/v1/embeddings';
const TEXT = 'Acme Corp unveiled Foo today. Analysts were surprised by the launch.';
const KEY_A = 'key-a';
const KEY_B = 'key-b';
const KEY_C = 'key-c';

interface RecordedCall {
  readonly url: string;
  readonly init: RequestInit;
}

/**
 * Stubs fetch so each key gets its own reply factory. Records every call so a
 * test can assert which key was used.
 */
function stubByKey(
  replies: Record<string, () => unknown>,
): RecordedCall[] {
  const calls: RecordedCall[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const auth = new Headers(init.headers).get('Authorization') ?? '';
    const key = auth.replace(/^Bearer\s*/, '');
    const reply = replies[key];
    if (reply === undefined) {
      throw new Error(`no reply configured for key ${key}`);
    }
    return reply();
  });
  return calls;
}

function aService(apiKey: string): OpenRouterEmbeddingService {
  return new OpenRouterEmbeddingService({ apiKey, endpointUrl: ENDPOINT });
}

function okVector(values: readonly number[]): unknown {
  return {
    ok: true,
    json: async () => ({
      model: OPENROUTER_EMBEDDING_MODEL_DEFAULT,
      data: [{ index: 0, embedding: values }],
    }),
  };
}

function refused(): unknown {
  return { ok: false, json: async () => ({}) };
}

function batchReply(
  vectors: readonly (readonly number[] | undefined)[],
): unknown {
  return {
    ok: true,
    json: async () => ({
      model: OPENROUTER_EMBEDDING_MODEL_DEFAULT,
      usage: { prompt_tokens: 24, total_tokens: 24, cost: 0.0002 },
      data: vectors.map((embedding, index) =>
        embedding === undefined ? { index, object: 'embedding' } : { index, embedding },
      ),
    }),
  };
}

function batchRefused(): unknown {
  return { ok: false, json: async () => ({}) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FailoverEmbeddingService.embed', () => {
  it('returns the vector from the first key that answers', async () => {
    const calls = stubByKey({
      [KEY_A]: () => okVector([0.1, -0.2, 0.3]),
      [KEY_B]: () => okVector([0.4, 0.5]),
    });

    const service = new FailoverEmbeddingService([
      aService(KEY_A),
      aService(KEY_B),
    ]);

    const result = await service.embed(TEXT);

    expect(result).toEqual({ model: OPENROUTER_EMBEDDING_MODEL_DEFAULT, values: [0.1, -0.2, 0.3] });
    expect(calls).toHaveLength(1);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_A}`);
  });

  it('rotates to the next key when the first returns nothing', async () => {
    const calls = stubByKey({
      [KEY_A]: () => refused(),
      [KEY_B]: () => okVector([0.7, 0.8]),
    });

    const service = new FailoverEmbeddingService([
      aService(KEY_A),
      aService(KEY_B),
    ]);

    const result = await service.embed(TEXT);

    expect(result).toEqual({ model: OPENROUTER_EMBEDDING_MODEL_DEFAULT, values: [0.7, 0.8] });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_A}`);
    expect(new Headers(calls[1]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_B}`);
  });

  it('returns null when every key fails', async () => {
    const calls = stubByKey({
      [KEY_A]: () => refused(),
      [KEY_B]: () => refused(),
    });

    const service = new FailoverEmbeddingService([
      aService(KEY_A),
      aService(KEY_B),
    ]);

    expect(await service.embed(TEXT)).toBeNull();
    expect(calls).toHaveLength(2);
  });

  it('does not rotate when a key answers with a valid but empty vector', async () => {
    const calls = stubByKey({
      [KEY_A]: () => ({
        ok: true,
        json: async () => ({ model: OPENROUTER_EMBEDDING_MODEL_DEFAULT, data: [] }),
      }),
      [KEY_B]: () => okVector([0.1]),
    });

    const service = new FailoverEmbeddingService([
      aService(KEY_A),
      aService(KEY_B),
    ]);

    // Key A answered (200 OK) but with no usable vector: that is not a credential
    // failure, so the null is returned without trying key B.
    expect(await service.embed(TEXT)).toBeNull();
    expect(calls).toHaveLength(1);
  });

  it('starts from the next position after all keys fail', async () => {
    const calls = stubByKey({
      [KEY_A]: () => refused(),
      [KEY_B]: () => refused(),
      [KEY_C]: () => refused(),
    });

    const service = new FailoverEmbeddingService([
      aService(KEY_A),
      aService(KEY_B),
      aService(KEY_C),
    ]);

    // First call: all three refuse, position advances past key A.
    expect(await service.embed(TEXT)).toBeNull();
    expect(calls).toHaveLength(3);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_A}`);
    expect(new Headers(calls[1]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_B}`);
    expect(new Headers(calls[2]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_C}`);

    calls.length = 0;

    // Now key C answers, keys A and B still refuse.
    vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => {
      calls.push({ url: _url, init });
      const auth = new Headers(init.headers).get('Authorization') ?? '';
      const key = auth.replace(/^Bearer\s*/, '');
      if (key === KEY_C) return okVector([0.9]);
      return refused();
    });

    expect(await service.embed(TEXT)).toEqual({ model: OPENROUTER_EMBEDDING_MODEL_DEFAULT, values: [0.9] });
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_B}`);
    expect(new Headers(calls[1]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_C}`);
  });

  it('returns null with no services', async () => {
    const service = new FailoverEmbeddingService([]);
    expect(await service.embed(TEXT)).toBeNull();
  });

  it('returns null for empty text without calling any key', async () => {
    const calls = stubByKey({ [KEY_A]: () => okVector([0.1]) });
    const service = new FailoverEmbeddingService([aService(KEY_A)]);
    expect(await service.embed('   ')).toBeNull();
    expect(calls).toHaveLength(0);
  });
});

describe('FailoverEmbeddingService.embedBatch', () => {
  it('returns the batch from the first key that is not refused', async () => {
    const calls = stubByKey({
      [KEY_A]: () => batchRefused(),
      [KEY_B]: () => batchReply([[0.1], [0.2]]),
    });

    const service = new FailoverEmbeddingService([
      aService(KEY_A),
      aService(KEY_B),
    ]);

    const batch = await service.embedBatch([`${TEXT} one`, `${TEXT} two`]);

    expect(batch.refused).toBe(false);
    expect(batch.embeddings.map((e) => e?.values)).toEqual([[0.1], [0.2]]);
    expect(calls).toHaveLength(2);
    expect(new Headers(calls[0]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_A}`);
    expect(new Headers(calls[1]!.init.headers).get('Authorization')).toBe(`Bearer ${KEY_B}`);
  });

  it('does not rotate when a batch answers but carries null entries', async () => {
    const calls = stubByKey({
      [KEY_A]: () => batchReply([[0.1], undefined]),
      [KEY_B]: () => batchReply([[0.3], [0.4]]),
    });

    const service = new FailoverEmbeddingService([
      aService(KEY_A),
      aService(KEY_B),
    ]);

    const batch = await service.embedBatch([`${TEXT} one`, `${TEXT} two`]);

    // Key A answered (not refused), so its result is returned as-is even though
    // the second text has no vector.
    expect(batch.refused).toBe(false);
    expect(batch.embeddings.map((e) => (e === null ? null : e.values))).toEqual([[0.1], null]);
    expect(calls).toHaveLength(1);
  });

  it('returns null embeddings when every batch is refused', async () => {
    const calls = stubByKey({
      [KEY_A]: () => batchRefused(),
      [KEY_B]: () => batchRefused(),
    });

    const service = new FailoverEmbeddingService([
      aService(KEY_A),
      aService(KEY_B),
    ]);

    const batch = await service.embedBatch([`${TEXT} one`]);

    expect(batch.refused).toBe(false);
    expect(batch.embeddings).toEqual([null]);
    expect(batch.usage.requests).toBe(1);
    expect(calls).toHaveLength(2);
  });

  it('returns an empty batch with no calls when there is no text', async () => {
    const calls = stubByKey({ [KEY_A]: () => batchReply([[0.1]]) });
    const service = new FailoverEmbeddingService([aService(KEY_A)]);

    expect(await service.embedBatch([])).toEqual({
      embeddings: [],
      usage: { requests: 0, tokens: null, credits: null },
      refused: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('returns nulls without calling when every text is blank', async () => {
    const calls = stubByKey({ [KEY_A]: () => batchReply([[0.1]]) });
    const service = new FailoverEmbeddingService([aService(KEY_A)]);

    expect(await service.embedBatch(['  ', '\n'])).toEqual({
      embeddings: [null, null],
      usage: { requests: 0, tokens: null, credits: null },
      refused: false,
    });
    expect(calls).toHaveLength(0);
  });
});
