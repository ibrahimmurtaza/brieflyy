import type { HttpClient, HttpResponse } from './http-client.js';
import { parseRss } from './rss-parser.js';
import type { FeedFetcher, RawFeed } from './feed-fetcher.js';

export interface HttpFeedFetcherDeps {
  readonly http: HttpClient;
}

export class HttpFeedFetcher implements FeedFetcher {
  constructor(private readonly deps: HttpFeedFetcherDeps) {}

  async fetch(feedUrl: string): Promise<RawFeed> {
    const res = await this.deps.http.get(feedUrl);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`HttpFeedFetcher: ${feedUrl} returned status ${res.status}`);
    }
    return parseRss(res.body);
  }
}