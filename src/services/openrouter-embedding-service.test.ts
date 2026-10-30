import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createEmbeddingProvider,
  OpenRouterEmbeddingService,
  type EmbeddingServiceOptions,
} from './openrouter-embedding-service.js';
import { OPENROUTER_EMBEDDING_MODEL_DEFAULT } from '../config.js';

const ENDPOINT = 'https://embeddings.test/v1/embeddings';
const TEXT = 'Acme Corp unveiled Foo today. Analysts were surprised by the launch.';

interface RecordedRequest {
  readonly url: string;
  readonly init: RequestInit;
}

/** Answers every call with `reply`, recording what was asked for. */
function stubEndpoint(reply: () => unknown): RecordedRequest[] {
  const calls: RecordedRequest[] = [];
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return reply();
  });
  return calls;
}

/** The reply shape of an embeddings endpoint asked for one vector. */
function embeddings(values: readonly number[], model: unknown = 'openai/text-embedding-3-small', ok = true): unknown {
  return { ok, json: async () => ({ model, data: [{ index: 0, embedding: values }] }) };
}

/**
 * The reply shape for a call that carried several texts: one entry per vector,
 * each saying which of the inputs it answers, and what the call cost.
 */
function batchReply(
  vectors: readonly (readonly number[] | undefined)[],
  extras: Record<string, unknown> = {},
): unknown {
  return {
    ok: true,
    json: async () => ({
      model: 'openai/text-embedding-3-small',
      usage: { prompt_tokens: 24, total_tokens: 24, cost: 0.0002 },
      ...extras,
      data: vectors.map((embedding, index) =>
        embedding === undefined ? { index, object: 'embedding' } : { index, embedding },
      ),
    }),
  };
}

function aProvider(overrides: Partial<EmbeddingServiceOptions> = {}): OpenRouterEmbeddingService {
  return new OpenRouterEmbeddingService({
    apiKey: 'test-key',
    endpointUrl: ENDPOINT,
    ...overrides,
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenRouterEmbeddingService', () => {
  it('returns the vector the endpoint answered with, beside the model that produced it', async () => {
    // The happy path, which a suite of refusals says nothing about. Both halves of
    // the answer are asserted together because the second one is why the first can
    // be compared with another Story's at all.
    stubEndpoint(() => embeddings([0.1, -0.2, 0.3]));

    const result = await aProvider().embed(TEXT);

    expect(result).toEqual({
      model: 'openai/text-embedding-3-small',
      values: [0.1, -0.2, 0.3],
    });
  });

  it('asks the endpoint about this text and no other', async () => {
    const calls = stubEndpoint(() => embeddings([0.1, -0.2, 0.3]));

    await aProvider().embed(TEXT);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(ENDPOINT);
    expect(call?.init.method).toBe('POST');
    expect(new Headers(call?.init.headers).get('Authorization')).toBe('Bearer test-key');
    expect(JSON.parse(String(call?.init.body))).toEqual({
      model: OPENROUTER_EMBEDDING_MODEL_DEFAULT,
      input: TEXT,
    });
  });

  it('names the model the endpoint says it used, rather than the one it was asked for', async () => {
    // OpenRouter routes a model name to whichever vendor is serving it, so the
    // configured name is what was asked for and the reply's is what produced the
    // vector. Recording the configured one would be recording an intention.
    stubEndpoint(() => embeddings([0.1], 'vendor/some-other-embedding-2'));

    const result = await aProvider({ model: 'vendor/some-embedding-1' }).embed(TEXT);

    expect(result?.model).toBe('vendor/some-other-embedding-2');
  });

  it('falls back to the model it asked for when the reply names none', async () => {
    // OpenAI's own shape omits it, so this is the ordinary case rather than an
    // edge — and a reply naming it with whitespace is the same absence.
    stubEndpoint(() => ({
      ok: true,
      json: async () => ({ data: [{ index: 0, embedding: [0.1] }] }),
    }));
    expect((await aProvider({ model: 'vendor/some-embedding-1' }).embed(TEXT))?.model).toBe(
      'vendor/some-embedding-1',
    );

    stubEndpoint(() => embeddings([0.1], '   '));
    expect((await aProvider({ model: 'vendor/some-embedding-1' }).embed(TEXT))?.model).toBe(
      'vendor/some-embedding-1',
    );
  });

  it('returns null with no credential', async () => {
    const calls = stubEndpoint(() => embeddings([0.1]));
    expect(await new OpenRouterEmbeddingService({ endpointUrl: ENDPOINT }).embed(TEXT)).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null for text there is nothing to embed', async () => {
    // An Article whose headline and body are both blank still forms a Story. What
    // it cannot do is carry a second reading of nothing.
    const calls = stubEndpoint(() => embeddings([0.1]));
    expect(await aProvider().embed('   ')).toBeNull();
    expect(calls).toHaveLength(0);
  });

  it('returns null when the endpoint refuses', async () => {
    stubEndpoint(() => embeddings([0.1], undefined, false));
    expect(await aProvider().embed(TEXT)).toBeNull();
  });

  it('returns null when the call throws', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up');
    });
    expect(await aProvider().embed(TEXT)).toBeNull();
  });

  it('returns null for a reply that is not the shape asked for', async () => {
    // Four ways of holding a response that is not a vector, each of which would
    // otherwise be stored as one: no data, no embedding, an embedding of the wrong
    // shape, and one holding a value that is not a number.
    stubEndpoint(() => ({ ok: true, json: async () => ({ data: [] }) }));
    expect(await aProvider().embed(TEXT)).toBeNull();

    stubEndpoint(() => ({ ok: true, json: async () => ({ data: [{ index: 0 }] }) }));
    expect(await aProvider().embed(TEXT)).toBeNull();

    stubEndpoint(() => ({ ok: true, json: async () => ({ data: [{ embedding: ['a', 'b'] }] }) }));
    expect(await aProvider().embed(TEXT)).toBeNull();

    stubEndpoint(() => ({ ok: true, json: async () => ({ data: [{ embedding: [0.1, null] }] }) }));
    expect(await aProvider().embed(TEXT)).toBeNull();

    stubEndpoint(() => ({ ok: true, json: async () => ({ data: [{ embedding: [0.1, NaN] }] }) }));
    expect(await aProvider().embed(TEXT)).toBeNull();

    stubEndpoint(() => ({
      ok: true,
      json: async () => {
        throw new Error('not json');
      },
    }));
    expect(await aProvider().embed(TEXT)).toBeNull();
  });

  it('gives up on a call that outruns its timeout', async () => {
    // Ingest holds this call in the middle of a cycle, so an endpoint that never
    // answers would hold the cycle rather than one Story's second reading.
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );

    expect(await aProvider({ timeoutMs: 5 }).embed(TEXT)).toBeNull();
  });
});

