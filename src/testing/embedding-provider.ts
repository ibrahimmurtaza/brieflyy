import type { EmbeddingProvider, StoryEmbedding } from '../domain/embedding.js';

/** The model the double answers under, so a test can assert which model was recorded. */
export const RECORDED_EMBEDDING_MODEL = 'testing/some-embedding-1';

const WIDTH = 8;

/** Sixty-fourths, which a float32 holds exactly — so a round trip loses nothing. */
const STEP = 64;

/**
 * A vector that depends on the text, so a test can tell one Article's embedding
 * from another's.
 *
 * Not a real embedding and not trying to be: what a suite needs from this is to be
 * able to say "the Story carries the vector of the Article that formed it" and
 * "this Story carries that one's, not this one's". A constant would satisfy the
 * first and make the second unanswerable. The values are exact in a float32 so that
 * reading a vector back out of the database is the same vector, which is what lets
 * a formation test assert on the whole value rather than on a tolerance.
 */
export function vectorFor(text: string): StoryEmbedding {
  let sum = 0;
  for (let i = 0; i < text.length; i++) sum += text.charCodeAt(i);
  return {
    model: RECORDED_EMBEDDING_MODEL,
    values: Array.from({ length: WIDTH }, (_unused, index) => ((sum * (index + 1)) % STEP) / STEP),
  };
}

/**
 * The one double for the embedding provider, so a test that cares what formation
 * asked for is not written twice.
 *
 * It records every text it was asked about — a Story embedded twice is invisible
 * in the Story it produced — and answers with whatever the test decides, per call,
 * so one Article can fail to embed while the rest do not. An answer of `undefined`
 * means "the ordinary one", which is how a test gives a single Article a different
 * fate without restating what the others get.
 */
export class RecordingEmbeddingProvider implements EmbeddingProvider {
  readonly asked: string[] = [];

  constructor(
    private readonly answer: (
      text: string,
    ) => StoryEmbedding | null | undefined | Promise<StoryEmbedding | null | undefined> = () => undefined,
  ) {}

  /** How many Articles this run asked about, which is what it cost. */
  get callCount(): number {
    return this.asked.length;
  }

  async embed(text: string): Promise<StoryEmbedding | null> {
    this.asked.push(text);
    const answered = await this.answer(text);
    return answered === undefined ? vectorFor(text) : answered;
  }
}