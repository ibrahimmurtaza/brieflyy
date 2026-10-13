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
});