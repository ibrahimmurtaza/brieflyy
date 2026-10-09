import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IngestService } from './ingest-service.js';
import { IngestScheduler } from './ingest-scheduler.js';
import { RegistryIngestService } from './registry-ingest-service.js';
import type { RegistryIngestCycleReport } from './registry-ingest-service.js';
import type {
  FeedFetcher,
  RawFeed,
  RawFeedEntry,
} from './feed-fetcher.js';
import { createTestDb } from '../testing/test-db.js';
import { makeTopic, makeUser } from '../testing/fixtures.js';
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
import { NO_BACKOFF } from '../domain/types.js';
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
  /** The step the scheduler runs at the end of every cycle. */
  readonly afterCycle?: (report: RegistryIngestCycleReport) => Promise<void>;
}

interface BuildResult {
  readonly scheduler: IngestScheduler;
  /**
   * A second scheduler over the same database, with nothing carried over from
   * the first — which is what a deploy leaves behind.
   */
  readonly restart: () => IngestScheduler;
  readonly setFetcher: (f: FeedFetcher) => void;
  readonly fetcherForUrl: (url: string, f: FeedFetcher) => void;
  readonly sourceRepo: DrizzleSourceRepo;
  readonly topicRepo: DrizzleTopicRepo;
  readonly userRepo: DrizzleUserRepo;
  readonly storyRepo: DrizzleStoryRepo;
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
    backoff: NO_BACKOFF,
  };
  const guardian: Source = {
    id: 'the-guardian',
    slug: 'the-guardian',
    name: 'The Guardian',
    homepageUrl: 'https://www.theguardian.com',
    feedUrl: 'https://www.theguardian.com/rss',
    lastPolledAt: null,
    lastSuccessAt: null,
    backoff: NO_BACKOFF,
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
  const buildScheduler = (): IngestScheduler => {
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
    return new IngestScheduler({
      registry,
      sourceRepo,
      clock: clock.clock,
      config: {
        intervalMs: opts.intervalMs ?? 30 * 60 * 1000,
        backoffBaseMs: opts.backoffBaseMs ?? 60 * 1000,
        backoffMaxMs: opts.backoffMaxMs ?? 30 * 60 * 1000,
      },
      ...(opts.afterCycle ? { afterCycle: opts.afterCycle } : {}),
    });
  };
  const scheduler = buildScheduler();

  return {
    scheduler,
    restart: buildScheduler,
    sourceRepo,
    topicRepo,
    userRepo,
    storyRepo,
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
  await userRepo.insert(
    makeUser({ id: input.userId as UserId, onboardingState: 'topics_picked' }),
  );
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

  it('runs the after-cycle step after the registry has finished the cycle', async () => {
    const insertedWhenRan: number[] = [];
    const { topicRepo, userRepo, scheduler } = await buildHarness({
      afterCycle: async (report) => {
        insertedWhenRan.push(report.totals.inserted);
      },
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters', 'the-guardian'],
    });

    const report = await scheduler.tick();

    // The step ran once, and it ran against a cycle that had already written
    // its Articles, so anything grouping them sees the whole cycle.
    expect(insertedWhenRan).toEqual([report.totals.inserted]);
    expect(insertedWhenRan[0]).toBe(2);
  });

  it('runs the after-cycle step on every cycle, not just the first', async () => {
    let runs = 0;
    const { topicRepo, userRepo, scheduler } = await buildHarness({
      afterCycle: async () => {
        runs += 1;
      },
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    await scheduler.tick();
    await scheduler.tick();

    expect(runs).toBe(2);
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
    expect(src?.nextAttemptAt).toEqual(new Date(pollAt.getTime() + 1000));
    expect(src?.lastError).toBe('upstream 503');

    clock.advance(1500);
    await scheduler.tick();
    status = scheduler.status();
    src = status.sources.find((s) => s.sourceId === ('reuters' as SourceId));
    expect(src?.consecutiveFailures).toBe(2);
    expect(src?.nextAttemptAt).toEqual(new Date(pollAt.getTime() + 1500 + 2000));

    clock.advance(3000);
    await scheduler.tick();
    status = scheduler.status();
    src = status.sources.find((s) => s.sourceId === ('reuters' as SourceId));
    expect(src?.consecutiveFailures).toBe(3);
    expect(src?.nextAttemptAt).toEqual(new Date(pollAt.getTime() + 4500 + 4000));
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
    const delay = (src?.nextAttemptAt?.getTime() ?? 0) - clock.clock.now().getTime();
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

  it('leaves a Source serving its backoff alone after a restart, and keeps counting', async () => {
    // The backoff is held on the Source rather than in the process, so a deploy
    // cannot be a way of putting a broken feed straight back into the next
    // cycle's path — which is the thing it is for.
    const { scheduler, restart, sourceRepo, topicRepo, userRepo, fetcherForUrl, clock } =
      await buildHarness({
        intervalMs: 60_000,
        backoffBaseMs: 60 * 60_000,
        backoffMaxMs: 60 * 60_000,
      });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    let attempts = 0;
    fetcherForUrl('https://www.reuters.com/rss/topNews', {
      async fetch() {
        attempts++;
        throw new Error('upstream 503');
      },
    });

    await scheduler.tick();
    expect(attempts).toBe(1);

    // The streak is on the row, where a process that has just started can find it.
    const stored = (await sourceRepo.getById('reuters'))?.backoff;
    expect(stored?.consecutiveFailures).toBe(1);
    expect(stored?.lastError).toBe('upstream 503');
    expect(stored?.nextAttemptAt).toEqual(new Date('2026-09-02T13:00:00Z'));

    // A scheduler built now shares only the database with the one that failed it.
    const restarted = restart();

    // Well inside the first backoff window: a process that had forgotten the
    // streak would poll the broken feed on this very cycle.
    clock.advance(5 * 60_000);
    const skipped = await restarted.tick();
    expect(attempts, 'a restart put a backed-off Source back into the cycle').toBe(1);
    expect(
      skipped.sources.find((s) => s.sourceId === 'reuters')?.skipped,
      'the cycle did not report the Source as skipped',
    ).toBe(true);

    // Past the window: it is tried again, and the streak carries on from where
    // it was rather than starting again from one.
    clock.advance(2 * 60 * 60_000);
    await restarted.tick();
    expect(attempts).toBe(2);
    expect((await sourceRepo.getById('reuters'))?.backoff.consecutiveFailures).toBe(2);
  });

  it('clears the stored backoff once a Source succeeds, so it is due on the normal cadence', async () => {
    const { scheduler, restart, sourceRepo, topicRepo, userRepo, fetcherForUrl, clock } =
      await buildHarness({
        intervalMs: 60_000,
        backoffBaseMs: 60 * 60_000,
        backoffMaxMs: 60 * 60_000,
      });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    let broken = true;
    fetcherForUrl('https://www.reuters.com/rss/topNews', {
      async fetch() {
        if (broken) throw new Error('upstream 503');
        return { entries: [] };
      },
    });
    await scheduler.tick();
    clock.advance(2 * 60 * 60_000);
    await scheduler.tick();
    expect((await sourceRepo.getById('reuters'))?.backoff.consecutiveFailures).toBe(2);

    broken = false;
    clock.advance(2 * 60 * 60_000);
    await scheduler.tick();

    const recoveredAt = new Date('2026-09-02T16:00:00Z');
    const recovered = (await sourceRepo.getById('reuters'))?.backoff;
    // The streak and the error are gone, and the next attempt is the cadence —
    // not the backoff's window, and not nothing, because a Source with no date
    // scheduling it is polled on every cycle the loop wakes early for somebody
    // else's backoff.
    expect(recovered).toEqual({
      consecutiveFailures: 0,
      lastError: null,
      nextAttemptAt: new Date(recoveredAt.getTime() + 60_000),
    });

    // And it stays that way across a restart, so the recovery is not just what
    // this process happens to remember.
    const restarted = restart();
    const status = await restarted.statusHydrated();
    const reuters = status.sources.find((s) => s.sourceId === 'reuters');
    expect(reuters?.consecutiveFailures).toBe(0);
    expect(reuters?.lastError).toBeNull();
    expect(reuters?.servingBackoff).toBe(false);
    expect(reuters?.nextAttemptAt).toEqual(new Date(recoveredAt.getTime() + 60_000));
  });

  it('tells a Source serving a backoff apart from one that has never run', async () => {
    const { scheduler, restart, topicRepo, userRepo, fetcherForUrl, clock } =
      await buildHarness({
        intervalMs: 60_000,
        backoffBaseMs: 60 * 60_000,
        backoffMaxMs: 60 * 60_000,
      });
    // One broken feed on a Topic, and one registry Source no Topic follows, so
    // one cycle leaves a Source held back beside one that has never started.
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    fetcherForUrl(
      'https://www.reuters.com/rss/topNews',
      new FailingFeedFetcher('upstream 503'),
    );
    await scheduler.tick();

    const status = await restart().statusHydrated();
    const reuters = status.sources.find((s) => s.sourceId === 'reuters');
    const guardian = status.sources.find((s) => s.sourceId === 'the-guardian');

    // The broken one is held back, and the dashboard says that is why.
    expect(reuters?.servingBackoff).toBe(true);
    expect(reuters?.nextAttemptAt).toEqual(new Date('2026-09-02T13:00:00Z'));

    // The untouched one has no next attempt at all, which is a Source that has
    // not started rather than one late for a slot it never had.
    expect(guardian?.lastPolledAt).toBeNull();
    expect(guardian?.consecutiveFailures).toBe(0);
    expect(guardian?.servingBackoff).toBe(false);
    expect(guardian?.nextAttemptAt).toBeNull();

    // Once the window has passed the Source is no longer being held back, even
    // though it is still mid-streak — it is waiting to be retried, not waiting.
    clock.advance(2 * 60 * 60_000);
    const later = await scheduler.statusHydrated();
    expect(
      later.sources.find((s) => s.sourceId === 'reuters')?.servingBackoff,
    ).toBe(false);
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

  it('does not let a Source no live Topic follows hold the loop awake', async () => {
    // The registry outlives the Topics naming its Sources. A Source left on only
    // removed Topics is never polled, so the date on its row is never moved — and
    // while the scheduler reads it as a due time it pins the next cycle in the
    // past. The loop then waits zero and starts again, and each pass runs the
    // whole after-cycle pipeline, so the spin pegs a core and starves the event
    // loop the rest of the app's requests depend on.
    const { scheduler, topicRepo, userRepo, sourceRepo, guardian, clock } =
      await buildHarness({ intervalMs: 30 * 60 * 1000 });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });

    // The guardian is in the registry and on no Topic at all, sitting on a next
    // attempt long past: the shape left behind when a Topic is removed.
    await sourceRepo.recordBackoff(guardian.id, {
      consecutiveFailures: 0,
      lastError: null,
      nextAttemptAt: new Date(clock.clock.now().getTime() - 24 * 60 * 60_000),
    });

    const report = await scheduler.tick();
    expect(report.sources.map((s) => s.sourceId)).toEqual(['reuters']);

    const nextDueAt = scheduler.status().nextDueAt;
    expect(nextDueAt).not.toBeNull();
    // A whole interval on, which is what an unreachable Source must not be able
    // to shorten: the wait cannot be zero, because zero is a spin.
    expect(nextDueAt!.getTime()).toBeGreaterThanOrEqual(
      clock.clock.now().getTime() + 30 * 60 * 1000,
    );
  });

  it('still wakes early for a reached Source that is serving a short backoff', async () => {
    // The fix above must not cost the scheduler the wake-ups it exists for: a
    // Source on a live Topic that failed is one the cycle reached, and its backoff
    // is a time the loop has to be awake for even though it is far sooner than the
    // cadence.
    const { scheduler, topicRepo, userRepo, fetcherForUrl, clock } =
      await buildHarness({
        intervalMs: 30 * 60 * 1000,
        backoffBaseMs: 60_000,
      });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    fetcherForUrl(
      'https://www.reuters.com/rss/topNews',
      new FailingFeedFetcher('boom'),
    );

    await scheduler.tick();

    const nextDueAt = scheduler.status().nextDueAt;
    expect(nextDueAt).not.toBeNull();
    expect(nextDueAt!.getTime()).toBe(clock.clock.now().getTime() + 60_000);
  });

  it('asks for no wait only once, when a reached Source is already overdue', async () => {
    // A Source on a live Topic whose cadence went by while the process was down is
    // legitimately due now, so the first cycle after a restart must not wait for
    // it. What it must not do is keep asking: the cycle polls the Source, moves
    // its next attempt on to the cadence, and the loop goes back to waiting.
    const { scheduler, topicRepo, userRepo, sourceRepo, reuters, clock } =
      await buildHarness({ intervalMs: 60_000 });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters'],
    });
    await sourceRepo.recordBackoff(reuters.id, {
      consecutiveFailures: 0,
      lastError: null,
      nextAttemptAt: new Date(clock.clock.now().getTime() - 60 * 60_000),
    });

    // The first two waits resolve at once so the cycle runs; the third never
    // resolves, because a sleep that always resolves is a spin and the point of
    // the test is that the loop no longer asks for one.
    const waits: number[] = [];
    scheduler.setSleepFn((ms) => {
      waits.push(ms);
      return waits.length <= 2 ? Promise.resolve() : new Promise<void>(() => {});
    });

    const runPromise = scheduler.runForever();
    while (waits.length < 3) await new Promise((r) => setImmediate(r));
    await scheduler.stop();
    await runPromise;

    // The first wait is the overdue Source; every wait after the cycle moved its
    // next attempt forward is the cadence, not zero.
    expect(waits[0]).toBeLessThanOrEqual(0);
    expect(waits.slice(1)).not.toHaveLength(0);
    expect(waits.slice(1).every((ms) => ms === 60_000)).toBe(true);
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

  it('keeps a healthy Source on its own cadence when a sibling\'s backoff wakes the loop early', async () => {
    // The loop wakes early to retry a Source that is serving a short backoff, and
    // every other Source is on that cycle. A Source that already had a good poll
    // must still not be reached out to again until its interval has gone: the
    // early wake-up is about the broken one, not about everybody.
    const { scheduler, topicRepo, userRepo, fetcherForUrl, clock } = await buildHarness({
      intervalMs: 30 * 60_000,
      backoffBaseMs: 60_000,
    });
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 't',
      userId: 'u',
      sourceIds: ['reuters', 'the-guardian'],
    });
    fetcherForUrl(
      'https://www.reuters.com/rss/topNews',
      new FailingFeedFetcher('boom'),
    );

    const guardianPolls: number[] = [];
    fetcherForUrl('https://www.theguardian.com/rss', {
      async fetch() {
        guardianPolls.push(clock.clock.now().getTime());
        return { entries: [] };
      },
    });

    // Four cycles, each just after the broken Source's one-minute backoff has
    // elapsed, so every one of them is an early wake-up rather than a cadence.
    for (let i = 0; i < 4; i++) {
      clock.advance(61_000);
      await scheduler.tick();
    }

    expect(
      guardianPolls.length,
      'a Source on its normal cadence was polled on every early wake-up',
    ).toBe(1);

    // Past the interval it is polled again, on the normal cadence.
    clock.advance(30 * 60_000);
    await scheduler.tick();
    expect(guardianPolls).toHaveLength(2);
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
