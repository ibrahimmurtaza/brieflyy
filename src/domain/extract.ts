import { isStopword } from './stopwords.js';

const WORD = /[A-Za-z][A-Za-z'-]*/g;

/**
 * Where one sentence ends and the next begins.
 *
 * A full stop, an exclamation or a question mark followed by space, or a line
 * break. The same rule `cluster-text.ts` splits a body with, so a phrase is only
 * ever drawn from a stretch of text that is one statement.
 */
const SENTENCE_SPLIT = /(?<=[.!?])\s+|\n+/;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter(
    (w) => !isStopword(w),
  );
}

/**
 * The phrases inside one stretch of text.
 *
 * Bounded by the sentence rather than run over the whole Article, because a
 * window taken across a sentence boundary is a phrase nobody wrote: the last
 * words of one sentence joined to the first words of the next are evidence of
 * nothing, and they count for as much against a threshold as a phrase that was.
 * A syndication pass also breaks sentences in a different place from the copy
 * it is rewriting, so a straddling phrase is one of the first things a genuine
 * rewrite loses — and losing it is what keeps a real copy matching its original.
 */
function extractPhrases(
  tokens: readonly string[],
  seen: Set<string>,
): string[] {
  const out: string[] = [];
  for (let start = 0; start < tokens.length; start++) {
    for (let len = 2; len <= 3; len++) {
      const end = start + len;
      if (end > tokens.length) break;
      const phrase = tokens.slice(start, end).join(' ');
      if (seen.has(phrase)) continue;
      seen.add(phrase);
      out.push(phrase);
    }
  }
  return out;
}

/**
 * The words of a text, alongside its key phrases.
 *
 * The phrases carry word order, so they are what tells two different reports
 * about the same company apart. On their own they are also brittle under a
 * syndication pass, which reorders clauses and swaps synonyms, and a phrase set
 * alone would score two genuine rewrites of one story barely above two
 * unrelated articles. The words are what survives the rewriting, so a signature
 * carries both and the comparison reads them together.
 *
 * The two are also gathered at different grains, and deliberately: the words are
 * the whole text, because a rewrite replaces a sentence here and there and the
 * rest of the Article still counts; the phrases are per sentence, because a
 * phrase only means anything within the sentence it was written in.
 */
export interface TextSignature {
  readonly words: readonly string[];
  readonly phrases: readonly string[];
}

export function extractSignature(text: string): TextSignature {
  if (text.length === 0) return { words: [], phrases: [] };
  const words: string[] = [];
  // Shared across the whole text, so a phrase an Article uses in two sentences
  // is one phrase rather than two. Only the windows are per-sentence.
  const seen = new Set<string>();
  const phrases: string[] = [];
  for (const sentence of text.split(SENTENCE_SPLIT)) {
    const tokens = tokenize(sentence);
    words.push(...tokens);
    phrases.push(...extractPhrases(tokens, seen));
  }
  return { words, phrases };
}
