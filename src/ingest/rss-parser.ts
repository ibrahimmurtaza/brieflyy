import { stripFeedMetadata } from '../domain/feed-text.js';
import type { RawFeed, RawFeedEntry } from './feed-fetcher.js';

/**
 * The named entities an outlet's prose arrives with.
 *
 * These are the ones feeds actually emit. An entity outside this table is left
 * exactly as written rather than guessed at: `&notanentity;` is more likely to
 * be prose about ampersands than markup, and decoding it to nothing would
 * silently delete a word from a sentence a User is shown.
 */
const NAMED_ENTITIES: Readonly<Record<string, string>> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’',
  ndash: '–', mdash: '—', hellip: '…',
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ',
  copy: '©', reg: '®', trade: '™', deg: '°',
  pound: '£', euro: '€', yen: '¥', cent: '¢',
  sect: '§', para: '¶', middot: '·', bull: '•',
  dagger: '†', permil: '‰', laquo: '«', raquo: '»',
  times: '×', divide: '÷', plusmn: '±', micro: 'µ',
  frac12: '½', frac14: '¼', frac34: '¾',
  sup2: '²', sup3: '³', prime: '′', Prime: '″',
  szlig: 'ß', auml: 'ä', ouml: 'ö', uuml: 'ü',
  Auml: 'Ä', Ouml: 'Ö', Uuml: 'Ü',
  eacute: 'é', egrave: 'è', ecirc: 'ê', agrave: 'à',
  ccedil: 'ç', ntilde: 'ñ',
};

/**
 * The numeric form of an entity, decimal or hex. Out of range and unpaired
 * surrogates are left alone rather than turned into a replacement character,
 * since a string nobody can decode is not improved by guessing at it.
 */
function decodeNumericEntity(digits: string, radix: 10 | 16): string | null {
  const code = radix === 16 ? Number.parseInt(digits, 16) : Number.parseInt(digits, 10);
  if (!Number.isFinite(code) || code < 0x20 || code > 0x10ffff) return null;
  if (code >= 0xd800 && code <= 0xdfff) return null;
  return String.fromCodePoint(code);
}

/**
 * The text of an XML field, as the characters it stands for.
 *
 * A feed is not obliged to escape an ampersand that only looks like markup, and
 * the ones that write typographic prose routinely do not: Scientific American,
 * MarketWatch and The Verge all arrive with `&ldquo;` and `&#8230;` still in
 * them. Decoding only the five XML built-ins left those standing, and they then
 * reached a User verbatim inside a quoted brief — an email containing
 * `&ldquo;` is not prose any outlet wrote.
 *
 * `&amp;` is decoded last, and this is the whole reason the order is fixed: an
 * escaped ampersand is how a feed writes a literal `&`, so `&amp;ldquo;` is the
 * six characters `&ldquo;` and not the character it looks like.
 */
function decodeEntities(s: string): string {
  return s
    // CDATA first: what it wraps is literal text, and an entity inside it is
    // content rather than markup.
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (match, digits: string) =>
      decodeNumericEntity(digits, 16) ?? match,
    )
    .replace(/&#(\d+);/g, (match, digits: string) =>
      decodeNumericEntity(digits, 10) ?? match,
    )
    .replace(/&([a-z][a-z0-9]*);/gi, (match, name: string) => {
      const named = NAMED_ENTITIES[name];
      // `amp` is deliberately not resolved here: doing it here would let a later
      // pass decode text the feed escaped on purpose.
      if (named === undefined || name.toLowerCase() === 'amp') return match;
      return named;
    })
    .replace(/&amp;/g, '&');
}

function trimText(s: string): string {
  return decodeEntities(s).replace(/\s+/g, ' ').trim();
}

function extractTag(xml: string, tag: string): string {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? trimText(m[1] ?? '') : '';
}

function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?</${tag}>`, 'gi');
  return xml.match(re) ?? [];
}

/**
 * An Atom entry puts the link in an attribute rather than in the element body,
 * so `<link>https://…</link>` finds nothing. The `alternate` relation is the
 * article; the self link is the feed's own copy of it.
 */
function extractAtomLink(entry: string): string {
  const alternate =
    /<link\b[^>]*\brel=["']alternate["'][^>]*\bhref=["']([^"']+)["']/i.exec(entry)?.[1] ??
    /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*\brel=["']alternate["']/i.exec(entry)?.[1];
  if (alternate) return trimText(alternate);
  const anyHref = /<link\b[^>]*\bhref=["']([^"']+)["']/i.exec(entry)?.[1];
  if (anyHref) return trimText(anyHref);
  return extractTag(entry, 'link');
}

/** Markup an Atom `content` or `summary` field carries as escaped HTML. */
function stripMarkup(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * The date an item was published, from whichever of the four conventions the
 * feed uses. An item that carries none is dated at the epoch rather than at the
 * moment it was polled: a plausible-looking wrong date is worse than a missing
 * one, because the dedup window and the trends window both read this.
 */
function extractPublishedAt(entry: string): Date {
  const raw =
    extractTag(entry, 'pubDate') ||
    extractTag(entry, 'dc:date') ||
    extractTag(entry, 'published') ||
    extractTag(entry, 'updated');
  if (raw.length === 0) return new Date(0);
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? new Date(0) : parsed;
}

/**
 * Parse a feed into entries.
 *
 * Both dialects are handled because the registry contains both: several outlets
 * answer with RSS 2.0 `<item>` elements and others with Atom `<entry>`
 * elements, and parsing only the first silently produces nothing at all for the
 * second rather than an error anyone would notice.
 */
export function parseRss(xml: string): RawFeed {
  const items = [...extractAll(xml, 'item'), ...extractAll(xml, 'entry')];
  const entries: RawFeedEntry[] = items.map((rawItem): RawFeedEntry => {
    const link = extractAtomLink(rawItem);
    const guid = extractTag(rawItem, 'guid') || extractTag(rawItem, 'id');
    const body =
      extractTag(rawItem, 'description') ||
      extractTag(rawItem, 'summary') ||
      extractTag(rawItem, 'content:encoded') ||
      extractTag(rawItem, 'content');
    return {
      externalId: guid || link,
      url: link,
      title: extractTag(rawItem, 'title'),
      // The description arrives escaped, so it is decoded before the markup is
      // stripped: otherwise the tags survive as text and end up in a summary.
      // And what a feed reports about an item rather than describing it is
      // removed, because this is the text the rest of the pipeline works from —
      // the signature and the Entities are both derived from it, and neither can
      // tell a DOI or a comment count from something an outlet wrote.
      body: stripFeedMetadata(stripMarkup(decodeEntities(body))),
      publishedAt: extractPublishedAt(rawItem),
    };
  });
  return { entries };
}
