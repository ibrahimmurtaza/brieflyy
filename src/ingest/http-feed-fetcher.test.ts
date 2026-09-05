import { describe, expect, it } from 'vitest';

import { HttpFeedFetcher } from './http-feed-fetcher.js';
import type { HttpClient, HttpResponse } from './http-client.js';

class FakeHttp implements HttpClient {
  readonly calls: string[] = [];
  constructor(private readonly byUrl: Record<string, HttpResponse>) {}

  async get(url: string): Promise<HttpResponse> {
    this.calls.push(url);
    const res = this.byUrl[url];
    if (!res) {
      throw new Error(`FakeHttp: no canned response for ${url}`);
    }
    return res;
  }
}

const RSS = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>Reuters</title>
  <item>
    <title>Headline A</title><link>https://x/a</link><guid>a</guid>
    <pubDate>Mon, 01 Sep 2026 10:00:00 GMT</pubDate>
    <description>Body A</description>
  </item>
</channel></rss>`;

describe('HttpFeedFetcher', () => {
  it('fetches an RSS body via the injected HttpClient and parses it', async () => {
    const http = new FakeHttp({
      'https://www.reuters.com/rss/topNews': { status: 200, body: RSS },
    });
    const fetcher = new HttpFeedFetcher({ http });
    const feed = await fetcher.fetch('https://www.reuters.com/rss/topNews');
    expect(http.calls).toEqual(['https://www.reuters.com/rss/topNews']);
    expect(feed.entries).toHaveLength(1);
    expect(feed.entries[0]?.title).toBe('Headline A');
  });

  it('throws when the upstream returns a non-2xx status', async () => {
    const http = new FakeHttp({
      'https://x/y': { status: 503, body: '' },
    });
    const fetcher = new HttpFeedFetcher({ http });
    await expect(fetcher.fetch('https://x/y')).rejects.toThrow(/503/);
  });
});