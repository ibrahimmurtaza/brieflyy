import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IngestService } from './ingest-service.js';
import { IngestScheduler } from './ingest-scheduler.js';
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
  SourceId,
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
  readonly pollAt?: Date;
  readonly intervalMs?: number;
  readonly backoffBaseMs?: number;
  readonly backoffMaxMs?: number;
}

interface BuildResult {
  readonly scheduler: IngestScheduler;
  readonly setFetcher: (f: FeedFetcher) => void;
  readonly fetcherForUrl: (url: string, f: FeedFetcher) => void;
  readonly sourceRepo: DrizzleSourceRepo;
  readonly topicRepo: DrizzleTopicRepo;
  readonly userRepo: DrizzleUserRepo;
  readonly reuters: Source;
  readonly guardian: Source;
  readonly clock: ReturnType<typeof makeTestClock>;
}

async function buildHarness(opts: BuildInput = {}): Promise<BuildResult> {
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

  const fetchers = new Map<string, FeedFetcher>([
    [
      reuters.feedUrl!,
      new StaticFeedFetcher({
        sourceId: 'reuters',
        entries: [
          makeEntry(
            'r-1',
            new Date('2026-09-02T10:00:00Z'),
            'Acme Corp launches new AI product',
            BODY_A,
            'https://www.reuters.com/article',
          ),
        ],
      }),
    ],
    [
      guardian.feedUrl!,
      new StaticFeedFetcher({
        sourceId: 'the-guardian',
        entries: [
          makeEntry(
            'g-1',
            new Date('2026-09-02T11:00:00Z'),
            'BrandX acquires TinyCo',
            BODY_B,
            'https://www.theguardian.com/article',
          ),
        ],
      }),
    ],
  ]);

  const ingest = new IngestService({
    sourceRepo,
    articleRepo,
    storyRepo,
    entityRepo,
    feedFetcher: {
      fetch(url: string): Promise<RawFeed> {
        const f = fetchers.get(url);
        if (!f) throw new Error(`unexpected url ${url}`);
        return f.fetch(url);
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

  const scheduler = new IngestScheduler({
    registry,
    sourceRepo,
    clock: clock.clock,
    config: {
      intervalMs: opts.intervalMs ?? 30 * 60 * 1000,
      backoffBaseMs: opts.backoffBaseMs ?? 60 * 1000,
      backoffMaxMs: opts.backoffMaxMs ?? 30 * 60 * 1000,
    },
  });

  return {
    scheduler,
    sourceRepo,
    topicRepo,
    userRepo,
    reuters,
    guardian,
    clock,
    setFetcher(f: FeedFetcher): void {
      fetchers.set(reuters.feedUrl!, f);
    },
    fetcherForUrl(url: string, f: FeedFetcher): void {
      fetchers.set(url, f);
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

describe('IngestScheduler', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  afterEach(async () => {
    // no global cleanup needed; each test builds its own
  });

  it('runs a single cycle and updates lastPolledAt/lastSuccessAt on the source', async () => {
    const { scheduler, sourceRepo, reuters, guardian, topicRepo, userRepo } =
      await buildHarness();
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters', 'the-guardian'],
    });
    const pollAt = new Date('2026-09-02T12:00:00Z');

    const report = await scheduler.tick();

    expect(report.totals.inserted + report.totals.merged).toBe(2);
    expect(scheduler.status().lastCycleAt).not.toBeNull();

    const reutersAfter = await sourceRepo.getById(reuters.id);
    expect(reutersAfter?.lastPolledAt).toEqual(pollAt);
    expect(reutersAfter?.lastSuccessAt).toEqual(pollAt);

    const guardianAfter = await sourceRepo.getById(guardian.id);
    expect(guardianAfter?.lastSuccessAt).toEqual(pollAt);
  });

  it('does not enter backoff after a successful cycle', async () => {
    const { scheduler, topicRepo, userRepo } = await buildHarness();
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    await scheduler.tick();

    const status = scheduler.status();
    const src = status.sources.find((s) => s.sourceId === ('reuters' as SourceId));
    expect(src?.consecutiveFailures).toBe(0);
    expect(src?.lastError).toBeNull();
  });

  it('schedules an exponential backoff after consecutive failures', async () => {
    const { scheduler, topicRepo, userRepo, fetcherForUrl, clock } =
      await buildHarness({ backoffBaseMs: 1000, backoffMaxMs: 60_000 });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    fetcherForUrl(
      'https://www.reuters.com/rss/topNews',
      new FailingFeedFetcher('upstream 503'),
    );

    const pollAt = new Date('2026-09-02T12:00:00Z');
    await scheduler.tick();
    clock.advance(0);
    let status = scheduler.status();
    let src = status.sources.find(
      (s) => s.sourceId === ('reuters' as SourceId),
    );
    expect(src?.consecutiveFailures).toBe(1);
    expect(src?.nextAttemptAt.getTime()).toBe(pollAt.getTime() + 1000);
    expect(src?.lastError).toBe('upstream 503');

    clock.advance(1500);
    await scheduler.tick();
    status = scheduler.status();
    src = status.sources.find((s) => s.sourceId === ('reuters' as SourceId));
    expect(src?.consecutiveFailures).toBe(2);
    expect(src?.nextAttemptAt.getTime()).toBe(
      pollAt.getTime() + 1500 + 2000,
    );

    clock.advance(3000);
    await scheduler.tick();
    status = scheduler.status();
    src = status.sources.find((s) => s.sourceId === ('reuters' as SourceId));
    expect(src?.consecutiveFailures).toBe(3);
    expect(src?.nextAttemptAt.getTime()).toBe(
      pollAt.getTime() + 4500 + 4000,
    );
  });

  it('caps the backoff delay at backoffMaxMs', async () => {
    const { scheduler, topicRepo, userRepo, fetcherForUrl } =
      await buildHarness({ backoffBaseMs: 1000, backoffMaxMs: 4000 });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    fetcherForUrl(
      'https://www.reuters.com/rss/topNews',
      new FailingFeedFetcher('fail'),
    );

    for (let i = 0; i < 6; i++) {
      await scheduler.tick();
    }
    const src = scheduler
      .status()
      .sources.find((s) => s.sourceId === ('reuters' as SourceId));
    expect(src?.consecutiveFailures).toBe(6);
    const intervalStart = new Date('2026-09-02T12:00:00Z');
    expect(src?.nextAttemptAt.getTime()).toBeLessThanOrEqual(
      intervalStart.getTime() + 4000 + 60_000,
    );
  });

  it('clears backoff and resets consecutiveFailures after a successful fetch', async () => {
    const { scheduler, topicRepo, userRepo, setFetcher } = await buildHarness({
      backoffBaseMs: 1000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    setFetcher(new FailingFeedFetcher('fail'));
    await scheduler.tick();
    await scheduler.tick();

    setFetcher(
      new StaticFeedFetcher({
        sourceId: 'reuters',
        entries: [],
      }),
    );
    await scheduler.tick();

    const src = scheduler
      .status()
      .sources.find((s) => s.sourceId === ('reuters' as SourceId));
    expect(src?.consecutiveFailures).toBe(0);
    expect(src?.lastError).toBeNull();
  });

  it('produces a status report covering every registered source', async () => {
    const { scheduler, topicRepo, userRepo } = await buildHarness();
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters', 'the-guardian'],
    });
    await scheduler.tick();

    const hydrated = await scheduler.statusHydrated();
    const ids = hydrated.sources.map((s) => s.sourceId).sort();
    expect(ids).toEqual(['reuters', 'the-guardian']);
    for (const s of hydrated.sources) {
      expect(s.lastPolledAt).not.toBeNull();
      expect(s.lastSuccessAt).not.toBeNull();
    }
  });

  it('records no lastSuccessAt when the source fetch fails', async () => {
    const { scheduler, sourceRepo, topicRepo, userRepo, fetcherForUrl } =
      await buildHarness();
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    fetcherForUrl(
      'https://www.reuters.com/rss/topNews',
      new FailingFeedFetcher('fail'),
    );
    await scheduler.tick();

    const src = await sourceRepo.getById('reuters' as SourceId);
    expect(src?.lastPolledAt).not.toBeNull();
    expect(src?.lastSuccessAt).toBeNull();
  });

  it('start() flips running to true and stop() flips it back', async () => {
    const { scheduler } = await buildHarness();
    expect(scheduler.status().running).toBe(false);
    await scheduler.start();
    expect(scheduler.status().running).toBe(true);
    await scheduler.stop();
    expect(scheduler.status().running).toBe(false);
  });

  it('runForever ticks repeatedly until stop() is called', async () => {
    const { scheduler, topicRepo, userRepo } = await buildHarness({
      intervalMs: 1000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    let resolveSleep: (() => void) | null = null;
    scheduler.setSleepFn(
      () =>
        new Promise<void>((resolve) => {
          resolveSleep = resolve;
        }),
    );

    const runPromise = scheduler.runForever();
    expect(scheduler.status().running).toBe(true);

    resolveSleep?.();
    await new Promise((r) => setImmediate(r));
    const cyclesSeen = scheduler.status().lastCycleId;

    scheduler.stop();
    resolveSleep?.();
    await runPromise;

    expect(scheduler.status().running).toBe(false);
    expect(cyclesSeen).not.toBeNull();
  });
});