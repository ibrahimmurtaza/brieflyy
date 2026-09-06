import { beforeEach, describe, expect, it } from 'vitest';

import { IngestService } from './ingest-service.js';
import { RegistryIngestService } from './registry-ingest-service.js';
import type {
  FeedFetcher,
  RawFeed,
  RawFeedEntry,
} from './feed-fetcher.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import type {
  Source,
  TopicCategory,
  TopicId,
  UserId,
} from '../domain/types.js';

class StaticFeedFetcher implements FeedFetcher {
  constructor(private readonly feed: RawFeed) {}
  async fetch(_url: string): Promise<RawFeed> {
    return this.feed;
  }
}

function makeEntry(
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

const BODY_A =
  'Acme Corp today unveiled a new AI product called Foo, analysts said. The launch changes the landscape for enterprise customers worldwide.';
const BODY_B =
  'BrandX Inc announced today that it acquired TinyCo for $2B. The deal closed on Tuesday.';

interface BuildInput {
  readonly reutersEntries?: readonly RawFeedEntry[];
  readonly guardianEntries?: readonly RawFeedEntry[];
  readonly pollAt?: Date;
  readonly failingUrl?: string | null;
}

interface BuildResult {
  readonly registry: RegistryIngestService;
  readonly topicRepo: DrizzleTopicRepo;
  readonly sourceRepo: DrizzleSourceRepo;
  readonly articleRepo: DrizzleArticleRepo;
  readonly storyRepo: DrizzleStoryRepo;
  readonly userRepo: DrizzleUserRepo;
  readonly reuters: Source;
  readonly guardian: Source;
  readonly setFetcher: (f: FeedFetcher) => void;
  readonly clock: ReturnType<typeof makeTestClock>;
}

async function buildService(opts: BuildInput = {}): Promise<BuildResult> {
  const { db } = createTestDb();
  const sourceRepo = new DrizzleSourceRepo(db);
  const articleRepo = new DrizzleArticleRepo(db);
  const storyRepo = new DrizzleStoryRepo(db);
  const entityRepo = new DrizzleEntityRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const userRepo = new DrizzleUserRepo(db);

  const reuters: Source = {
    id: 'reuters',
    slug: 'reuters',
    name: 'Reuters',
    homepageUrl: 'https://www.reuters.com',
    feedUrl: 'https://www.reuters.com/rss/topNews',
    lastPolledAt: null,
    lastSuccessAt: null,
  };
  const guardian: Source = {
    id: 'the-guardian',
    slug: 'the-guardian',
    name: 'The Guardian',
    homepageUrl: 'https://www.theguardian.com',
    feedUrl: 'https://www.theguardian.com/rss',
    lastPolledAt: null,
    lastSuccessAt: null,
  };
  await sourceRepo.insert(reuters);
  await sourceRepo.insert(guardian);

  const pollAt = opts.pollAt ?? new Date('2026-09-02T12:00:00Z');
  const clock = makeTestClock(pollAt);

  const reutersEntries: readonly RawFeedEntry[] = opts.reutersEntries ?? [
    makeEntry(
      'r-1',
      new Date('2026-09-02T10:00:00Z'),
      'Acme Corp launches new AI product',
      BODY_A,
      'https://www.reuters.com/article',
    ),
  ];
  const guardianEntries: readonly RawFeedEntry[] = opts.guardianEntries ?? [
    makeEntry(
      'g-1',
      new Date('2026-09-02T11:00:00Z'),
      'BrandX acquires TinyCo',
      BODY_B,
      'https://www.theguardian.com/article',
    ),
  ];

  let activeFetcher: FeedFetcher = new StaticFeedFetcher({
    sourceId: 'reuters',
    entries: reutersEntries,
  });

  const ingest = new IngestService({
    sourceRepo,
    articleRepo,
    storyRepo,
    entityRepo,
    feedFetcher: {
      fetch(url: string): Promise<RawFeed> {
        if (opts.failingUrl === url) {
          return Promise.reject(new Error('upstream 503'));
        }
        if (url === guardian.feedUrl) {
          return new StaticFeedFetcher({
            sourceId: 'the-guardian',
            entries: guardianEntries,
          }).fetch(url);
        }
        return activeFetcher.fetch(url);
      },
    },
    clock: clock.clock,
    random: deterministicRandom,
  });

  let cycleCounter = 0;
  const registry = new RegistryIngestService({
    ingest,
    topicRepo,
    articleRepo,
    storyRepo,
    clock: clock.clock,
    cycleIdFn: () => {
      cycleCounter++;
      return `cycle-${cycleCounter}`;
    },
  });

  return {
    registry,
    topicRepo,
    sourceRepo,
    articleRepo,
    storyRepo,
    userRepo,
    reuters,
    guardian,
    clock,
    setFetcher(f: FeedFetcher): void {
      activeFetcher = f;
    },
  };
}

async function insertTopicWithSources(
  topicRepo: DrizzleTopicRepo,
  userRepo: DrizzleUserRepo,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly sourceIds: readonly string[];
  },
): Promise<TopicId> {
  await userRepo.insert({
    id: input.userId as UserId,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    onboardingState: 'topics_picked',
  });
  await topicRepo.insert({
    id: input.id as TopicId,
    userId: input.userId as UserId,
    slug: input.id,
    title: `Topic ${input.id}`,
    blurb: '',
    category: 'news' as TopicCategory,
    origin: { kind: 'freeform' },
    sourceIds: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
  });
  for (let i = 0; i < input.sourceIds.length; i++) {
    await topicRepo.insertTopicSource(
      input.id as TopicId,
      input.sourceIds[i]!,
      i,
    );
  }
  return input.id as TopicId;
}

