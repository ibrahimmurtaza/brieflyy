import type { Article } from './types.js';

/**
 * A sentence shorter than this is a byline or a fragment rather than a
 * statement, so it is not worth showing a User as a Cluster's one-liner.
 */
const MIN_SENTENCE_CHARS = 24;

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * The sentences in a piece of text, in the order they were written, with the
 * fragments too short to be statements dropped.
 *
 * Extractive on purpose: every sentence here is a span of the Article that is
 * already in the database, so a Cluster cannot invent a claim no Source made.
 */
export function extractSentences(text: string): readonly string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length >= MIN_SENTENCE_CHARS);
}

/**
 * The sentence a Cluster is titled by: the first substantive sentence of its
 * representative Article, or the Article's own title when its body has none.
 *
 * The Article's title is the fallback rather than a name pulled out of the
 * text, because a bare Entity name is not a sentence and reads as a label
 * rather than as what happened.
 */
export function oneLinerFrom(article: Article): string {
  const [first] = extractSentences(article.body);
  return first ?? article.title.trim();
}

/**
 * One statement per Article, drawn in the order the Articles are given, so the
 * caller decides which Articles are the "top" ones. An Article contributes
 * nothing if every statement it has is already on the list, because a Cluster is
 * several Articles saying the same thing and repeating it reads as padding.
 */
export function bulletsFrom(
  articles: readonly Article[],
  limit: number,
  exclude?: string,
): readonly string[] {
  const seen = new Set<string>();
  if (exclude) seen.add(normalize(exclude));
  const out: string[] = [];
  for (const article of articles) {
    if (out.length >= limit) break;
    for (const candidate of statementsOf(article)) {
      const key = normalize(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(candidate);
      // One per Article, so the bullets read as several sources on the same
      // story rather than one source three times.
      break;
    }
  }
  return out;
}

/**
 * What an Article has to offer, best first. The body leads because it has the
 * detail, and the title is the fallback for an Article that is only a headline.
 */
function statementsOf(article: Article): readonly string[] {
  const title = article.title.trim();
  return title.length === 0
    ? extractSentences(article.body)
    : [...extractSentences(article.body), title];
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
