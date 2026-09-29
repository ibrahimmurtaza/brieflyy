import { isStopword } from './stopwords.js';

const WORD = /[A-Za-z][A-Za-z'-]*/g;

function tokenize(text: string): string[] {
  return (text.toLowerCase().match(WORD) ?? []).filter(
    (w) => !isStopword(w),
  );
}

function extractPhrases(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
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
 */
export interface TextSignature {
  readonly words: readonly string[];
  readonly phrases: readonly string[];
}

export function extractSignature(text: string): TextSignature {
  if (text.length === 0) return { words: [], phrases: [] };
  const tokens = tokenize(text);
  return { words: tokens, phrases: extractPhrases(tokens) };
}
