import { beforeEach, describe, expect, it } from 'vitest';

import { IngestService } from './ingest-service.js';
import type {
  FeedFetcher,
  RawFeed,
  RawFeedEntry,
} from './feed-fetcher.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { StoryRepo } from '../repos/story-repo.js';
import type { EntityRepo } from '../repos/entity-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type { Source, SourceId } from '../domain/types.js';

class StaticFeedFetcher implements FeedFetcher {
  constructor(private readonly feed: RawFeed) {}
  async fetch(_url: string): Promise<RawFeed> {
    return this.feed;
  }
}

class FailingFeedFetcher implements FeedFetcher {
  constructor(private readonly message: string) {}
  async fetch(): Promise<RawFeed> {
    throw new Error(this.message);
  }
}

function makeEntry(
  externalId: string,
  publishedAt: Date,
  title: string,
  body: string,
): RawFeedEntry {
  return {
    externalId,
    url: `https://www.reuters.com/article/${externalId}`,
    title,
    body,
    publishedAt,
  };
}

const CLUSTER_A_BODY =
  'Acme Corp today unveiled a new AI product called Foo, analysts said. The launch changes the landscape for enterprise customers.';

const CLUSTER_A_ENTRIES: readonly RawFeedEntry[] = [
  makeEntry(
    'a-1',
    new Date('2026-09-02T10:00:00Z'),
    'Acme Corp launches new AI product',
    CLUSTER_A_BODY,
  ),
  makeEntry(
    'a-2',
    new Date('2026-09-02T10:30:00Z'),
    'Acme Corp unveils new AI product',
    CLUSTER_A_BODY,
  ),
  makeEntry(
    'a-3',
    new Date('2026-09-02T11:00:00Z'),
    'Acme Corp announces new AI product',
    CLUSTER_A_BODY,
  ),
  makeEntry(
    'a-4',
    new Date('2026-09-02T11:30:00Z'),
    'Acme Corp debuts new AI product',
    CLUSTER_A_BODY,
  ),
];

const CLUSTER_B_BODY =
  'BrandX Inc announced today that it acquired TinyCo for $2B. The deal closed on Tuesday.';

const CLUSTER_B_ENTRIES: readonly RawFeedEntry[] = [
  makeEntry(
    'b-1',
    new Date('2026-09-02T12:00:00Z'),
    'BrandX Inc acquires TinyCo',
    CLUSTER_B_BODY,
  ),
  makeEntry(
    'b-2',
    new Date('2026-09-02T12:30:00Z'),
    'BrandX Inc completes TinyCo acquisition',
    CLUSTER_B_BODY,
  ),
  makeEntry(
    'b-3',
    new Date('2026-09-02T13:00:00Z'),
    'TinyCo bought by BrandX Inc',
    CLUSTER_B_BODY,
  ),
];

interface BuildResult {
  readonly service: IngestService;
  readonly sourceRepo: SourceRepo;
  readonly articleRepo: ArticleRepo;
  readonly storyRepo: StoryRepo;
  readonly entityRepo: EntityRepo;
  readonly source: Source;
  readonly clock: ReturnType<typeof makeTestClock>;
  readonly replaceFetcher: (f: FeedFetcher) => void;
}

interface BuildInput {
  readonly entries?: RawFeed;
  readonly pollAt?: Date;
  readonly feedUrl?: string | null;
  readonly sourceId?: SourceId;
  readonly fetcher?: FeedFetcher;
}

