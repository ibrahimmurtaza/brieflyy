/**
 * How two Articles are judged to be the same Story.
 *
 * A Story used to be identified by a hash of every key phrase in an Article, so
 * a syndication pass that changed a single word produced a different hash and a
 * second Story for the same event. The identity is now the signature itself,
 * stored rather than hashed, and two Articles are the same Story when enough of
 * their signatures agree.
 *
 * The signature carries the Article's words and its key phrases because the two
 * fail in opposite directions. Words survive rewriting and cannot tell two
 * reports about the same company apart; phrases carry the order that does tell
 * them apart, and are the first thing a rewrite breaks. Similarity is a weighted
 * blend of the two, so a Story is recognised by both what it is about and how it
 * is put together.
 */

export interface StorySignature {
  /** Content words, lowercased. */
  readonly words: readonly string[];
  /** Two- and three-word key phrases, lowercased. */
  readonly phrases: readonly string[];
}

/** A signature with nothing in it: the shape an unreadable stored value gets. */
export const EMPTY_SIGNATURE: StorySignature = { words: [], phrases: [] };

/**
 * How much of two signatures has to agree before two Articles are one Story.
 *
 * Measured on the wire-copy fixtures in `src/testing/story-fixtures.ts`: two
 * rewrites of the same story never score below 0.20, and two reports about
 * different things never score above 0.10 — including two different reports
 * about the same company, which is the case a looser reading would get wrong.
 * This sits between the two, closer to the middle than to either edge, so a copy
 * that drifts a little either way still lands on the right side.
 *
 * It is a property of these two sets of text, not of every set of text, and it
 * should move if the fixtures do: the test beside it re-measures both sides and
 * fails if either margin closes.
 */
export const STORY_MATCH_THRESHOLD = 0.15;

/**
 * How much of the score comes from the words rather than the phrases. The words
 * carry the recall and the phrases the precision, and the words need the larger
 * share because they are what a rewrite leaves alone.
 */
const WORD_WEIGHT = 0.6;

function normalizeToken(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeAll(values: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    const normalized = normalizeToken(value);
    if (normalized.length > 0) seen.add(normalized);
  }
  return [...seen].sort();
}

export function normalizeSignature(signature: {
  readonly words: readonly string[];
  readonly phrases: readonly string[];
}): StorySignature {
  return {
    words: normalizeAll(signature.words),
    phrases: normalizeAll(signature.phrases),
  };
}

export function encodeSignature(signature: StorySignature): string {
  return JSON.stringify({
    words: signature.words,
    phrases: signature.phrases,
  });
}

/**
 * Read a stored signature back. An absent or unreadable value is an empty
 * signature rather than a failure: a signature is a cache of what the Article's
 * text says, and a database written before the column existed is not a reason to
 * stop reading Articles out of it.
 */
export function decodeSignature(stored: string | null | undefined): StorySignature {
  if (!stored) return EMPTY_SIGNATURE;
  try {
    const parsed: unknown = JSON.parse(stored);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY_SIGNATURE;
    const record = parsed as { words?: unknown; phrases?: unknown };
    const asList = (value: unknown): readonly string[] =>
      Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
    return normalizeSignature({
      words: asList(record.words),
      phrases: asList(record.phrases),
    });
  } catch {
    return EMPTY_SIGNATURE;
  }
}

/** The share of `a` that `b` also contains, as a number from 0 to 1. */
function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  for (const value of a) {
    if (b.has(value)) shared += 1;
  }
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

export function signatureSimilarity(a: StorySignature, b: StorySignature): number {
  const words = jaccard(new Set(a.words), new Set(b.words));
  const phrases = jaccard(new Set(a.phrases), new Set(b.phrases));
  return WORD_WEIGHT * words + (1 - WORD_WEIGHT) * phrases;
}

export function isSameStory(a: StorySignature, b: StorySignature): boolean {
  return signatureSimilarity(a, b) >= STORY_MATCH_THRESHOLD;
}

export interface StoryCandidate {
  readonly signature: StorySignature;
  /**
   * When the Story's newest Article was published, used to break a tie. Read
   * off the Story's published range rather than passed separately, so a caller
   * cannot offer a candidate with a recency that disagrees with its range.
   */
  readonly published: { readonly last: Date };
}

/**
 * The Story an incoming Article belongs to: the closest one above the threshold,
 * or nothing at all.
 *
 * A tie goes to the more recent Story, because two Stories an Article matches
 * equally well are one current event and one that is still being written up, and
 * the current one is the one it belongs to.
 */
export function bestStoryMatch<T extends StoryCandidate>(
  candidates: readonly T[],
  incoming: StorySignature,
): T | null {
  let best: T | null = null;
  let bestScore = -1;
  for (const candidate of candidates) {
    const score = signatureSimilarity(incoming, candidate.signature);
    if (score < STORY_MATCH_THRESHOLD) continue;
    if (
      score > bestScore ||
      (score === bestScore &&
        (best === null ||
          candidate.published.last.getTime() > best.published.last.getTime()))
    ) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}
