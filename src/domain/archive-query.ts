/**
 * The Archive's search vocabulary, in one place.
 *
 * Two questions live here because two callers need the same answers and neither
 * should hold its own: what a User typed means to the full-text index, and what
 * the query string on `/archive/search` means to the repository. Both are pure
 * functions of a string, so both are tested without a database or a page.
 */

/**
 * What narrows an Archive search.
 *
 * Every field is optional and absent means "no narrowing", never "no results": a
 * filter nobody set has to be distinguishable from a filter that matched nothing, or
 * the page says "no results" for a User who never asked a question.
 */
export interface ArchiveSearchFilter {
  readonly query?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly source?: string;
  readonly entity?: string;
  readonly topic?: string;
}

/**
 * How many words of a query reach the index.
 *
 * A bound rather than a detail: the expression is rebuilt per word, so a pasted page
 * of text becomes a plan the index has to work out for one request. A page is told
 * the number so a User whose last words were dropped is not left guessing why the
 * first ones matched.
 */
export const MAX_MATCH_TERMS = 8;

/**
 * The words of a search, in the order they were typed, up to the cap.
 *
 * Both the expression and the page's account of what was searched come from here, so
 * the sentence under the results box cannot describe a different query from the one
 * that ran.
 */
export function wordsSearched(text: string): readonly string[] {
  return text
    .split(/[^\p{L}\p{N}_]+/u)
    .filter((word) => word.length > 0)
    .slice(0, MAX_MATCH_TERMS);
}

/** Whether a search had words in it that the cap kept out of the index. */
export function hasDroppedWords(text: string): boolean {
  return wordsSearched(text).length < text.split(/[^\p{L}\p{N}_]+/u).filter((w) => w.length > 0).length;
}

/**
 * The FTS5 expression a User's words become, or null when they are not words.
 *
 * A full-text index is asked for terms, not for substrings, which is the whole
 * point of having one: a query built here cannot match the middle of a word, so
 * "tes" no longer returns everything that mentions Tesla.
 *
 * Every term is quoted, so nothing a User types can be an expression of its own. A
 * pasted line of FTS5 syntax becomes a list of words to look for rather than an
 * instruction to run, and a term that happens to spell `NEAR` is the word `near`.
 *
 * Anded rather than ored, because two words a User typed together is a narrower
 * question than either of them alone, and a result with only one of them is not what
 * they asked for.
 */
export function toFtsMatch(text: string): string | null {
  const terms = wordsSearched(text).map((word) => `"${word}"`);
  return terms.length > 0 ? terms.join(' AND ') : null;
}

/** The first value of a query-string field, as a trimmed string or null. */
function readField(raw: Record<string, unknown>, name: string): string | null {
  const value = raw[name];
  const first = Array.isArray(value) ? value[0] : value;
  if (typeof first !== 'string') return null;
  const trimmed = first.trim();
  return trimmed.length > 0 ? trimmed : null;
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A whole UTC day, or null when the text is not one.
 *
 * The end of a day is the last millisecond of it rather than midnight of the next,
 * so a User who types one date gets everything that happened on it. The round trip
 * through `Date` is what rejects `2026-13-01`: a day SQLite would otherwise have to
 * make up.
 */
function readUtcDay(raw: Record<string, unknown>, name: string, edge: 'start' | 'end'): Date | null {
  const text = readField(raw, name);
  const m = text === null ? null : ISO_DAY.exec(text);
  if (m === null) return null;
  const at = new Date(`${m[1]}-${m[2]}-${m[3]}T${edge === 'start' ? '00:00:00.000' : '23:59:59.999'}Z`);
  if (Number.isNaN(at.getTime())) return null;
  // A date the parts add up to but the calendar does not have — the 30th of
  // February — parses forward into March rather than failing, so it is checked.
  if (at.toISOString().slice(0, 10) !== text) return null;
  return at;
}

/** The three single-value filters, all read the same way. */
const FILTER_NAMES = ['source', 'entity', 'topic'] as const;

/**
 * The filter a query string asks for, with everything unreadable left out.
 *
 * Unreadable is the right answer rather than an error page: the values here arrive
 * in a URL, and a User who mistyped a date should see their Archive rather than a
 * form that refuses to render. Every filter is read rather than the first one
 * recognised, because a User who narrows by date and then by Source has to get both.
 */
export function parseArchiveQuery(raw: Record<string, unknown>): ArchiveSearchFilter {
  const query = readField(raw, 'q');
  const from = readUtcDay(raw, 'from', 'start');
  const to = readUtcDay(raw, 'to', 'end');
  const chosen: Partial<Record<(typeof FILTER_NAMES)[number], string>> = {};
  for (const name of FILTER_NAMES) {
    const value = readField(raw, name);
    if (value !== null) chosen[name] = value;
  }
  return {
    ...(query === null ? {} : { query }),
    ...(from === null ? {} : { from }),
    ...(to === null ? {} : { to }),
    ...chosen,
  };
}

