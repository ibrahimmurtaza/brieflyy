import type { Article } from './types.js';

/**
 * A sentence shorter than this is a byline or a fragment rather than a
 * statement, so it is not worth showing a User as a Cluster's one-liner.
 */
const MIN_SENTENCE_CHARS = 24;

const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

/**
 * A citation header a feed puts in front of the text it does have.
 *
 * Some feeds prepend the publication's own details to the only text they
 * offer, so an Article arrives reading "Nature, Published online: 28 September
 * 2026; doi:10.1038/... China tests these therapies faster than the rest of
 * the world." Nothing in prose contains `doi:`, which is what makes it a safe
 * place to cut: the boundary is the feed's, not a guess about the sentence.
 */
const CITATION_HEADER = /^\s*[^\n]{0,200}?doi:\S+\s*/i;

/**
 * A "Label: value" run whose value is a link or a bare number.
 *
 * A feed with no description reports on the item instead of describing it, and
 * what it produces reads "Article URL: <link> Comments URL: <link> Points: 33
 * # Comments: 10". Cutting the runs leaves nothing but connective text, which
 * is how such a sentence is recognised. The label has to be capitalised and the
 * value has to be a link or a number, so a sentence that merely contains a
 * colon mid-claim is left alone.
 */
const LABEL_VALUE_RUN =
  /\b[A-Z][A-Za-z ]{0,24}:[ \t]*(?:https?:\/\/\S*|\d[\d,.]*)[ \t]*(?:#)?[ \t]*/g;

const URL = /https?:\/\/\S+/g;

/**
 * The part of a sentence that is actually a statement.
 *
 * Feed metadata is removed and what is left has to be long enough to be a
 * sentence. A sentence that was nothing but metadata has nothing left, so it is
 * not a statement at all — which is what lets the callers fall back to the
 * Article's title rather than showing a User a URL as though it were news.
 *
 * The two cuts are measured against the 1,098 sentences a day's ingest produced
 * across 20 Sources: they remove all 34 Hacker News metadata blobs and one
 * Nature line that was nothing but a citation, and no real prose from any
 * Source.
 */
function statementOf(sentence: string): string {
  return sentence
    .replace(CITATION_HEADER, '')
    .replace(LABEL_VALUE_RUN, ' ')
    .replace(URL, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function normalize(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}
