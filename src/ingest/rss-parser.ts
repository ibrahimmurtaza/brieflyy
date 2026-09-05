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
  const re = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, 'i');
  const m = xml.match(re);
  return m ? trimText(m[1] ?? '') : '';
}

function extractAll(xml: string, tag: string): string[] {
  const re = new RegExp(`<${tag}[^>]*>[\\s\\S]*?</${tag}>`, 'gi');
  return xml.match(re) ?? [];
}

export function parseRss(xml: string): RawFeed {
  const items = extractAll(xml, 'item');
  const entries: RawFeedEntry[] = items.map((rawItem): RawFeedEntry => {
    const guid = extractTag(rawItem, 'guid') || extractTag(rawItem, 'link');
    const link = extractTag(rawItem, 'link');
    const title = extractTag(rawItem, 'title');
    const description = extractTag(rawItem, 'description');
    const pubDate = extractTag(rawItem, 'pubDate');
    return {
      externalId: guid || link,
      url: link,
      title,
      body: description,
      publishedAt: pubDate.length > 0 ? new Date(pubDate) : new Date(0),
    };
  });
  return { entries };
}