describe('OpenRouterEmbeddingService.embedBatch', () => {
  it('answers one vector per text, in the order it asked in', async () => {
    // The whole reason the batch exists: several Articles reach the provider in
    // one call, and each one has to come back as the vector of *its* Article
    // rather than of whichever position happened to be answered.
    const calls = stubEndpoint(() => batchReply([[0.1], [0.2], [0.3]]));

    const batch = await aProvider().embedBatch([`${TEXT} one`, `${TEXT} two`, `${TEXT} three`]);

    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0]?.init.body)).input).toEqual([
      `${TEXT} one`,
      `${TEXT} two`,
      `${TEXT} three`,
    ]);
    expect(batch.embeddings.map((e) => e?.values)).toEqual([[0.1], [0.2], [0.3]]);
  });

  it('puts each vector on the text its index names, whatever order they arrive in', async () => {
    // `index` is documented as the position in the input list, so a reply that
    // lists its vectors out of order still has to land them correctly. Reading
    // the array position instead would silently attach the wrong vector to the
    // wrong Article, which is a corpus quietly made of unrelated readings.
    stubEndpoint(() => ({
      ok: true,
      json: async () => ({
        model: 'openai/text-embedding-3-small',
        data: [
          { index: 1, embedding: [0.2] },
          { index: 0, embedding: [0.1] },
        ],
      }),
    }));

    const batch = await aProvider().embedBatch([`${TEXT} one`, `${TEXT} two`]);

    expect(batch.embeddings.map((e) => e?.values)).toEqual([[0.1], [0.2]]);
  });

  it('falls back to the order the reply lists them in when it names no index', async () => {
    stubEndpoint(() => ({
      ok: true,
      json: async () => ({
        model: 'openai/text-embedding-3-small',
        data: [{ embedding: [0.1] }, { embedding: [0.2] }],
      }),
    }));

    const batch = await aProvider().embedBatch([`${TEXT} one`, `${TEXT} two`]);

    expect(batch.embeddings.map((e) => e?.values)).toEqual([[0.1], [0.2]]);
  });

  it('answers nothing for one text without losing the rest', async () => {
    // The per-text answer is the same `null` `embed` gives rather than a
    // shortened list, so a caller cannot line a vector up with the wrong Article
    // by counting what it did get back.
    stubEndpoint(() => batchReply([undefined, [0.2]]));

    const batch = await aProvider().embedBatch([`${TEXT} one`, `${TEXT} two`]);

    expect(batch.embeddings).toEqual([null, { model: 'openai/text-embedding-3-small', values: [0.2] }]);
  });

  it('refuses a vector it cannot read whole rather than storing half of one', async () => {
    stubEndpoint(() => batchReply([[0.1, 'two' as unknown as number], [0.3]]));

    const batch = await aProvider().embedBatch([`${TEXT} one`, `${TEXT} two`]);

    expect(batch.embeddings).toEqual([null, { model: 'openai/text-embedding-3-small', values: [0.3] }]);
  });

  it('asks about the texts it has something to embed, and no others', async () => {
    // The endpoint refuses an empty string, so sending one would turn a single
    // unembeddable Article into a call the whole batch pays for. It keeps its
    // place in the answer as `null`, which is what `embed` answers with too.
    const calls = stubEndpoint(() => batchReply([[0.1]]));

    const batch = await aProvider().embedBatch(['   ', `${TEXT} two`, '']);

    expect(JSON.parse(String(calls[0]?.init.body)).input).toEqual([`${TEXT} two`]);
    expect(batch.embeddings).toEqual([null, { model: 'openai/text-embedding-3-small', values: [0.1] }, null]);
  });

  it('reports what the run cost, in requests, tokens and credits', async () => {
    // Three numbers a caller cannot work out for itself and has to be given: what
    // it spent, what the provider says it cost in tokens, and what it billed.
    // The last is the provider's own unit, so it is named as credits rather than
    // as money this build has no way to price.
    stubEndpoint(() => batchReply([[0.1], [0.2]]));

    const batch = await aProvider().embedBatch([`${TEXT} one`, `${TEXT} two`]);

    expect(batch.usage).toEqual({ requests: 1, tokens: 24, credits: 0.0002 });
  });

  it('says nothing was reported rather than that it was free', async () => {
    // A reply carrying no usage is the absence of a measurement, and reading it
    // as zero would be the one answer that is certainly wrong: a run that spent
    // money would report that it had spent none.
    stubEndpoint(() => batchReply([[0.1]], { usage: undefined }));

    const batch = await aProvider().embedBatch([`${TEXT} one`]);

    expect(batch.usage).toEqual({ requests: 1, tokens: null, credits: null });
  });

  it('counts a refused call as a call, because it was billed as one', async () => {
    stubEndpoint(() => ({ ok: false, json: async () => ({}) }));

    const batch = await aProvider().embedBatch([`${TEXT} one`]);

    expect(batch.embeddings).toEqual([null]);
    expect(batch.usage.requests).toBe(1);
  });

  it('says a call was refused rather than that it had nothing for these texts', async () => {
    // The two are fixed in opposite ways, and a caller that cannot tell them apart
    // cannot tell a batch the endpoint would not take — the case where the batch
    // is too large — from one Article nothing could be embedded for.
    stubEndpoint(() => ({ ok: false, json: async () => ({}) }));
    expect((await aProvider().embedBatch([`${TEXT} one`])).refused).toBe(true);

    stubEndpoint(() => batchReply([undefined]));
    expect((await aProvider().embedBatch([`${TEXT} one`])).refused).toBe(false);

    stubEndpoint(() => ({ ok: true, json: async () => ({ data: 'not a list' }) }));
    expect((await aProvider().embedBatch([`${TEXT} one`])).refused).toBe(false);
  });

  it('answers nothing without spending a call when the deployment has no credential', async () => {
    const calls = stubEndpoint(() => batchReply([[0.1]]));
    const switchedOff = new OpenRouterEmbeddingService({ endpointUrl: ENDPOINT });

    expect(await switchedOff.embedBatch([`${TEXT} one`, `${TEXT} two`])).toEqual({
      embeddings: [null, null],
      usage: { requests: 0, tokens: null, credits: null },
      refused: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('answers nothing without spending a call when there is no text to embed', async () => {
    const calls = stubEndpoint(() => batchReply([[0.1]]));

    expect(await aProvider().embedBatch([])).toEqual({
      embeddings: [],
      usage: { requests: 0, tokens: null, credits: null },
      refused: false,
    });
    expect(await aProvider().embedBatch(['  ', '\n'])).toEqual({
      embeddings: [null, null],
      usage: { requests: 0, tokens: null, credits: null },
      refused: false,
    });
    expect(calls).toHaveLength(0);
  });

  it('answers nothing for a call that outruns its timeout or throws', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );
    expect((await aProvider({ timeoutMs: 5 }).embedBatch([`${TEXT} one`])).usage.requests).toBe(1);

    vi.stubGlobal('fetch', async () => {
      throw new Error('socket hang up');
    });
    expect((await aProvider().embedBatch([`${TEXT} one`])).embeddings).toEqual([null]);
  });
});