async function buildService(input: BuildInput): Promise<BuildResult> {
  const { db } = createTestDb();
  const sr = new DrizzleSourceRepo(db);
  const ar = new DrizzleArticleRepo(db);
  const str = new DrizzleStoryRepo(db);
  const er = new DrizzleEntityRepo(db);

  const source: Source = {
    id: input.sourceId ?? ('reuters' as SourceId),
    slug: 'reuters',
    name: 'Reuters',
    homepageUrl: 'https://www.reuters.com',
    feedUrl:
      input.feedUrl === undefined
        ? 'https://www.reuters.com/rss/topNews'
        : input.feedUrl,
    lastPolledAt: null,
    lastSuccessAt: null,
  };
  await sr.insert(source);

  const pollAt = input.pollAt ?? new Date('2026-09-02T12:00:00Z');
  const clock = makeTestClock(pollAt);

  const initialFetcher: FeedFetcher =
    input.fetcher ??
    new StaticFeedFetcher(
      input.entries ?? {
        sourceId: source.id,
        entries: [],
      },
    );

  let activeFetcher: FeedFetcher = initialFetcher;

  const service = new IngestService({
    sourceRepo: sr,
    articleRepo: ar,
    storyRepo: str,
    entityRepo: er,
    feedFetcher: {
      fetch(url: string): Promise<RawFeed> {
        return activeFetcher.fetch(url);
      },
    },
    clock: clock.clock,
    random: deterministicRandom,
  });

  return {
    service,
    sourceRepo: sr,
    articleRepo: ar,
    storyRepo: str,
    entityRepo: er,
    source,
    clock,
    replaceFetcher(f: FeedFetcher): void {
      activeFetcher = f;
    },
  };
}

