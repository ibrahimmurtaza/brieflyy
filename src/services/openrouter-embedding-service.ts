import {
  EMBEDDING_CALL_TIMEOUT_MS_DEFAULT,
  OPENROUTER_EMBEDDING_MODEL_DEFAULT,
  OPENROUTER_EMBEDDINGS_URL_DEFAULT,
} from '../config.js';
import type { EmbeddingProvider, StoryEmbedding } from '../domain/embedding.js';
import { readOptionalString, readString, type EnvSource } from '../env.js';

export interface EmbeddingServiceOptions {
  readonly timeoutMs?: number | undefined;
  /** The credential, resolved by the caller. Absent means the path is switched off. */
  readonly apiKey?: string | undefined;
  readonly endpointUrl?: string | undefined;
  readonly model?: string | undefined;
}

/** The reply an OpenAI-shaped embeddings endpoint answers a one-text request with. */
interface EmbeddingsReply {
  readonly model?: unknown;
  readonly data?: readonly { readonly embedding?: unknown }[];
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
function readVector(reply: EmbeddingsReply): readonly number[] | null {
  const vector = reply.data?.[0]?.embedding;
  if (!Array.isArray(vector) || vector.length === 0) return null;
  const values: number[] = [];
  for (const entry of vector) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    values.push(entry);
  }
  return values;
}

/**
 * Talks to the provider, and knows nothing about what the text is or where it
 * came from.
 *
 * The environment is read by `createEmbeddingProvider` rather than here, so this
 * is a plain object a test can build and the composition root is the only thing
 * that has to know what a deployment configured.
 */
export class OpenRouterEmbeddingService implements EmbeddingProvider {
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

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({ model: this.model, input: text }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) return null;

      const reply = (await response.json()) as EmbeddingsReply;
      const values = readVector(reply);
      if (values === null) return null;

      // The model the reply names is the one that produced the vector, which is not
      // necessarily the one that was asked for: the provider routes a name to
      // whichever vendor is serving it, and a name asked for is an intention. The
      // configured one is the fallback for the shape that omits it.
      const named = typeof reply.model === 'string' ? reply.model.trim() : '';
      return { model: named.length > 0 ? named : this.model, values };
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
 * is wired rather than once per Article.
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