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
});