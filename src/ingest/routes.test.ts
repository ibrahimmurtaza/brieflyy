import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { IngestScheduler } from './ingest-scheduler.js';
import { RegistryIngestService } from './registry-ingest-service.js';
import { IngestService } from './ingest-service.js';
import { registerIngestRoutes } from './routes.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type {
  FeedFetcher,
  RawFeed,
  RawFeedEntry,
} from './feed-fetcher.js';
import type {
  Source,
  TopicCategory,
  TopicId,
  UserId,
} from '../domain/types.js';
import fastify from 'fastify';

class StaticFeedFetcher implements FeedFetcher {
  constructor(private readonly feed: RawFeed) {}
  async fetch(_url: string): Promise<RawFeed> {
    return this.feed;
  }
}

const BODY_A =
  'Acme Corp today unveiled a new AI product called Foo, analysts said. The launch changes the landscape for enterprise customers worldwide.';

interface BuildResult {
  readonly app: FastifyInstance;
  readonly scheduler: IngestScheduler;
  readonly sourceRepo: DrizzleSourceRepo;
}

async function build(opts?: {
  readonly pollAt?: Date;
  readonly entries?: readonly RawFeedEntry[];
}): Promise<BuildResult> {
  resetDeterministic();
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
  await sourceRepo.insert(reuters);

  await userRepo.insert({
    id: 'u' as UserId,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    onboardingState: 'topics_picked',
  });
  await topicRepo.insert({
    id: 't' as TopicId,
    userId: 'u' as UserId,
    slug: 't',
    title: 'Topic',
    blurb: '',
    category: 'news' as TopicCategory,
    origin: { kind: 'freeform' },
    sourceIds: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
  });
  await topicRepo.insertTopicSource('t' as TopicId, 'reuters', 0);

  const pollAt = opts?.pollAt ?? new Date('2026-09-02T12:00:00Z');
  const clock = makeTestClock(pollAt);

  const entries: readonly RawFeedEntry[] = opts?.entries ?? [
    {
      externalId: 'r-1',
      url: 'https://www.reuters.com/article/r-1',
      title: 'Acme Corp launches new AI product',
      body: BODY_A,
      publishedAt: new Date('2026-09-02T10:00:00Z'),
    },
  ];

  const ingest = new IngestService({
    sourceRepo,
    articleRepo,
    storyRepo,
    entityRepo,
    feedFetcher: new StaticFeedFetcher({
      sourceId: 'reuters',
      entries,
    }),
    clock: clock.clock,
    random: deterministicRandom,
  });

  let counter = 0;
  const registry = new RegistryIngestService({
    ingest,
    topicRepo,
    articleRepo,
    storyRepo,
    clock: clock.clock,
    cycleIdFn: () => {
      counter++;
      return `cycle-${counter}`;
    },
  });

  const scheduler = new IngestScheduler({
    registry,
    sourceRepo,
    clock: clock.clock,
  });

  const app = fastify({ logger: false });
  await registerIngestRoutes(app, { scheduler });
  return { app, scheduler, sourceRepo };
}

describe('Ingest routes', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('GET /api/ingest/status returns the scheduler status as JSON', async () => {
    const { app, scheduler } = await build();
    await scheduler.tick();
    const res = await app.inject({ method: 'GET', url: '/api/ingest/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      running: boolean;
      sources: { sourceId: string; lastSuccessAt: string | null }[];
    };
    expect(body.running).toBe(false);
    expect(body.sources.length).toBe(1);
    expect(body.sources[0]?.sourceId).toBe('reuters');
    expect(body.sources[0]?.lastSuccessAt).not.toBeNull();
  });

  it('POST /api/ingest/tick runs a single cycle and returns the report', async () => {
    const { app } = await build();
    const res = await app.inject({ method: 'POST', url: '/api/ingest/tick' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cycleId: string;
      totals: { inserted: number; merged: number };
      sources: { sourceId: string; success: boolean }[];
    };
    expect(body.cycleId).toMatch(/^cycle-/);
    expect(body.totals.inserted + body.totals.merged).toBe(1);
    expect(body.sources[0]?.sourceId).toBe('reuters');
    expect(body.sources[0]?.success).toBe(true);
  });

  it('GET /admin/ingest renders an HTML dashboard', async () => {
    const { app, scheduler } = await build();
    await scheduler.tick();
    const res = await app.inject({ method: 'GET', url: '/admin/ingest' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    const html = res.body;
    expect(html).toContain('Ingest scheduler');
    expect(html).toContain('reuters');
  });
});