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

  it('stores no body for an entry whose description is only the feed reporting on the item', () => {
    // What hnrss.org serves. It is the feed's own metadata about a link, not
    // anything the outlet wrote about the story, and CONTEXT.md is explicit that
    // this is not a statement a Source made about the story. Stored as text it
    // signs every Hacker News item almost identically and reads "Points: 6 #,
    // Comments: 0" as two names.
    const xml = `<rss><channel><item>
      <title>Parley: Federated, decentralised chat that speaks plain IRC</title>
      <link>https://git.mills.io/prologic/parley</link>
      <guid>49875913</guid>
      <description>Article URL: https://git.mills.io/prologic/parley Comments URL: https://news.ycombinator.com/item?id=49875913 Points: 33 # Comments: 10</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe('');
  });

  it('keeps the link an entry reports in its metadata, which is not in its body', () => {
    // Stripping the metadata must not cost the Article its link: the body's copy
    // is redundant with the <link> element, and a brief that cannot link a
    // quotation asks a reader to take it on trust.
    const xml = `<rss><channel><item>
      <title>Parley</title>
      <link>https://git.mills.io/prologic/parley</link>
      <guid>49875913</guid>
      <description>Article URL: https://git.mills.io/prologic/parley Points: 33</description>
    </item></channel></rss>`;

    const entry = parseRss(xml).entries[0]!;
    expect(entry.url).toBe('https://git.mills.io/prologic/parley');
    expect(entry.externalId).toBe('49875913');
  });

  it('stores the standfirst without the citation header a feed puts in front of it', () => {
    // What nature.com serves: a fixed prefix naming the publication and the DOI,
    // then the real standfirst. Stored whole, the prefix is most of the text, so
    // every Nature Article signs alike.
    const xml = `<rss><channel><item>
      <title>How to respond to hate speech without fuelling it further</title>
      <link>https://www.nature.com/articles/d41586-026-03058-3</link>
      <guid>d41586-026-03058-3</guid>
      <description>Nature, Published online: 02 October 2026; doi:10.1038/d41586-026-03058-3 Psychologist Mirta Galesic discusses an increase in hateful comments online, and the science-backed way to react.</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe(
      'Psychologist Mirta Galesic discusses an increase in hateful comments online, and the science-backed way to react.',
    );
  });

  it('decodes the named and numeric entities an outlet writes its prose with', () => {
    // Scientific American, MarketWatch and The Verge all arrive this way. Left
    // encoded, these strings are quoted back to a User verbatim in a brief, and
    // "&ldquo;" in an email is not prose anybody wrote.
    const xml = `<rss><channel><item>
      <title>T</title><link>https://x/1</link><guid>g1</guid>
      <description>MacArthur &ldquo;genius grant&rdquo; recipient Felipe De Brigard &mdash; the end &#8230;</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe(
      'MacArthur “genius grant” recipient Felipe De Brigard — the end …',
    );
  });

  it('decodes a numeric entity without swallowing the ampersand of a real one', () => {
    const xml = `<rss><channel><item>
      <title>T</title><link>https://x/1</link><guid>g1</guid>
      <description>Revenue rose &amp; fell &#8212; Tom &amp; Jerry</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe('Revenue rose & fell — Tom & Jerry');
  });

  it('stores no trailing "Continue reading" marker a feed appends to a truncated item', () => {
    // What theguardian.com puts at the end of every item on its world and
    // environment feeds — seventy of the Articles in one day's ingest. It is a
    // link to the rest of the article, not a sentence the paper wrote, so it
    // named an Entity called `Continue` and it was quoted back to a User as the
    // tail of a brief's one-liner.
    const xml = `<rss><channel><item>
      <title>Libyan unity talks upended</title><link>https://x/1</link><guid>g1</guid>
      <description>The deputy commander has been seen by the US as an important figure. Continue reading...</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe(
      'The deputy commander has been seen by the US as an important figure.',
    );
  });

  it('keeps a sentence that merely says someone will continue reading', () => {
    const xml = `<rss><channel><item>
      <title>T</title><link>https://x/1</link><guid>g1</guid>
      <description>She said she would continue reading the report aloud to the committee.</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe(
      'She said she would continue reading the report aloud to the committee.',
    );
  });

  it('stores no newsletter promotion even when something follows it', () => {
    // The promotion is not always last: a correction notice appended after it
    // leaves the marker mid-text, and it is the correction that is the
    // publication's own statement about the story.
    const xml = `<rss><channel><item>
      <title>The NY governor race pollster scrum</title><link>https://x/1</link><guid>g1</guid>
      <description>A rare turnout is expected. Missed this morning’s New York Playbook? We forgive you. Read it here . CORRECTION: This newsletter has been updated to accurately reflect the funding figure.</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe(
      'A rare turnout is expected. CORRECTION: This newsletter has been updated to accurately reflect the funding figure.',
    );
  });

  it('stores no trailing "first appeared on" attribution a feed appends', () => {
    // What quantamagazine.org appends to every item. It repeats the Article's
    // own headline inside its body, so the headline was counted twice in the
    // signature and six words of publisher furniture were signed as though the
    // story were about Quanta Magazine.
    const xml = `<rss><channel><item>
      <title>Gravity Seems Holographic. What Does That Mean for Reality?</title>
      <link>https://x/1</link><guid>g1</guid>
      <description>The biggest breakthrough in modern theoretical physics is the discovery that gravity can collapse the dimensions of space. The post Gravity Seems Holographic. What Does That Mean for Reality? first appeared on Quanta Magazine</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe(
      'The biggest breakthrough in modern theoretical physics is the discovery that gravity can collapse the dimensions of space.',
    );
  });

  it('stores no trailing newsletter promotion a feed appends to an item', () => {
    const xml = `<rss><channel><item>
      <title>New York grapples with kinks in $1B Medicaid system</title>
      <link>https://x/1</link><guid>g1</guid>
      <description>The administration unveiled 12 districts where housing will be fast-tracked. ( POLITICO Pro ) Missed this morning’s New York Playbook? We forgive you. Read it here .</description>
    </item></channel></rss>`;

    expect(parseRss(xml).entries[0]?.body).toBe(
      'The administration unveiled 12 districts where housing will be fast-tracked. ( POLITICO Pro )',
    );
  });
});