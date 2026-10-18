/**
 * Entity identity: what one name resolves to among the names already stored.
 *
 * The name an outlet wrote is only the form it used; the key is what identity is
 * decided on. Case, punctuation, a leading article, a connective inside the name
 * and a legal form are all things two outlets write differently about one name,
 * so none of them is part of what the name identifies.
 *
 * Pure: no database, no clock. Both callers — the entity repo at ingest time and
 * the boot-time migration — decide identity here rather than each writing the
 * choice out, because a boot that disagreed with ingest would leave the stored
 * shape depending on when the database was last started.
 */

import {
  DEMONYMS,
  FEED_FURNITURE,
  GIVEN_NAMES,
  GENERIC_HEAD_NOUNS,
  INNER_WORDS,
  LEADING_QUALIFIERS,
  LEGAL_SUFFIXES,
  NOISE_WORDS,
  PUBLISHER_NAMES,
} from './entity-lexicons.js';

const SENTENCE_SPLIT = /(?<=[.!?])\s+|(?<=.{40,})\n/;
const WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
const POSSESSIVE = /(?:['’]s|s')$/;
const ALLCAPS = /^[A-Z0-9&.]+$/;

const MIN_PARTIAL_NAME_CHARS = 3;

/**
 * The outcome of resolving one candidate key against the keys already stored.
 */
export type IdentityResolution =
  | { readonly kind: 'exact'; readonly key: string }
  | { readonly kind: 'takeover'; readonly key: string; readonly partialKey: string }
  | { readonly kind: 'fuller'; readonly key: string }
  | { readonly kind: 'new'; readonly key: string };

/**
 * How a candidate key resolves against the keys already stored.
 *
 * `exact`: a row keyed exactly this way already stands — return it.
 * `takeover`: the candidate is the fuller name of a stored partial row; re-key
 *   that row to the candidate's key.
 * `fuller`: the candidate is a partial name of a stored fuller name; resolve to
 *   the tightest fuller one.
 * `new`: nothing stored matches; insert a new row keyed by the candidate.
 */
export function resolveIdentity(
  candidateKey: string,
  storedKeys: readonly string[],
): IdentityResolution {
  if (storedKeys.includes(candidateKey)) {
    return { kind: 'exact', key: candidateKey };
  }

  for (const stored of storedKeys) {
    if (isPartialName(stored) && isFullerNameFor(candidateKey, stored)) {
      return { kind: 'takeover', key: candidateKey, partialKey: stored };
    }
  }

  if (isPartialName(candidateKey)) {
    const fuller = theOnlyFullerName(storedKeys, candidateKey);
    if (fuller !== undefined) {
      return { kind: 'fuller', key: fuller };
    }
  }

  return { kind: 'new', key: candidateKey };
}

export function canonicalEntityKey(name: string): string {
  let words = name
    .toLowerCase()
    .replace(/['’]s\b/g, ' ')
    .replace(/\.(?=[a-z])/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !INNER_WORDS.has(w));
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] ?? '')) {
    words.pop();
  }
  while (words.length > 1 && LEADING_QUALIFIERS.has(words[0] ?? '')) {
    words.shift();
  }
  if (words.length > 1) {
    words = words.map((word) => DEMONYMS.get(word) ?? word);
  }
  return words.join(' ');
}

export function namesNothing(name: string): boolean {
  return namesNothingUnder(canonicalEntityKey(name));
}

function namesNothingUnder(key: string): boolean {
  if (key.length === 0) return true;
  if (PUBLISHER_NAMES.has(key) || FEED_FURNITURE.has(key)) return true;
  const words = key.split(' ');
  if (words.every(isFurnitureWord)) return true;
  if (words.length > 1) return false;
  return GENERIC_HEAD_NOUNS.has(words[0] ?? '');
}

function isFurnitureWord(word: string): boolean {
  return PUBLISHER_NAMES.has(word) || FEED_FURNITURE.has(word);
}

export function isPartialName(key: string): boolean {
  if (key.length < MIN_PARTIAL_NAME_CHARS || key.includes(' ')) return false;
  return !namesNothingUnder(key) && !NOISE_WORDS.has(key);
}

export function isFullerNameFor(longer: string, shorter: string): boolean {
  if (longer.length <= shorter.length || !longer.endsWith(` ${shorter}`)) return false;
  const words = longer.split(' ');
  return words.length === 2 && GIVEN_NAMES.has(words[0] ?? '');
}

export function theOnlyFullerName(
  candidates: readonly string[],
  partial: string,
): string | undefined {
  const carries = candidates.filter((key) => isFullerNameFor(key, partial));
  if (carries.length === 0) return undefined;
  const shortest = Math.min(...carries.map((key) => key.split(' ').length));
  const tightest = carries.filter((key) => key.split(' ').length === shortest);
  return tightest.length === 1 ? tightest[0] : undefined;
}
