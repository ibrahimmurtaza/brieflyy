import type { FeedFetcher, RawFeed, RawFeedEntry } from './feed-fetcher.js';

export class StaticFeedFetcher implements FeedFetcher {
  constructor(private readonly feed: RawFeed) {}
  async fetch(_url: string): Promise<RawFeed> {
    return this.feed;
  }
}

export function makeEntry(
  externalId: string,
  publishedAt: Date,
  title: string,
  body: string,
  urlPrefix: string,
): RawFeedEntry {
  return {
    externalId,
    url: `${urlPrefix}/${externalId}`,
    title,
    body,
    publishedAt,
  };
}

export const BODY_A =
  'Acme Corp today unveiled a new AI product called Foo, analysts said. The launch changes the landscape for enterprise customers worldwide.';
export const BODY_B =
  'BrandX Inc announced today that it acquired TinyCo for $2B. The deal closed on Tuesday.';