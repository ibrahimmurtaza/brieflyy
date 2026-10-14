import {
  EMBEDDING_CALL_TIMEOUT_MS_DEFAULT,
  OPENROUTER_EMBEDDING_MODEL_DEFAULT,
  OPENROUTER_EMBEDDINGS_URL_DEFAULT,
} from '../config.js';
import type {
  BatchingEmbeddingProvider,
  EmbeddingBatch,
  EmbeddingProvider,
  StoryEmbedding,
} from '../domain/embedding.js';
import { readOptionalString, readString, type EnvSource } from '../env.js';

export interface EmbeddingServiceOptions {
  readonly timeoutMs?: number | undefined;
  /** The credential, resolved by the caller. Absent means the path is switched off. */
  readonly apiKey?: string | undefined;
  readonly endpointUrl?: string | undefined;
  readonly model?: string | undefined;
}

/**
 * The reply an OpenAI-shaped embeddings endpoint answers with.
 *
 * `index` is the position the vector answers for, which the endpoint documents
 * as its index in the input list; `usage` is what it charged for the call. Both
 * are read defensively because the shape that omits them is one this provider has
 * to survive rather than one it may refuse.
 */
interface EmbeddingsReply {
  readonly model?: unknown;
  readonly data?: readonly { readonly index?: unknown; readonly embedding?: unknown }[];
  readonly usage?: { readonly total_tokens?: unknown; readonly cost?: unknown } | undefined;
}

/**
 * The vector as the endpoint sent it, or nothing at all.
 *
 * Every failure is the same answer — no credential, nothing to embed, a refused
 * call, a reply that was not the shape asked for — because a caller cannot act on
 * the difference and a Story with no embedding is a complete Story. What it must
 * not do is return a half-read vector: a value that is not a number and one that
 * is NaN both come back as absence, because a vector with a hole in it would be
 * compared against as though it were the whole reading.
 */
function readValues(vector: unknown): readonly number[] | null {
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const values: number[] = [];
  for (const entry of vector) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    values.push(entry);
  }
  return values;
}

function readVector(reply: EmbeddingsReply): readonly number[] | null {
  return readValues(reply.data?.[0]?.embedding);
}

/**
 * Every vector a reply carries, keyed by the position it answers for.
 *
 * Keyed by the `index` the endpoint sends rather than by where the vector sits in
 * the array, so a reply that comes back out of order still lands on the Article it
 * describes. The array position is the fallback for the shape that sends no index
 * at all, which is the same weaker claim the model's name falls back to make.
 *
 * A vector that is not readable is left out rather than filled in, so its position
 * stays `null` — a Story carrying a half-read vector would be compared against as
 * though it were the whole reading.
 */
function vectorsByIndex(reply: EmbeddingsReply): ReadonlyMap<number, readonly number[]> {
  const data = Array.isArray(reply.data) ? reply.data : [];
  const found = new Map<number, readonly number[]>();
  for (const [position, entry] of data.entries()) {
    const values = readValues(entry?.embedding);
    if (values === null) continue;
    const at = typeof entry?.index === 'number' && Number.isInteger(entry.index)
      ? entry.index
      : position;
    if (!found.has(at)) found.set(at, values);
  }
  return found;
}

/**
 * The model the reply names is the one that produced the vectors, which is not
 * necessarily the one that was asked for: the provider routes a name to whichever
 * vendor is serving it, and a name asked for is an intention. The configured one
 * is the fallback for the shape that omits it.
 */
function modelOf(reply: EmbeddingsReply, fallback: string): string {
  const named = typeof reply.model === 'string' ? reply.model.trim() : '';
  return named.length > 0 ? named : fallback;
}

