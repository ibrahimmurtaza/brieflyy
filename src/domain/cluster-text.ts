import { stripFeedMetadata } from './feed-text.js';
import type { Article } from './types.js';

/**
 * A sentence shorter than this is a byline or a fragment rather than a
 * statement, so it is not worth showing a User as a Cluster's one-liner.
 */
const MIN_SENTENCE_CHARS = 24;

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * The part of a sentence that is actually a statement.
 *
 * Feed metadata is removed and what is left has to be long enough to be a
 * sentence. A sentence that was nothing but metadata has nothing left, so it is
 * not a statement at all — which is what lets the callers fall back to the
 * Article's title rather than showing a User a URL as though it were news.
 *
 * The cut itself lives in `feed-text.ts` and is shared with the parser, because
 * this was where it used to live alone. That is not a tidiness point: the
 * parser is what decides what an Article's text *is*, so a cut implemented only
 * here protected every quoted sentence and left the signature and the Entities
 * reading a DOI and a comment count as though an outlet had written them.
 */
function statementOf(sentence: string): string {
  return stripFeedMetadata(sentence);
}

/**
 * The sentences in a piece of text, in the order they were written, with the
 * fragments too short to be statements dropped.
 *
 * Extractive on purpose: every sentence here is a span of the Article that is
 * already in the database, so a Cluster cannot invent a claim no Source made.
 * A feed's own metadata about an item is not a claim the Source made about the
 * story, so it is not quoted back either.
 */
export function extractSentences(text: string): readonly string[] {
  return text
    .split(SENTENCE_SPLIT)
    .map((s) => statementOf(s.trim()))
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

/**
 * The link to an Article that printed a stored statement, or null.
 *
 * A Cluster's bullets are stored as bare text: one sentence, no origin. That is
 * right for the text, which is a verbatim span of an Article and therefore needs
 * no attribution to be honest, and wrong for a surface that can link — a brief
 * that quotes a Source without linking to it asks a reader to trust that the
 * quotation is real.
 *
 * The statement is matched against the same statements `bulletsFrom` drew from,
 * so the answer is a lookup rather than a guess: the sentence was produced from
 * one of these Articles by the function above and is compared, normalised, to the
 * very strings that function would produce. One Article can answer for several
 * of its own sentences.
 *
 * When several Articles print the same sentence — which is the normal case and
 * not an edge case, since a wire story is republished under several bylines —
 * the first of them is the one returned. Which Article a bullet was originally
 * drawn from is not recoverable from the sentence: `bulletsFrom` ranked by
 * velocity and recency at formation time, and those are inputs this function
 * does not have. So the claim this supports is the weaker one that is still
 * true — a Source that printed the quoted sentence — rather than the stronger one
 * a reader might assume, which is that it is the outlet that led the story.
 *
 * Null is a real answer and means "do not link this". A statement none of the
 * Articles contains came from somewhere this function cannot see, and an Article
 * the feed gave no usable link to has nothing to point at; in both cases naming
 * an Article anyway would attribute a quotation to an outlet that did not print
 * it, which is the one thing a brief quoting Sources must not do.
 */
export function articleUrlForStatement(
  statement: string,
  articles: readonly Article[],
): string | null {
  const wanted = normalize(statement);
  if (wanted.length === 0) return null;
  for (const article of articles) {
    if (article.url.length === 0) continue;
    if (statementsOf(article).some((candidate) => normalize(candidate) === wanted)) {
      return article.url;
    }
  }
  return null;
}

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
