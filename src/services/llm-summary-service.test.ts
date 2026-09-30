import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createLLMSummaryClient,
  OpenAILLMSummaryService,
  type LLMSummaryServiceOptions,
} from './llm-summary-service.js';

const ENDPOINT = 'https://llm.test/v1/chat/completions';
const ARTICLES = [
  {
    url: 'https://example.com/a-1',
    title: 'Acme unveils Foo',
    body: 'Acme Corp unveiled Foo today. Analysts were surprised by the launch.',
  },
  {
    url: 'https://example.com/a-2',
    title: 'Regulators look at Foo',
    body: 'Regulators opened a review into the Acme Corp launch.',
  },
];

/** The reply shape of a chat completions endpoint that was asked for JSON. */
function completion(content: string, ok = true): unknown {
  return {
    ok,
    json: async () => ({ choices: [{ message: { content } }] }),
  };
}

/** The one-liner and one cited bullet, in the JSON the prompt asks for. */
const A_REPLY = JSON.stringify({
  summary: 'A line.',
  bulletPoints: [{ text: 'A point.', articleUrl: 'https://example.com/a-1' }],
});

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

function aClient(overrides: Partial<LLMSummaryServiceOptions> = {}): OpenAILLMSummaryService {
  return new OpenAILLMSummaryService({ apiKey: 'test-key', endpointUrl: ENDPOINT, ...overrides });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('OpenAILLMSummaryService', () => {
  it('returns null when apiKey is missing', async () => {
    const service = new OpenAILLMSummaryService({ endpointUrl: '' });
    const result = await service.generateSummary('Title', 'Summary', [{ url: 'http://example.com', title: 'T', body: 'B' }]);
    expect(result).toBeNull();
  });

  it('returns null for empty articles', async () => {
    const service = new OpenAILLMSummaryService({ apiKey: 'test', endpointUrl: '' });
    const result = await service.generateSummary('Title', 'Summary', []);
    expect(result).toBeNull();
  });

  it('writes the summary and the bullets the endpoint answered with', async () => {
    // The happy path, which is the one that was never covered: two tests that a
    // client with no key and a Cluster with no Articles both return null say
    // nothing about whether a single brief is ever actually written.
    stubEndpoint(() => completion(A_REPLY));

    const result = await aClient().generateSummary('Acme and Foo', 'Extractive one-liner', ARTICLES);

    expect(result).toEqual({
      summary: 'A line.',
      bulletPoints: [{ text: 'A point.', articleUrl: 'https://example.com/a-1' }],
      discardedBullets: 0,
    });
  });

  it('asks the endpoint about this Cluster and its own Articles, and no others', async () => {
    const calls = stubEndpoint(() =>
      completion(A_REPLY),
    );

    await aClient().generateSummary('Acme and Foo', 'Extractive one-liner', ARTICLES);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call?.url).toBe(ENDPOINT);
    expect(call?.init.method).toBe('POST');
    expect(new Headers(call?.init.headers).get('Authorization')).toBe('Bearer test-key');
    const prompt = String((JSON.parse(String(call?.init.body)) as { messages: { content: string }[] }).messages[0]?.content);
    expect(prompt).toContain('Acme and Foo');
    expect(prompt).toContain('Extractive one-liner');
    expect(prompt).toContain('https://example.com/a-1');
    expect(prompt).toContain('https://example.com/a-2');
  });

  it('bounds what one call costs and how long it may take', async () => {
    // A brief is sent on a schedule to every User, so an unbounded reply is a
    // bill that grows with the reading rather than with what was read.
    const calls = stubEndpoint(() =>
      completion(A_REPLY),
    );

    await aClient().generateSummary('Acme and Foo', 'Extractive one-liner', ARTICLES);

    const body = JSON.parse(String(calls[0]?.init.body)) as { max_tokens: number; model: string };
    expect(body.max_tokens).toBeGreaterThan(0);
    expect(body.model).not.toBe('');
  });

  it('truncates a long Article rather than sending the whole of it', async () => {
    const calls = stubEndpoint(() =>
      completion(A_REPLY),
    );

    await aClient().generateSummary('Long read', '', [
      { url: 'https://example.com/long', title: 'Long', body: 'x'.repeat(50_000) },
    ]);

    const body = String(JSON.parse(String(calls[0]?.init.body)).messages[0]?.content);
    expect(body.length).toBeLessThan(50_000);
  });

  it('keeps only the bullets that cite an Article in the Cluster, and says how many it dropped', async () => {
    // The whole point of the constraint: a brief that quotes a Source is making a
    // claim about what that Source wrote, and a URL from outside the Cluster is a
    // citation of something nobody checked. The count is in the answer because a
    // Cluster that quietly loses bullets is otherwise indistinguishable from one
    // that never had any to lose.
    stubEndpoint(() =>
      completion(
        JSON.stringify({
          summary: 'A line.',
          bulletPoints: [
            { text: 'Cites the first Article.', articleUrl: 'https://example.com/a-1' },
            { text: 'Cites a stranger.', articleUrl: 'https://elsewhere.test/not-ours' },
            { text: 'Cites the second Article.', articleUrl: 'https://example.com/a-2' },
          ],
        }),
      ),
    );

    const result = await aClient().generateSummary('Acme and Foo', '', ARTICLES);

    expect(result?.bulletPoints).toEqual([
      { text: 'Cites the first Article.', articleUrl: 'https://example.com/a-1' },
      { text: 'Cites the second Article.', articleUrl: 'https://example.com/a-2' },
    ]);
    expect(result?.discardedBullets).toBe(1);
  });

  it('answers with nothing but the count when every bullet cites outside the Cluster', async () => {
    // An answer rather than a null, because the count is the only thing anybody
    // learns from a call like this and a null would throw it away. The renderer
    // quotes the Cluster on an answer with no bullets, so the two agree on what
    // the reader sees and disagree about nothing.
    stubEndpoint(() =>
      completion(
        JSON.stringify({
          summary: 'A line.',
          bulletPoints: [
            { text: 'A stranger.', articleUrl: 'https://elsewhere.test/not-ours' },
            { text: 'Another stranger.', articleUrl: 'https://elsewhere.test/also-not-ours' },
          ],
        }),
      ),
    );

    const result = await aClient().generateSummary('Acme and Foo', '', ARTICLES);

    expect(result).toEqual({ summary: 'A line.', bulletPoints: [], discardedBullets: 2 });
  });

  it('discards a bullet that is not a text citing a URL at all, and counts it', async () => {
    stubEndpoint(() =>
      completion(
        JSON.stringify({
          summary: 'A line.',
          bulletPoints: [
            'a bare string',
            { text: 'No citation.' },
            { text: 'Cites the first Article.', articleUrl: 'https://example.com/a-1' },
          ],
        }),
      ),
    );

    const result = await aClient().generateSummary('Acme and Foo', '', ARTICLES);

    expect(result?.bulletPoints).toEqual([
      { text: 'Cites the first Article.', articleUrl: 'https://example.com/a-1' },
    ]);
    // A bullet that is not a bullet failed the same contract a wrong citation
    // did, and an operator watching the discarded count should see both.
    expect(result?.discardedBullets).toBe(2);
  });

  it('returns null when the endpoint answers with an error', async () => {
    stubEndpoint(() => completion('{"error":"overloaded"}', false));

    expect(await aClient().generateSummary('Acme and Foo', '', ARTICLES)).toBeNull();
  });

  it('returns null when the answer is not the JSON it was asked for', async () => {
    stubEndpoint(() => completion('I am sorry, I cannot do that.'));

    expect(await aClient().generateSummary('Acme and Foo', '', ARTICLES)).toBeNull();
  });

  it('abandons a call that outruns its timeout', async () => {
    vi.stubGlobal('fetch', (_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      }),
    );

    expect(
      await aClient({ timeoutMs: 5 }).generateSummary('Acme and Foo', '', ARTICLES),
    ).toBeNull();
  });

  it('makes no request at all without a key', async () => {
    // "Degrades quietly" is a claim about the wire, not about the return value:
    // a client that logged or retried here would turn a missing credential into
    // an outage for a feature the application is happy to run without.
    const calls = stubEndpoint(() => completion('{}'));

    const service = new OpenAILLMSummaryService({ endpointUrl: ENDPOINT });
    expect(await service.generateSummary('Acme and Foo', '', ARTICLES)).toBeNull();
    expect(calls).toEqual([]);
  });
});