/** A figure the reply reports, or nothing at all rather than a guess at one. */
function readFigure(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Talks to the provider, and knows nothing about what the text is or where it
 * came from.
 *
 * The environment is read by `createEmbeddingProvider` rather than here, so this
 * is a plain object a test can build and the composition root is the only thing
 * that has to know what a deployment configured.
 */
export class OpenRouterEmbeddingService implements EmbeddingProvider, BatchingEmbeddingProvider {
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly endpointUrl: string;
  private readonly model: string;

  constructor(opts: EmbeddingServiceOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? EMBEDDING_CALL_TIMEOUT_MS_DEFAULT;
    this.apiKey = opts.apiKey;
    this.endpointUrl = opts.endpointUrl ?? OPENROUTER_EMBEDDINGS_URL_DEFAULT;
    this.model = opts.model ?? OPENROUTER_EMBEDDING_MODEL_DEFAULT;
  }

  async embed(text: string): Promise<StoryEmbedding | null> {
    if (!this.apiKey) return null;
    if (text.trim().length === 0) return null;

    const reply = await this.call(text);
    if (reply === null) return null;
    const values = readVector(reply);
    if (values === null) return null;
    return { model: modelOf(reply, this.model), values };
  }

  /**
   * Many texts in one call, which is what makes a backfill affordable: the
   * endpoint is billed per request, so a corpus of a hundred thousand Stories is
   * a few thousand calls rather than a hundred thousand of them.
   *
   * The vectors come back in the order they were asked for whatever order the
   * reply lists them in, and a text the provider had nothing for is `null` at its
   * own position — which is also why a text with nothing in it is **not sent at
   * all**. The endpoint refuses an empty string, so asking it about one would
   * turn a single unembeddable Article into a refused call the whole batch pays
   * for. It keeps its place in the answer as `null`, the same answer `embed`
   * gives it, and the texts beside it are asked for as normal.
   */
  async embedBatch(texts: readonly string[]): Promise<EmbeddingBatch> {
    const nothing = (requests: number): EmbeddingBatch => ({
      embeddings: texts.map(() => null),
      usage: { requests, tokens: null, credits: null },
      // No call was spent and none is owed: there was nothing to send, which is
      // not the same thing as a call that was made and came back with nothing.
      refused: false,
    });
    if (!this.apiKey || texts.length === 0) return nothing(0);

    const asked = texts
      .map((text, at) => ({ text, at }))
      .filter(({ text }) => text.trim().length > 0)
      .map(({ at }) => at);
    if (asked.length === 0) return nothing(0);

    const reply = await this.call(asked.map((at) => texts[at] as string));
    // A refused call is still a call, and it is billed as one: a run that reports
    // the requests it spent is the only reason an operator can trust the figure.
    if (reply === null) return { ...nothing(1), refused: true };

    const model = modelOf(reply, this.model);
    const vectors = vectorsByIndex(reply);
    // Where each asked-for text sits among the texts the call actually carried,
    // so the answer can be put back on the Article it belongs to.
    const askedAt = new Map(asked.map((at, position) => [at, position]));
    const embeddings = texts.map((_text, at) => {
      const position = askedAt.get(at);
      const values = position === undefined ? undefined : vectors.get(position);
      return values === undefined ? null : { model, values };
    });
    return {
      embeddings,
      usage: {
        requests: 1,
        tokens: readFigure(reply.usage?.total_tokens),
        credits: readFigure(reply.usage?.cost),
      },
      // The call came back in a shape that could be read, so whatever is missing
      // from the vectors is a fact about a text rather than about the endpoint.
      refused: false,
    };
  }

  /**
   * One call, and whatever it answered with, which is `null` wherever there is
   * nothing to report.
   *
   * The single place the credential, the timeout and the body are made, so that
   * asking about one text and asking about twenty cost the same to read. An
   * endpoint that accepts the request and never answers is bounded rather than
   * waited on, and that bound is the only reason a call that hangs cannot hold
   * whatever asked it.
   */
  private async call(input: string | readonly string[]): Promise<EmbeddingsReply | null> {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) return null;
      return (await response.json()) as EmbeddingsReply;
    } catch {
      return null;
    }
  }
}

/**
 * The embedding path as the deployment has configured it, or nothing at all.
 *
 * Absent rather than a provider that answers null, because the caller reads a
 * missing provider as "this deployment forms Stories without embeddings" and reads
 * a null as "this one Article could not be embedded". A deployment with no
 * credential is a complete configuration, so it is answered where the application
 * is wired rather than once per Article once per poll.
 */
export function createEmbeddingProvider(
  opts: EmbeddingServiceOptions & {
    /** Where the deployment's configuration is read from. Defaults to nothing set. */
    readonly env?: EnvSource | undefined;
  } = {},
): EmbeddingProvider | null {
  const env = opts.env ?? {};
  const apiKey =
    readOptionalString({ OPENROUTER_API_KEY: opts.apiKey }, 'OPENROUTER_API_KEY') ??
    readOptionalString(env, 'OPENROUTER_API_KEY');
  if (apiKey === undefined) return null;

  const { env: _env, ...options } = opts;
  return new OpenRouterEmbeddingService({
    ...options,
    apiKey,
    endpointUrl:
      options.endpointUrl ?? readString(env, 'OPENROUTER_EMBEDDINGS_URL', OPENROUTER_EMBEDDINGS_URL_DEFAULT),
    model: options.model ?? readString(env, 'OPENROUTER_EMBEDDING_MODEL', OPENROUTER_EMBEDDING_MODEL_DEFAULT),
  });
}