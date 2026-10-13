/**
 * What a Story carries about what its Article said, and the contract for asking.
 *
 * The Story signature is one reading of an Article: the words and the order they
 * were written in. An embedding is the second — a dense vector of what the text
 * said, which two reports of one event land near each other on and two reports of
 * different events do not, however little their wording overlaps.
 *
 * It is computed once, where the Story is formed, and stored beside the model that
 * produced it rather than left in configuration. The model is the point of storing
 * it beside: two Stories embedded by two different models are not comparable, and
 * nothing downstream should be the thing that discovers it. `null` is a state this
 * is designed for rather than a failure — a deployment with no credential forms
 * Stories carrying no embedding, and a caller reads that as no evidence rather
 * than as a vector of zeroes.
 *
 * Nothing here knows about HTTP or about any vendor. That is what lets the
 * contract be a domain type and lets the implementation be swapped for one that
 * reaches a different provider, or none at all.
 */
export interface StoryEmbedding {
  /** The model that produced these values, so a later reader is not guessing. */
  readonly model: string;
  /** The vector itself, in the order the model returned it. */
  readonly values: readonly number[];
}

/**
 * Asks a model what a piece of text means.
 *
 * `null` is narrower than an empty vector and means the call produced nothing to
 * report on at all: no credential, nothing to embed, a call that failed, or a
 * reply that was not the shape asked for. A caller treats it as "this Story
 * carries no embedding" rather than as a failure to recover from — embedding is a
 * second reading, and the Story is formed either way.
 */
export interface EmbeddingProvider {
  embed(text: string): Promise<StoryEmbedding | null>;
}

/**
 * How a vector is written down: little-endian float32, base64, version 1.
 *
 * Recorded in the value itself rather than implied by the column, because the
 * encoding is what a later reader needs and a reader cannot recover it from the
 * bytes. `1` is the version, so a later format is a third segment rather than a
 * value this decoder has to guess at.
 */
export const EMBEDDING_ENCODING = 'f32le:1';

const PREFIX = `${EMBEDDING_ENCODING}:`;

/** A float32 is four bytes, so a value of any other length was not written by us. */
const BYTES_PER_VALUE = 4;

export function encodeEmbedding(embedding: StoryEmbedding): string {
  const values = Float32Array.from(embedding.values);
  return `${PREFIX}${Buffer.from(values.buffer, values.byteOffset, values.byteLength).toString('base64')}`;
}

/**
 * Read a stored vector back, beside the model it was stored with.
 *
 * `null` wherever it cannot be had: absent, unreadable, an encoding this build
 * does not speak, a byte length that is not a whole number of float32s, a value
 * that is not a number, or a model that is missing or blank. Every one of those
 * reads as no embedding rather than as a half-read vector, because a vector
 * truncated to whatever survived would be compared against as though it were the
 * whole reading.
 *
 * The two halves have to arrive together. A vector with nothing saying which
 * model produced it is not evidence about what the Article said, so it is read as
 * absence — which is also what makes the two columns above one value rather than
 * two a caller could hold half of.
 */
export function decodeEmbedding(
  stored: string | null | undefined,
  model: string | null | undefined,
): StoryEmbedding | null {
  const named = model?.trim();
  if (named === undefined || named.length === 0) return null;
  if (!stored?.startsWith(PREFIX)) return null;

  const bytes = Buffer.from(stored.slice(PREFIX.length), 'base64');
  if (bytes.byteLength === 0 || bytes.byteLength % BYTES_PER_VALUE !== 0) return null;

  const values = new Float32Array(bytes.byteLength / BYTES_PER_VALUE);
  Buffer.from(values.buffer).set(bytes);
  for (const value of values) {
    if (!Number.isFinite(value)) return null;
  }
  return { model: named, values: [...values] };
}