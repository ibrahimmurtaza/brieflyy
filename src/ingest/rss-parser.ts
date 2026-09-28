import type { RawFeed, RawFeedEntry } from './feed-fetcher.js';

function decodeEntities(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
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
      body: stripMarkup(decodeEntities(body)),
      publishedAt: extractPublishedAt(rawItem),
    };
  });
  return { entries };
}
