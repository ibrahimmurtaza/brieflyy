import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import {
  aggregateRollup,
  buildTrendWindow,
  dayKeys,
  detectSpikes,
  filterTrendForTier,
  rankEmergingEntities,
} from '../domain/trends.js';
import type {
  Tier,
  Topic,
  TopicId,
  TopicTrend,
  TopicTrendMeasurement,
  TrendVolumePoint,
  TrendsRollup,
} from '../domain/types.js';
import { IntervalLoop } from '../scheduling/interval-loop.js';
import type { TrendsRepo } from '../repos/trends-repo.js';

/**
 * How often the trends are recomputed.
 *
 * An hour, because a trend measured over a seven-day window against a thirty-day
 * baseline does not change meaningfully inside one: the newest day it can see is
 * the one that just ended, and the answer moves by a single day's worth of
 * Articles out of thirty-seven. Recomputing per request would spend a scan of every
 * Article every Source has ever published to arrive at a number nobody can see
 * have changed.
 */
export const DEFAULT_TRENDS_INTERVAL_MS = 60 * 60 * 1000;

export interface TrendsServiceDeps {
  readonly repo: TrendsRepo;
  readonly clock: Clock;
  /**
   * Where the id of each stored trend row comes from. Its own source rather than
   * the Topic's id so a row cannot collide with anything, even though the unique
   * index is on the Topic and would refuse the collision anyway.
   */
  readonly random: RandomSource;
  readonly intervalMs?: number;
  /** What a pass that threw is reported to. Absent means it is swallowed. */
  readonly onTickError?: ((err: unknown) => void) | undefined;
}

/**
 * The trends layer: what it measured, and what a User is allowed to be shown.
 *
 * Two halves, and the split is the whole design. `refreshTopic` is the expensive
 * one — it reads every Article every Source of a Topic has published across a
 * thirty-seven day span — and it is only ever run by the hourly loop. `trendFor`
 * and `rollupFor` are what the pages go through, and they read the stored row the
 * loop left behind.
 */
export class TrendsService {
  private readonly repo: TrendsRepo;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly loop: IntervalLoop;
  private readonly onFailure: ((err: unknown) => void) | undefined;

  constructor(deps: TrendsServiceDeps) {
    this.repo = deps.repo;
    this.clock = deps.clock;
    this.random = deps.random;
    this.onFailure = deps.onTickError;
    this.loop = new IntervalLoop({
      intervalMs: deps.intervalMs ?? DEFAULT_TRENDS_INTERVAL_MS,
      ...(deps.onTickError === undefined ? {} : { onTickError: deps.onTickError }),
    });
  }

  /** Substitute the wait, so a test sees every delay the loop asks for. */
  setSleepFn(fn: (ms: number) => Promise<void>): void {
    this.loop.setSleepFn(fn);
  }

  isRunning(): boolean {
    return this.loop.isRunning();
  }

  /**
   * Measure one Topic and store what was measured.
   *
   * The measurement arrives as counts for the days that had any, so the series are
   * completed here against the window's own days. That belongs here rather than in
   * the repository because the repository is what counts and the window is what
   * says how long a chart is: a repository asked to invent a zero for every day
   * between two dates it was handed would be a repository deciding what a day is.
   */
  async refreshTopic(topicId: TopicId): Promise<TopicTrend> {
    const window = buildTrendWindow(this.clock.now());
    const measured = await this.repo.measure({ topicId, window });
    const trend = this.assemble(topicId, window, measured);
    await this.repo.save({ id: this.random.uuid(), trend });
    return trend;
  }

  /**
   * Refresh every Topic, and report how many were written.
   *
   * One Topic failing is reported and the pass carries on. A single unmeasurable
   * Topic otherwise leaves every other Topic stale for the rest of the hour, which
   * is the difference between a trend that is a day old and one that never gets
   * written at all.
   */
  async refreshAll(): Promise<number> {
    const topicIds = await this.repo.listTopicIds();
    let written = 0;
    for (const topicId of topicIds) {
      try {
        await this.refreshTopic(topicId);
        written += 1;
      } catch (err) {
        this.onFailure?.(err);
      }
    }
    return written;
  }

  /**
   * The trend a User is shown for one Topic, already narrowed to their tier.
   *
   * Stored if there is one, measured if there is not. That second case is a Topic
   * created since the job last passed: the alternative is a page that says it has
   * nothing to show for up to an hour after the User added it, and the first read
   * paying for one measurement is not the same as every read paying for one.
   */
  async trendFor(input: {
    readonly topicId: TopicId;
    readonly tier: Tier;
  }): Promise<TopicTrend> {
    const stored = await this.repo.findByTopicId(input.topicId);
    const trend = stored ?? (await this.refreshTopic(input.topicId));
    return filterTrendForTier(trend, input.tier, this.clock.now());
  }

  /**
   * Every Topic a User holds, added together.
   *
   * The Topics are passed in rather than looked up, because the caller already has
   * the list it shows the User, and two answers to "which Topics does this User
   * have" is one more pair that can disagree.
   *
   * A Topic with no stored trend is measured once and then read from the row, the
   * same rule `trendFor` follows. It is not the dashboard measuring on every
   * request: after the first pass every Topic has a row, and after that this is
   * one read. Without it the dashboard is empty for up to an hour after a User
   * adds a Topic, which is the whole of what they came to see.
   */
  async rollupFor(input: {
    readonly topics: readonly Topic[];
    readonly tier: Tier;
  }): Promise<TrendsRollup> {
    const stored = await this.repo.findManyByTopicIds(input.topics.map((t) => t.id));
    for (const t of input.topics) {
      if (!stored.has(t.id)) stored.set(t.id, await this.refreshTopic(t.id));
    }
    const now = this.clock.now();
    return aggregateRollup(
      input.topics.map((t) => stored.get(t.id) ?? null),
      input.topics,
      buildTrendWindow(now),
      input.tier,
      now,
    );
  }

  /** Turn a measurement into the trend that is stored and read back. */
  private assemble(
    topicId: TopicId,
    window: ReturnType<typeof buildTrendWindow>,
    measured: TopicTrendMeasurement,
  ): TopicTrend {
    const days = dayKeys(window);
    const byDate = <T extends { readonly date: string }>(
      points: readonly T[],
    ): Map<string, T> => new Map(points.map((point) => [point.date, point]));

    const measuredVolume = byDate(measured.volume);
    const volumeOverTime: readonly TrendVolumePoint[] = days.map(
      (date) => measuredVolume.get(date) ?? { date, articles: 0, stories: 0 },
    );

    return {
      topicId,
      computedAt: this.clock.now(),
      window,
      volumeOverTime,
      spikes: detectSpikes(volumeOverTime, measured.clustersByDay),
      entities: rankEmergingEntities(
        // Every Entity is completed over the same days as the chart, so the two
        // axes on the page line up: a sparkline drawn over a shorter span than the
        // chart above it would put its last point at a different x from the chart's
        // last day.
        measured.entities.map((entity) => {
          const mentions = byDate(entity.daily);
          return {
            ...entity,
            daily: days.map((date) => mentions.get(date) ?? { date, mentions: 0 }),
          };
        }),
        window,
      ),
    };
  }

  runForever(): Promise<void> {
    return this.loop.runForever(() => this.refreshAll());
  }

  async stop(): Promise<void> {
    await this.loop.stop();
  }
}