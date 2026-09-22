import type { FeedFetcher, RawFeed, RawFeedEntry } from './feed-fetcher.js';

export class StaticFeedFetcher implements FeedFetcher {
  constructor(private readonly feed: RawFeed) {}
  async fetch(_url: string): Promise<RawFeed> {
    return this.feed;
  }
}

export class FailingFeedFetcher implements FeedFetcher {
  constructor(private readonly message: string) {}
  async fetch(): Promise<RawFeed> {
    throw new Error(this.message);
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

export const CLUSTER_A_BODY =
  'Acme Corp today unveiled a new AI product called Foo, analysts said. The launch changes the landscape for enterprise customers.';

export const CLUSTER_A_ENTRIES: readonly RawFeedEntry[] = [
  makeEntry(
    'a-1',
    new Date('2026-09-02T10:00:00Z'),
    'Acme Corp launches new AI product',
    CLUSTER_A_BODY,
    'https://example.com/feed',
  ),
  makeEntry(
    'a-2',
    new Date('2026-09-02T10:30:00Z'),
    'Acme Corp unveils new AI product',
    CLUSTER_A_BODY,
    'https://example.com/feed',
  ),
  makeEntry(
    'a-3',
    new Date('2026-09-02T11:00:00Z'),
    'Acme Corp announces new AI product',
    CLUSTER_A_BODY,
    'https://example.com/feed',
  ),
  makeEntry(
    'a-4',
    new Date('2026-09-02T11:30:00Z'),
    'Acme Corp debuts new AI product',
    CLUSTER_A_BODY,
    'https://example.com/feed',
  ),
];

export const CLUSTER_B_BODY =
  'BrandX Inc announced today that it acquired TinyCo for $2B. The deal closed on Tuesday.';

export const CLUSTER_B_ENTRIES: readonly RawFeedEntry[] = [
  makeEntry(
    'b-1',
    new Date('2026-09-02T12:00:00Z'),
    'BrandX Inc acquires TinyCo',
    CLUSTER_B_BODY,
    'https://example.com/feed',
  ),
  makeEntry(
    'b-2',
    new Date('2026-09-02T12:30:00Z'),
    'BrandX Inc completes TinyCo acquisition',
    CLUSTER_B_BODY,
    'https://example.com/feed',
  ),
  makeEntry(
    'b-3',
    new Date('2026-09-02T13:00:00Z'),
    'TinyCo bought by BrandX Inc',
    CLUSTER_B_BODY,
    'https://example.com/feed',
  ),
];