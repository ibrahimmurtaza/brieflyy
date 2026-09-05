export interface RawFeedEntry {
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly publishedAt: Date;
}

export interface RawFeed {
  readonly entries: readonly RawFeedEntry[];
}

export interface FeedFetcher {
  fetch(feedUrl: string): Promise<RawFeed>;
}