describe('createLLMSummaryClient', () => {
  it('is nothing at all when no key is configured', () => {
    // The application composes the written path or does not have it. A client
    // that existed without a key would spend the brief's whole call budget
    // discovering it cannot be used.
    expect(createLLMSummaryClient({ env: {} })).toBeNull();
    expect(createLLMSummaryClient()).toBeNull();
  });

  it('reads a key of whitespace as no key, from either source', () => {
    // The same rule every other reader applies, and it has to be the same rule
    // here: a client built from a blank key would spend a brief's budget
    // authenticating as `Bearer   `.
    expect(createLLMSummaryClient({ env: { OPENAI_API_KEY: '  ' } })).toBeNull();
    expect(createLLMSummaryClient({ apiKey: '  ' })).toBeNull();
    expect(createLLMSummaryClient({ apiKey: '' })).toBeNull();
  });

  it('is a client once a key is configured', () => {
    const client = createLLMSummaryClient({ env: { OPENAI_API_KEY: 'k' }, endpointUrl: ENDPOINT });

    expect(client).toBeInstanceOf(OpenAILLMSummaryService);
  });

  it('resolves the key and the endpoint the deployment configured', async () => {
    const calls = stubEndpoint(() => completion(A_REPLY));

    const client = createLLMSummaryClient({
      env: { OPENAI_API_KEY: ' from-env ', OPENAI_API_URL: 'https://from-env.test/chat' },
    });
    await client?.generateSummary('Acme and Foo', '', ARTICLES);

    expect(calls[0]?.url).toBe('https://from-env.test/chat');
    // Trimmed on the way through, the way every other configured value is.
    expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer from-env');
  });

  it('prefers a key given over one in the environment', () => {
    expect(
      createLLMSummaryClient({ apiKey: 'explicit', env: { OPENAI_API_KEY: 'ambient' } }),
    ).toBeInstanceOf(OpenAILLMSummaryService);
  });
});
