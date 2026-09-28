import { describe, expect, it } from 'vitest';

import { parseRss } from './rss-parser.js';

const FIXTURE = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>Reuters Top News</title>
    <link>https://www.reuters.com</link>
    <description>Top news from Reuters</description>
    <item>
      <title>Acme Corp launches new AI product</title>
      <link>https://www.reuters.com/article/acme-ai-1</link>
      <guid isPermaLink="false">reuters-001</guid>
      <pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
      <description>Acme Corp today unveiled a new AI product called Foo. Analysts said it changes the landscape.</description>
    </item>
    <item>
      <title>Reuters syndication: Acme launches AI offering</title>
      <link>https://www.reuters.com/article/acme-ai-2</link>
      <guid isPermaLink="false">reuters-002</guid>
      <pubDate>Mon, 01 Sep 2026 11:30:00 GMT</pubDate>
      <description>A syndicated version of the same Acme Corp story.</description>
    </item>
  </channel>
</rss>`;

describe('parseRss', () => {
  it('parses RSS 2.0 channel items into RawFeedEntries', () => {
    const feed = parseRss(FIXTURE);
    expect(feed.entries).toHaveLength(2);
  });

  it('extracts guid as externalId', () => {
    const feed = parseRss(FIXTURE);
    const ids = feed.entries.map((e) => e.externalId);
    expect(ids).toEqual(['reuters-001', 'reuters-002']);
  });

  it('decodes HTML entities in title and description', () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title>Acme &amp; Co</title><link>https://x/1</link><guid>g1</guid><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><description>Tom &amp; Jerry</description></item></channel></rss>`;
    const feed = parseRss(xml);
    expect(feed.entries[0]?.title).toBe('Acme & Co');
    expect(feed.entries[0]?.body).toBe('Tom & Jerry');
  });

  it('parses pubDate into a Date', () => {
    const feed = parseRss(FIXTURE);
    const ts = feed.entries[0]?.publishedAt.getTime();
    expect(typeof ts).toBe('number');
    expect(ts).toBeGreaterThan(0);
  });

  it('strips CDATA wrappers from fields', () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title><![CDATA[Title in CDATA]]></title><link>https://x/1</link><guid>g1</guid><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate><description><![CDATA[Body in CDATA]]></description></item></channel></rss>`;
    const feed = parseRss(xml);
    expect(feed.entries[0]?.title).toBe('Title in CDATA');
    expect(feed.entries[0]?.body).toBe('Body in CDATA');
  });

  it('returns empty entries for a feed with no items', () => {
    const xml = `<?xml version="1.0"?><rss><channel><title>Empty</title></channel></rss>`;
    const feed = parseRss(xml);
    expect(feed.entries).toEqual([]);
  });

  it('falls back to link when guid is missing', () => {
    const xml = `<?xml version="1.0"?><rss><channel><item><title>T</title><link>https://x/1</link><pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate></item></channel></rss>`;
    const feed = parseRss(xml);
    expect(feed.entries[0]?.externalId).toBe('https://x/1');
  });

  it('reads a dc:date, which is how Nature dates its items', () => {
    const xml = `<?xml version="1.0"?><rss xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><item><title>T</title><link>https://x/1</link><guid>g1</guid><dc:date>2026-09-01T10:00:00Z</dc:date><description>Body</description></item></channel></rss>`;
    const feed = parseRss(xml);
    expect(feed.entries[0]?.publishedAt.toISOString()).toBe('2026-09-01T10:00:00.000Z');
  });

  it('parses an Atom feed, which several outlets serve instead of RSS', () => {
    // The Verge and ZDNet both answer with Atom, so a registry of RSS-only
    // parsing silently ingests nothing from them.
    const xml = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>The Verge</title>
  <entry>
    <title>Acme Corp ships a thing</title>
    <link rel="alternate" href="https://www.theverge.com/2026/9/1/acme"/>
    <id>tag:theverge.com,2026:1</id>
    <published>2026-09-01T10:00:00Z</published>
    <updated>2026-09-01T12:00:00Z</updated>
    <summary>Acme Corp shipped a thing today.</summary>
    <content type="html">&lt;p&gt;Acme Corp shipped a thing today, and people noticed.&lt;/p&gt;</content>
  </entry>
</feed>`;
    const feed = parseRss(xml);
    expect(feed.entries).toHaveLength(1);
    const entry = feed.entries[0]!;
    expect(entry.title).toBe('Acme Corp ships a thing');
    expect(entry.url).toBe('https://www.theverge.com/2026/9/1/acme');
    expect(entry.externalId).toBe('tag:theverge.com,2026:1');
    expect(entry.publishedAt.toISOString()).toBe('2026-09-01T10:00:00.000Z');
    expect(entry.body).toContain('Acme Corp shipped a thing today');
  });

  it('prefers the published date over the updated one', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link href="https://x/1"/><id>i1</id><published>2026-09-01T10:00:00Z</published><updated>2026-09-03T10:00:00Z</updated></entry></feed>`;
    expect(parseRss(xml).entries[0]?.publishedAt.toISOString()).toBe(
      '2026-09-01T10:00:00.000Z',
    );
  });

  it('falls back to updated when a feed gives no published date', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link href="https://x/1"/><id>i1</id><updated>2026-09-03T10:00:00Z</updated></entry></feed>`;
    expect(parseRss(xml).entries[0]?.publishedAt.toISOString()).toBe(
      '2026-09-03T10:00:00.000Z',
    );
  });

  it('strips the markup an Atom content field carries, rather than storing it', () => {
    const xml = `<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link href="https://x/1"/><id>i1</id><published>2026-09-01T10:00:00Z</published><content type="html">&lt;p&gt;Hello &lt;script&gt;alert(1)&lt;/script&gt;&lt;/p&gt;</content></entry></feed>`;
    const body = parseRss(xml).entries[0]!.body;
    expect(body).not.toMatch(/<script/i);
    expect(body).not.toMatch(/</);
    expect(body).toContain('Hello');
  });

  it('marks an entry it cannot date as the epoch rather than as now', () => {
    // A wrong date is worse than a missing one: the dedup window and the trends
    // window both read this, and "now" would quietly age out old items.
    const xml = `<rss><channel><item><title>T</title><link>https://x/1</link><guid>g1</guid><description>Body</description></item></channel></rss>`;
    expect(parseRss(xml).entries[0]?.publishedAt.getTime()).toBe(0);
  });

  it('ignores an entry with nothing to identify it by', () => {
    const xml = `<rss><channel><item><title>No id and no link</title><description>Body</description></item></channel></rss>`;
    const feed = parseRss(xml);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]?.externalId).toBe('');
  });
});