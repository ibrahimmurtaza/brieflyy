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
import { makeTopic } from '../testing/fixtures.js';
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
import { StaticFeedFetcher, makeEntry, BODY_A, BODY_B } from './test-constants.js';

class FailingFeedFetcher implements FeedFetcher {
  constructor(private readonly message: string) {}
  async fetch(): Promise<RawFeed> {
    throw new Error(this.message);
  }
}

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
    tier: 'free',
  });
  await topicRepo.insert(
    makeTopic({
      id: input.id,
      userId: input.userId,
      sourceIds: input.sourceIds,
    }),
  );
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
    const { scheduler, topicRepo, userRepo, clock, fetcherForUrl } = await buildHarness({
      backoffBaseMs: 1000,
      backoffMaxMs: 4000,
    });
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
      // Each cycle happens well after the previous backoff has elapsed, or the
      // Source is correctly skipped and never reaches a sixth failure.
      clock.advance(60_000);
      await scheduler.tick();
    }
    const src = scheduler
      .status()
      .sources.find((s) => s.sourceId === ('reuters' as SourceId));
    expect(src?.consecutiveFailures).toBe(6);
    // The delay it settled on, which is what "capped" means: without the cap the
    // sixth failure would wait 1000 * 2**5 = 32s.
    const delay = (src?.nextAttemptAt.getTime() ?? 0) - clock.clock.now().getTime();
    expect(delay).toBe(4000);
  });

  it('clears backoff and resets consecutiveFailures after a successful fetch', async () => {
    const { scheduler, topicRepo, userRepo, setFetcher, clock } = await buildHarness({
      backoffBaseMs: 1000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    setFetcher(new FailingFeedFetcher('fail'));
    await scheduler.tick();
    clock.advance(60_000);
    await scheduler.tick();

    setFetcher(
      new StaticFeedFetcher({
        entries: [],
      }),
    );
    clock.advance(60_000);
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

  it('runForever ticks repeatedly until stop() is called', async () => {
    const { scheduler, topicRepo, userRepo } = await buildHarness({
      intervalMs: 1000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    const sleep: { release: (() => void) | null } = { release: null };
    scheduler.setSleepFn(
      () =>
        new Promise<void>((resolve) => {
          sleep.release = resolve;
        }),
    );

    const runPromise = scheduler.runForever();
    expect(scheduler.status().running).toBe(true);

    sleep.release?.();
    await new Promise((r) => setImmediate(r));
    const cyclesSeen = scheduler.status().lastCycleId;

    await scheduler.stop();
    sleep.release?.();
    await runPromise;

    expect(scheduler.status().running).toBe(false);
    expect(cyclesSeen).not.toBeNull();
  });

  it('wakes out of the wait between cycles when stopped, rather than sleeping out the interval', async () => {
    // A real interval is half an hour. If stop() only flipped a flag, closing
    // the app would block for up to that long, which is what a shutdown has to
    // avoid.
    const { scheduler, topicRepo, userRepo } = await buildHarness({
      intervalMs: 30 * 60 * 1000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    const runPromise = scheduler.runForever();
    // Let the first cycle finish so the loop is parked in its wait.
    await new Promise((r) => setImmediate(r));

    const stopped = await Promise.race([
      scheduler.stop().then(() => 'stopped'),
      new Promise((r) => setTimeout(() => r('timed out'), 2000)),
    ]);
    await runPromise;

    expect(stopped).toBe('stopped');
  });

  it('waits for an in-flight cycle to finish before stop() resolves', async () => {
    const { scheduler, topicRepo, userRepo, setFetcher, reuters } =
      await buildHarness();
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    // Park the cycle inside the feed, and park the loop between cycles, so the
    // only thing that can end the test is the code under test.
    const fetchGate: { release: (() => void) | null } = { release: null };
    setFetcher({
      async fetch() {
        await new Promise<void>((resolve) => {
          fetchGate.release = resolve;
        });
        return { entries: [] };
      },
    });
    // The first wait passes so the cycle starts; every later one parks, so the
    // only thing that can end the test is the code under test.
    let waits = 0;
    scheduler.setSleepFn(() => {
      waits++;
      return waits === 1 ? Promise.resolve() : new Promise<void>(() => {});
    });

    const runPromise = scheduler.runForever();
    await new Promise((r) => setTimeout(r, 10));
    expect(fetchGate.release, 'the cycle never reached the feed').not.toBeNull();

    const stopped = scheduler.stop();
    let stopResolved = false;
    void stopped.then(() => {
      stopResolved = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(stopResolved, 'stop() returned while a cycle was still running').toBe(
      false,
    );

    fetchGate.release!();
    await stopped;
    await runPromise;

    expect(stopResolved).toBe(true);
    // The cycle it waited for really did land.
    const after = await scheduler.statusHydrated();
    expect(
      after.sources.find((s) => s.sourceId === reuters.id)?.lastPolledAt,
    ).not.toBeNull();
  });

  it('retries a failing Source after its backoff, and stops retrying once it succeeds', async () => {
    const { scheduler, topicRepo, userRepo, setFetcher, clock } = await buildHarness({
      intervalMs: 1000,
      backoffBaseMs: 60_000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    const attempts: number[] = [];
    let shouldFail = true;
    setFetcher({
      async fetch() {
        attempts.push(clock.clock.now().getTime());
        if (shouldFail) throw new Error('boom');
        return { entries: [] };
      },
    });

    // Three cycles, each a long way past the backoff window.
    for (let i = 0; i < 3; i++) {
      clock.advance(10 * 60_000);
      await scheduler.tick();
    }
    expect(attempts).toHaveLength(3);

    // Now the Source recovers.
    shouldFail = false;
    clock.advance(10 * 60_000);
    const recovered = await scheduler.tick();
    expect(recovered.sources.every((s) => s.success)).toBe(true);
  });

  it('leaves a failing Source alone until its backoff has elapsed', async () => {
    const { scheduler, topicRepo, userRepo, setFetcher, clock } = await buildHarness({
      intervalMs: 60_000,
      backoffBaseMs: 60 * 60_000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    let attempts = 0;
    setFetcher({
      async fetch() {
        attempts++;
        throw new Error('boom');
      },
    });

    await scheduler.tick();
    expect(attempts).toBe(1);

    // Well inside the first backoff window: the loop must not touch it.
    clock.advance(5 * 60_000);
    const skipped = await scheduler.tick();
    expect(attempts, 'polled a Source that is still backing off').toBe(1);
    expect(
      skipped.sources.find((s) => s.sourceId === 'reuters')?.skipped,
      'the cycle did not report the Source as skipped',
    ).toBe(true);

    // Past the window: it is tried again.
    clock.advance(2 * 60 * 60_000);
    await scheduler.tick();
    expect(attempts).toBe(2);
  });

  it('polls a healthy Source on every cycle, with no backoff to wait out', async () => {
    const { scheduler, topicRepo, userRepo, setFetcher, clock } = await buildHarness({
      intervalMs: 60_000,
      backoffBaseMs: 60 * 60_000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    let attempts = 0;
    setFetcher({
      async fetch() {
        attempts++;
        return { entries: [] };
      },
    });

    await scheduler.tick();
    clock.advance(10 * 60_000);
    await scheduler.tick();
    clock.advance(10 * 60_000);
    await scheduler.tick();

    expect(attempts).toBe(3);
  });

  it('polls only the Sources the Topics name, and not the rest of the registry', async () => {
    const { scheduler, topicRepo, userRepo, sourceRepo } = await buildHarness();
    // The registry holds reuters and the-guardian; only one is on a Topic.
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    expect(await sourceRepo.list()).toHaveLength(2);

    const report = await scheduler.tick();

    expect(report.sources.map((s) => s.sourceId)).toEqual(['reuters']);
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

    const sleep: { release: (() => void) | null } = { release: null };
    scheduler.setSleepFn(
      () =>
        new Promise<void>((resolve) => {
          sleep.release = resolve;
        }),
    );

    const runPromise = scheduler.runForever();
    expect(scheduler.status().running).toBe(true);

    sleep.release?.();
    await new Promise((r) => setImmediate(r));
    const cyclesSeen = scheduler.status().lastCycleId;

    scheduler.stop();
    sleep.release?.();
    await runPromise;

    expect(scheduler.status().running).toBe(false);
    expect(cyclesSeen).not.toBeNull();
  });
});