describe('IngestService', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('merges 20+ near-duplicate syndication articles into a single Story (acceptance criterion)', async () => {
    const syndicationTitle = 'Acme Corp launches new AI product';
    const syndicationBody =
      'Acme Corp today unveiled a new AI product called Foo, analysts said. The launch changes the landscape for enterprise customers worldwide.';
    const variants: RawFeedEntry[] = [];
    const base = new Date('2026-09-02T10:00:00Z');
    for (let i = 0; i < 22; i++) {
      variants.push({
        externalId: `acme-cluster-${i}`,
        url: `https://www.reuters.com/article/acme-cluster-${i}`,
        title: syndicationTitle,
        body: syndicationBody,
        publishedAt: new Date(base.getTime() + i * 60_000),
      });
    }
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: { sourceId: 'reuters', entries: variants },
    });

    const report = await service.ingestSource(source.id);

    expect(report.success).toBe(true);
    expect(report.fetched).toBe(22);
    expect(report.inserted + report.merged).toBe(22);
    expect(report.storiesAffected).toBe(1);

    const seenStoryIds = new Set<string>();
    for (const v of variants) {
      const article = await articleRepo.findByExternalId(
        source.id,
        v.externalId,
      );
      expect(article).not.toBeNull();
      expect(article?.storyId).not.toBeNull();
      if (article?.storyId) seenStoryIds.add(article.storyId);
    }
    expect(seenStoryIds.size).toBe(1);
    const storyId = seenStoryIds.values().next().value as string;
    const story = await storyRepo.getById(storyId as never);
    expect(story?.articleCount).toBe(22);
  });

  it('clusters two distinct stories into separate Stories with correct article counts', async () => {
    const entries = [...CLUSTER_A_ENTRIES, ...CLUSTER_B_ENTRIES];
    const { service, storyRepo, articleRepo, source } = await buildService({
      entries: { sourceId: 'reuters', entries },
    });
    const report = await service.ingestSource(source.id);
    expect(report.success).toBe(true);
    expect(report.storiesAffected).toBe(2);
    expect(report.fetched).toBe(entries.length);
    expect(report.inserted + report.merged).toBe(entries.length);

    const storyIds = new Set<string>();
    for (const e of entries) {
      const a = await articleRepo.findByExternalId(source.id, e.externalId);
      if (a?.storyId) storyIds.add(a.storyId);
    }
    expect(storyIds.size).toBe(2);

    const counts: number[] = [];
    for (const id of storyIds) {
      const articles = await articleRepo.listByStory(id as never);
      counts.push(articles.length);
    }
    expect([...counts].sort()).toEqual([3, 4]);

    for (const id of storyIds) {
      const story = await storyRepo.getById(id as never);
      expect(story).not.toBeNull();
    }
  });

  it('is idempotent: re-ingesting the same feed reports no new merges', async () => {
    const entries = [...CLUSTER_A_ENTRIES, ...CLUSTER_B_ENTRIES];
    const { service, source } = await buildService({
      entries: { sourceId: 'reuters', entries },
    });
    const r1 = await service.ingestSource(source.id);
    expect(r1.inserted + r1.merged).toBe(entries.length);

    const r2 = await service.ingestSource(source.id);
    expect(r2.inserted).toBe(0);
    expect(r2.merged).toBe(0);
    expect(r2.fetched).toBe(entries.length);
  });

  it('skips a source whose feed_url is null', async () => {
    const { service, sourceRepo, source } = await buildService({
      feedUrl: null,
    });
    const report = await service.ingestSource(source.id);
    expect(report.success).toBe(false);
    expect(report.error).toBe('no_feed_url');
    const after = await sourceRepo.getById(source.id);
    expect(after?.lastPolledAt).not.toBeNull();
    expect(after?.lastSuccessAt).toBeNull();
  });

  it('records a fetch error and does not record success', async () => {
    const { service, sourceRepo, source } = await buildService({
      fetcher: new FailingFeedFetcher('upstream 503'),
    });
    const report = await service.ingestSource(source.id);
    expect(report.success).toBe(false);
    expect(report.error).toMatch(/upstream 503/);
    const after = await sourceRepo.getById(source.id);
    expect(after?.lastPolledAt).not.toBeNull();
    expect(after?.lastSuccessAt).toBeNull();
  });

  it('returns a not_found error when the source id is unknown', async () => {
    const { service } = await buildService({});
    const report = await service.ingestSource('no-such-source' as SourceId);
    expect(report.success).toBe(false);
    expect(report.error).toBe('source_not_found');
    expect(report.storiesAffected).toBe(0);
  });

  it('persists the linked entities for each article', async () => {
    const { service, articleRepo, source } = await buildService({
      entries: { sourceId: 'reuters', entries: CLUSTER_A_ENTRIES },
    });
    await service.ingestSource(source.id);

    const sample = await articleRepo.findByExternalId(source.id, 'a-1');
    expect(sample).not.toBeNull();
    expect(sample?.entities.length).toBeGreaterThan(0);
    const names = sample?.entities.map((e) => e.canonicalName) ?? [];
    expect(names).toContain('Acme Corp');

    // Same canonical entity should be reused across articles.
    const sample2 = await articleRepo.findByExternalId(source.id, 'a-2');
    const entityIds = (sample?.entities ?? []).map((e) => e.id).sort();
    const entityIds2 = (sample2?.entities ?? []).map((e) => e.id).sort();
    expect(entityIds).toEqual(entityIds2);
  });

  it('touches the story lastSeenAt when a new article merges into it', async () => {
    const firstEntry = CLUSTER_A_ENTRIES[0]!;
    const secondEntry = CLUSTER_A_ENTRIES[1]!;
    const { service, storyRepo, articleRepo, source, clock, replaceFetcher } =
      await buildService({
        entries: { sourceId: 'reuters', entries: [firstEntry] },
      });
    const t0 = clock.clock.now();
    await service.ingestSource(source.id);

    const initialStoryId = (
      await articleRepo.findByExternalId(source.id, firstEntry.externalId)
    )?.storyId;
    expect(initialStoryId).not.toBeNull();
    const initialStory =
      initialStoryId &&
      (await storyRepo.getById(initialStoryId as never));
    const firstSeen = initialStory?.firstSeenAt;
    expect(firstSeen?.getTime()).toBe(t0.getTime());

    clock.advance(60 * 60 * 1000);
    const t1 = clock.clock.now();
    replaceFetcher(
      new StaticFeedFetcher({
        sourceId: 'reuters',
        entries: [secondEntry],
      }),
    );
    await service.ingestSource(source.id);

    const updated = await storyRepo.getById(initialStoryId as never);
    expect(updated?.lastSeenAt.getTime()).toBe(t1.getTime());
    expect(updated?.firstSeenAt.getTime()).toBe(firstSeen?.getTime());
  });

  it('does not merge articles that fall outside the 72-hour window', async () => {
    const baseEntry = CLUSTER_A_ENTRIES[0]!;
    const t0 = new Date('2026-09-01T10:00:00Z');
    const tPast = new Date('2026-09-02T10:00:00Z');
    const tFuture = t0.getTime() + 5 * 24 * 60 * 60 * 1000;
    const { service, storyRepo, articleRepo, source, replaceFetcher, clock } =
      await buildService({
        entries: {
          sourceId: 'reuters',
          entries: [
            { ...baseEntry, externalId: 'old', publishedAt: t0 },
          ],
        },
        pollAt: tPast,
      });
    await service.ingestSource(source.id);

    const initialStoryId = (
      await articleRepo.findByExternalId(source.id, 'old')
    )?.storyId;
    expect(initialStoryId).not.toBeNull();
    const before = await storyRepo.getById(initialStoryId as never);
    expect(before?.articleCount).toBe(1);

    clock.set(tFuture);
    replaceFetcher(
      new StaticFeedFetcher({
        sourceId: 'reuters',
        entries: [
          { ...baseEntry, externalId: 'new', publishedAt: new Date(tFuture) },
        ],
      }),
    );
    const r2 = await service.ingestSource(source.id);
    expect(r2.success).toBe(true);
    expect(r2.storiesAffected).toBe(1);
    expect(r2.merged).toBe(0);
    expect(r2.inserted).toBe(1);

    const newStoryId = (
      await articleRepo.findByExternalId(source.id, 'new')
    )?.storyId;
    expect(newStoryId).not.toBeNull();
    expect(newStoryId).not.toBe(initialStoryId);

    const old = await storyRepo.getById(initialStoryId as never);
    expect(old?.articleCount).toBe(1);
    const fresh = await storyRepo.getById(newStoryId as never);
    expect(fresh?.articleCount).toBe(1);
  });

  it('merges articles that match fingerprint within the 72-hour window', async () => {
    const baseEntry = CLUSTER_A_ENTRIES[0]!;
    const t0 = new Date('2026-09-01T10:00:00Z');
    const tInside = new Date('2026-09-02T10:00:00Z');
    const tJustInside = t0.getTime() + 71 * 60 * 60 * 1000;
    const { service, storyRepo, articleRepo, source, replaceFetcher, clock } =
      await buildService({
        entries: {
          sourceId: 'reuters',
          entries: [
            { ...baseEntry, externalId: 'first', publishedAt: t0 },
          ],
        },
        pollAt: tInside,
      });
    await service.ingestSource(source.id);
    clock.set(new Date(tJustInside));

    replaceFetcher(
      new StaticFeedFetcher({
        sourceId: 'reuters',
        entries: [
          {
            ...baseEntry,
            externalId: 'second',
            publishedAt: new Date(tJustInside),
          },
        ],
      }),
    );
    const r2 = await service.ingestSource(source.id);
    expect(r2.storiesAffected).toBe(1);
    expect(r2.merged).toBe(1);

    const firstStoryId = (
      await articleRepo.findByExternalId(source.id, 'first')
    )?.storyId;
    const secondStoryId = (
      await articleRepo.findByExternalId(source.id, 'second')
    )?.storyId;
    expect(firstStoryId).toBe(secondStoryId);
    const merged = firstStoryId
      ? await storyRepo.getById(firstStoryId as never)
      : null;
    expect(merged?.articleCount).toBe(2);
  });
});