describe('RegistryIngestService', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('ingests every source from the union of all topics\' source lists', async () => {
    const { registry, topicRepo, userRepo } = await buildService({});
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-news',
      userId: 'user-a',
      sourceIds: ['reuters'],
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-uk',
      userId: 'user-b',
      sourceIds: ['the-guardian'],
    });

    const report = await registry.ingestOnce();

    expect(report.sources).toHaveLength(2);
    expect(report.totals.inserted + report.totals.merged).toBe(2);
    expect(report.totals.failures).toBe(0);
    const sourceIds = report.sources.map((r) => r.sourceId).sort();
    expect(sourceIds).toEqual(['reuters', 'the-guardian']);
  });

  it('dedupes sources shared across multiple topics', async () => {
    const { registry, topicRepo, userRepo } = await buildService({
      guardianEntries: [],
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-a',
      userId: 'user-a',
      sourceIds: ['reuters'],
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-b',
      userId: 'user-b',
      sourceIds: ['reuters'],
    });

    const report = await registry.ingestOnce();
    expect(report.sources).toHaveLength(1);
    expect(report.sources[0]?.sourceId).toBe('reuters');
    expect(report.totals.inserted + report.totals.merged).toBe(1);
  });

  it('returns an empty cycle report when there are no topics', async () => {
    const { registry } = await buildService({});
    const report = await registry.ingestOnce();
    expect(report.sources).toEqual([]);
    expect(report.totals).toEqual({
      fetched: 0,
      inserted: 0,
      merged: 0,
      storiesAffected: 0,
      failures: 0,
    });
  });

  it('picks up edits to a topic\'s source list on the next ingest cycle', async () => {
    const { registry, topicRepo, userRepo } = await buildService({});
    const topicId = await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-edit',
      userId: 'user-a',
      sourceIds: ['reuters'],
    });
    const r1 = await registry.ingestOnce();
    expect(r1.sources.map((r) => r.sourceId)).toEqual(['reuters']);

    await topicRepo.insertTopicSource(topicId, 'the-guardian', 1);
    const r2 = await registry.ingestOnce();
    const ids = r2.sources.map((r) => r.sourceId).sort();
    expect(ids).toEqual(['reuters', 'the-guardian']);
  });

  it('counts failures in totals when a source fails to fetch', async () => {
    const { registry, topicRepo, userRepo } = await buildService({
      failingUrl: 'https://www.reuters.com/rss/topNews',
      guardianEntries: [],
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-fail',
      userId: 'user-a',
      sourceIds: ['reuters'],
    });

    const report = await registry.ingestOnce();
    expect(report.totals.failures).toBe(1);
    expect(report.totals.inserted + report.totals.merged).toBe(0);
  });

  it('reports cycle start, finish times, and a unique cycle id', async () => {
    const { registry } = await buildService({});
    const r1 = await registry.ingestOnce();
    expect(r1.startedAt.getTime()).toBeLessThanOrEqual(r1.finishedAt.getTime());
    expect(r1.cycleId).toMatch(/^cycle-\d+$/);
    const r2 = await registry.ingestOnce();
    expect(r2.cycleId).not.toBe(r1.cycleId);
  });

  it('articlesForTopic returns articles from sources on the topic\'s source list', async () => {
    const { registry, topicRepo, userRepo, articleRepo } = await buildService({});
    const topicId = await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-articles',
      userId: 'user-a',
      sourceIds: ['reuters'],
    });
    await registry.ingestOnce();

    const articles = await registry.articlesForTopic(topicId);
    expect(articles.map((a) => a.externalId)).toEqual(['r-1']);

    const after = await articleRepo.findByExternalId('reuters', 'r-1');
    expect(after).not.toBeNull();
  });

  it('articlesForTopic returns [] for a topic not found', async () => {
    const { registry } = await buildService({});
    const articles = await registry.articlesForTopic(
      'missing' as TopicId,
    );
    expect(articles).toEqual([]);
  });

  it('articlesForTopic returns [] when topic has no source list', async () => {
    const { registry, topicRepo, userRepo } = await buildService({});
    const topicId = await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-empty',
      userId: 'user-a',
      sourceIds: [],
    });
    const articles = await registry.articlesForTopic(topicId);
    expect(articles).toEqual([]);
  });

  it('storiesForTopic returns stories from sources on the topic\'s source list', async () => {
    const { registry, topicRepo, userRepo } = await buildService({});
    const topicId = await insertTopicWithSources(topicRepo, userRepo, {
      id: 't-stories',
      userId: 'user-a',
      sourceIds: ['reuters'],
    });
    await registry.ingestOnce();
    const stories = await registry.storiesForTopic(topicId);
    expect(stories.length).toBe(1);
    expect(stories[0]?.sourceId).toBe('reuters');
    expect(stories[0]?.articleCount).toBe(1);
  });
});