describe('createEmbeddingProvider', () => {
  it('builds nothing when the deployment has no credential', () => {
    // Absent rather than a provider that answers null, because the caller reads a
    // missing provider as "this deployment does not embed" and a null as "this
    // Story has none". The same distinction the written-summary path draws.
    expect(createEmbeddingProvider({ env: {} })).toBeNull();
  });

  it('reads a key of whitespace as no key', () => {
    // Every other piece of configuration is read by the same reader, so a key of
    // spaces is unset here as it is everywhere else: this path would otherwise
    // authenticate as `Bearer   ` and spend a call finding out.
    expect(createEmbeddingProvider({ env: { OPENROUTER_API_KEY: '   ' } })).toBeNull();
    expect(createEmbeddingProvider({ env: { OPENROUTER_API_KEY: '' } })).toBeNull();
  });

  it('builds one from the credential, the endpoint and the model the deployment set', () => {
    const provider = createEmbeddingProvider({
      env: {
        OPENROUTER_API_KEY: 'k',
        OPENROUTER_EMBEDDINGS_URL: 'https://elsewhere.test/v1/embeddings',
        OPENROUTER_EMBEDDING_MODEL: 'vendor/some-embedding-1',
      },
    });
    expect(provider).toBeInstanceOf(OpenRouterEmbeddingService);
  });

  it('takes an explicit key over the environment, as the summary client does', () => {
    const explicit = createEmbeddingProvider({ apiKey: 'explicit', env: { OPENROUTER_API_KEY: 'from-env' } });
    expect(explicit).not.toBeNull();
    expect(createEmbeddingProvider({ env: { OPENROUTER_API_KEY: 'from-env' } })).not.toBeNull();
  });

  it('builds a failover provider from OPENROUTER_API_KEYS with several keys', () => {
    const provider = createEmbeddingProvider({
      env: {
        OPENROUTER_API_KEYS: 'key-one, key-two ,key-three',
        OPENROUTER_EMBEDDINGS_URL: 'https://elsewhere.test/v1/embeddings',
        OPENROUTER_EMBEDDING_MODEL: 'vendor/some-embedding-1',
      },
    });
    expect(provider).not.toBeNull();
    expect(provider).not.toBeInstanceOf(OpenRouterEmbeddingService);
    expect(typeof (provider as { embedBatch?: unknown }).embedBatch).toBe('function');
  });

  it('builds a single provider when OPENROUTER_API_KEYS has one key', () => {
    const provider = createEmbeddingProvider({
      env: { OPENROUTER_API_KEYS: 'only-key' },
    });
    expect(provider).toBeInstanceOf(OpenRouterEmbeddingService);
  });

  it('takes explicit apiKeys over the environment', () => {
    const provider = createEmbeddingProvider({
      apiKeys: ['explicit-one', 'explicit-two'],
      env: { OPENROUTER_API_KEYS: 'from-env-one, from-env-two' },
    });
    expect(provider).not.toBeNull();
    expect(provider).not.toBeInstanceOf(OpenRouterEmbeddingService);
  });

  it('builds nothing when OPENROUTER_API_KEYS is all blanks', () => {
    expect(createEmbeddingProvider({ env: { OPENROUTER_API_KEYS: ' , , ' } })).toBeNull();
  });
});