import { describe, expect, it } from 'vitest';

import type { Clock } from '../domain/clock.js';
import { buildTrendWindow } from '../domain/trends.js';
import type {
  ClusterId,
  Tier,
  Topic,
  TopicId,
  TopicTrend,
  TopicTrendMeasurement,
  TrendVolumePoint,
  TrendsRollup,
} from '../domain/types.js';
import { makeTopic } from '../testing/fixtures.js';
import { deterministicRandom } from '../testing/test-clocks.js';
import type { TrendsRepo } from '../repos/trends-repo.js';
import { persistedUserAtTier } from '../testing/tier.js';
import { TrendsService } from './trends-service.js';

const NOW = new Date('2024-06-15T12:00:00Z');

const clock: Clock = { now: () => NOW };

/**
 * The repository, in memory, with a count of how often each half was asked for.
 *
 * The counts are the point of the double. "Recomputed on a cadence rather than on
 * every request" is not observable from the outside — a page that recomputes gives
 * the same page — so the thing being asserted is how many times the measurement
 * was taken, and only a double can answer that.
 */
class InMemoryTrendsRepo implements TrendsRepo {
  measureCalls = 0;
  saveCalls = 0;
  measurements = new Map<TopicId, TopicTrendMeasurement>();
  stored = new Map<TopicId, TopicTrend>();
  topicIds: TopicId[] = ['t1', 't2'];
  nextId = 0;

  async measure(input: { readonly topicId: TopicId }): Promise<TopicTrendMeasurement> {
    this.measureCalls += 1;
    return (
      this.measurements.get(input.topicId) ?? {
        volume: [],
        entities: [],
        clustersByDay: new Map(),
      }
    );
  }

  async findByTopicId(topicId: TopicId): Promise<TopicTrend | null> {
    return this.stored.get(topicId) ?? null;
  }

  async findManyByTopicIds(topicIds: readonly TopicId[]): Promise<Map<TopicId, TopicTrend>> {
    const out = new Map<TopicId, TopicTrend>();
    for (const id of topicIds) {
      const trend = this.stored.get(id);
      if (trend) out.set(id, trend);
    }
    return out;
  }

  async save(input: { readonly id: string; readonly trend: TopicTrend }): Promise<void> {
    this.saveCalls += 1;
    this.nextId += 1;
    this.stored.set(input.trend.topicId, input.trend);
  }

  async listTopicIds(): Promise<readonly TopicId[]> {
    return this.topicIds;
  }
}

function measurement(input: {
  readonly volume?: readonly TrendVolumePoint[];
  readonly entities?: TopicTrendMeasurement['entities'];
  readonly clustersByDay?: Map<string, readonly ClusterId[]>;
}): TopicTrendMeasurement {
  return {
    volume: input.volume ?? [],
    entities: input.entities ?? [],
    clustersByDay: input.clustersByDay ?? new Map(),
  };
}

function build(repo: TrendsRepo): TrendsService {
  return new TrendsService({ repo, clock, random: deterministicRandom });
}

async function freeTier(): Promise<Tier> {
  return (await persistedUserAtTier('free')).tier;
}

async function paidTier(): Promise<Tier> {
  return (await persistedUserAtTier('paid')).tier;
}

describe('TrendsService.refreshTopic', () => {
  it('fills in every day of the measured span, including the quiet ones', async () => {
    const repo = new InMemoryTrendsRepo();
    repo.measurements.set(
      't1',
      measurement({
        volume: [
          { date: '2024-06-14', articles: 2, stories: 1 },
          { date: '2024-06-15', articles: 1, stories: 1 },
        ],
      }),
    );
    await build(repo).refreshTopic('t1');

    const trend = await repo.findByTopicId('t1');
    expect(trend?.volumeOverTime).toHaveLength(38);
    expect(trend?.volumeOverTime[0]).toEqual({
      date: '2024-05-09',
      articles: 0,
      stories: 0,
    });
    expect(trend?.volumeOverTime.find((p) => p.date === '2024-06-14')).toEqual({
      date: '2024-06-14',
      articles: 2,
      stories: 1,
    });
  });

  it('gives every Entity a sparkline over the same span as the chart', async () => {
    const repo = new InMemoryTrendsRepo();
    repo.measurements.set(
      't1',
      measurement({
        entities: [
          {
            entityId: 'e1',
            canonicalName: 'Acme',
            observationMentions: 3,
            baselineMentions: 0,
            daily: [{ date: '2024-06-14', mentions: 3 }],
          },
        ],
      }),
    );
    await build(repo).refreshTopic('t1');
    const trend = await repo.findByTopicId('t1');
    expect(trend?.entities[0]?.daily).toHaveLength(38);
  });

  it('annotates the spike days with the Clusters that arrived on them', async () => {
    const repo = new InMemoryTrendsRepo();
    repo.measurements.set(
      't1',
      measurement({
        volume: [
          { date: '2024-06-13', articles: 1, stories: 1 },
          { date: '2024-06-14', articles: 40, stories: 8 },
        ],
        clustersByDay: new Map([['2024-06-14', ['c1' as ClusterId, 'c2' as ClusterId]]]),
      }),
    );
    const trend = await build(repo).refreshTopic('t1');
    expect(trend.spikes).toEqual([
      { date: '2024-06-14', articles: 40, clusterIds: ['c1', 'c2'] },
    ]);
  });

  it('stores the window it measured against, and the time it measured at', async () => {
    const repo = new InMemoryTrendsRepo();
    const trend = await build(repo).refreshTopic('t1');
    expect(trend.window).toEqual(buildTrendWindow(NOW));
    expect(trend.computedAt).toBe(NOW);
  });

  it('replaces the stored trend rather than adding a second one', async () => {
    const repo = new InMemoryTrendsRepo();
    const svc = build(repo);
    await svc.refreshTopic('t1');
    await svc.refreshTopic('t1');
    expect(repo.stored.size).toBe(1);
    expect(repo.saveCalls).toBe(2);
  });
});

describe('TrendsService.refreshAll', () => {
  it('refreshes every Topic and says how many it did', async () => {
    const repo = new InMemoryTrendsRepo();
    const written = await build(repo).refreshAll();
    expect(written).toBe(2);
    expect([...repo.stored.keys()].sort()).toEqual(['t1', 't2']);
  });
});

describe('TrendsService.trendFor', () => {
  it('serves the stored trend, and does not measure again', async () => {
    const repo = new InMemoryTrendsRepo();
    const svc = build(repo);
    await svc.refreshTopic('t1');
    repo.measureCalls = 0;

    const first = await svc.trendFor({ topicId: 't1', tier: await paidTier() });
    const second = await svc.trendFor({ topicId: 't1', tier: await paidTier() });
    expect(second).toEqual(first);
    // The hourly job is what recomputes; two reads of a stored row are reads.
    expect(repo.measureCalls).toBe(0);
  });

  it('measures once when there is nothing stored, and reads it back after that', async () => {
    // A Topic that has just been created has no trend until the job reaches it.
    // Filling it in on the first read keeps the page from being empty for an hour
    // without making every later request pay for the measurement.
    const repo = new InMemoryTrendsRepo();
    const svc = build(repo);
    await svc.trendFor({ topicId: 't1', tier: await paidTier() });
    await svc.trendFor({ topicId: 't1', tier: await paidTier() });
    await svc.trendFor({ topicId: 't1', tier: await paidTier() });
    expect(repo.measureCalls).toBe(1);
  });

  it('gives a free User only the last three days, from the stored trend', async () => {
    const repo = new InMemoryTrendsRepo();
    repo.measurements.set(
      't1',
      measurement({
        volume: [
          { date: '2024-06-10', articles: 9, stories: 3 },
          { date: '2024-06-14', articles: 2, stories: 1 },
        ],
      }),
    );
    const svc = build(repo);
    await svc.refreshTopic('t1');

    const trend = await svc.trendFor({ topicId: 't1', tier: await freeTier() });
    // The three days the User has lived through, today included. The stored trend
    // reaches back to May; none of that reaches this response.
    expect(trend.volumeOverTime.map((p) => p.date)).toEqual([
      '2024-06-13',
      '2024-06-14',
      '2024-06-15',
    ]);
    expect(trend.volumeOverTime.find((p) => p.date === '2024-06-14')?.articles).toBe(2);
  });

  it('gives a paid User the whole history', async () => {
    const repo = new InMemoryTrendsRepo();
    repo.measurements.set(
      't1',
      measurement({
        volume: [
          { date: '2024-06-10', articles: 9, stories: 3 },
          { date: '2024-06-14', articles: 2, stories: 1 },
        ],
      }),
    );
    const svc = build(repo);
    await svc.refreshTopic('t1');
    const trend = await svc.trendFor({ topicId: 't1', tier: await paidTier() });
    expect(trend.volumeOverTime).toHaveLength(38);
  });
});

describe('TrendsService.rollupFor', () => {
  const topics: readonly Topic[] = [
    makeTopic({ id: 't1', userId: 'u1', title: 'World news' }),
    makeTopic({ id: 't2', userId: 'u1', title: 'Fusion energy' }),
  ];

  it('adds up the stored trends of the Topics it is given', async () => {
    const repo = new InMemoryTrendsRepo();
    const svc = build(repo);
    await svc.refreshTopic('t1');
    await svc.refreshTopic('t2');

    const rollup: TrendsRollup = await svc.rollupFor({
      topics,
      tier: await paidTier(),
    });
    expect(rollup.window).toEqual(buildTrendWindow(NOW));
    // Both Topics measured on the same day, so their two series line up day for day.
    expect(rollup.volumeOverTime.find((p) => p.date === '2024-06-14')?.articles).toBe(0);
    expect(rollup.volumeOverTime).toHaveLength(38);
  });

  it('measures nothing of its own', async () => {
    const repo = new InMemoryTrendsRepo();
    const svc = build(repo);
    await svc.refreshTopic('t1');
    await svc.refreshTopic('t2');
    repo.measureCalls = 0;
    await svc.rollupFor({ topics, tier: await paidTier() });
    // The rollup is a read of what the job already computed. A dashboard that
    // re-measured every Topic of every User on every page load is the thing the
    // hourly cadence exists to prevent.
    expect(repo.measureCalls).toBe(0);
  });

  it('measures a Topic once when it has never been measured, then reads it back', async () => {
    const repo = new InMemoryTrendsRepo();
    const svc = build(repo);
    await svc.rollupFor({ topics, tier: await paidTier() });
    const afterFirst = repo.measureCalls;
    await svc.rollupFor({ topics, tier: await paidTier() });
    expect(afterFirst).toBe(2);
    expect(repo.measureCalls).toBe(2);
  });

  it('narrows to the tier, so a free dashboard shows three days', async () => {
    const repo = new InMemoryTrendsRepo();
    repo.measurements.set(
      't1',
      measurement({ volume: [{ date: '2024-06-10', articles: 5, stories: 2 }] }),
    );
    const svc = build(repo);
    await svc.refreshTopic('t1');
    await svc.refreshTopic('t2');

    const rollup = await svc.rollupFor({ topics, tier: await freeTier() });
    expect(rollup.volumeOverTime.map((p) => p.date)).toEqual([
      '2024-06-13',
      '2024-06-14',
      '2024-06-15',
    ]);
  });

  it('leaves a Topic that has never been measured out of the totals', async () => {
    const repo = new InMemoryTrendsRepo();
    const svc = build(repo);
    await svc.refreshTopic('t1');
    const rollup = await svc.rollupFor({ topics, tier: await paidTier() });
    expect(rollup.volumeOverTime).toHaveLength(38);
    expect(rollup.volumeOverTime.filter((p) => p.articles > 0)).toEqual([]);
  });

  it('names nothing as emerging when no Topic has one', async () => {
    const repo = new InMemoryTrendsRepo();
    const rollup = await build(repo).rollupFor({ topics, tier: await paidTier() });
    expect(rollup.entities).toEqual([]);
  });
});

describe('TrendsService.runForever', () => {
  it('waits an hour between passes, rather than measuring on every tick', async () => {
    const repo = new InMemoryTrendsRepo();
    const svc = build(repo);
    const delays: number[] = [];
    let waits = 0;
    svc.setSleepFn(async (ms) => {
      delays.push(ms);
      waits += 1;
      // One pass and no more: enough to see what the loop asks for without
      // standing in for a whole day's worth of ticks.
      if (waits > 1) await svc.stop();
    });

    await svc.runForever();

    expect(delays[0]).toBe(60 * 60 * 1000);
    expect(delays[1]).toBe(60 * 60 * 1000);
    expect(repo.measureCalls).toBe(2);
  });

  it('goes on refreshing the rest when one Topic fails to measure', async () => {
    const repo = new InMemoryTrendsRepo();
    const errors: unknown[] = [];
    let goodMeasures = 0;
    repo.measure = async (input) => {
      if (input.topicId === 't1') throw new Error('the database was busy');
      goodMeasures += 1;
      return measurement({});
    };
    const svc = new TrendsService({
      repo,
      clock,
      random: deterministicRandom,
      onTickError: (err) => errors.push(err),
    });

    let passes = 0;
    svc.setSleepFn(async () => {
      passes += 1;
      if (passes > 1) await svc.stop();
    });
    await svc.runForever();

    // One Topic's measurement failing is reported and the pass carries on, rather
    // than leaving every other Topic stale until the next hour for no reason.
    expect(errors).toHaveLength(1);
    expect(goodMeasures).toBe(1);
    expect(repo.stored.has('t2')).toBe(true);
  });

  it('reports nothing as running before it is started', () => {
    const svc = build(new InMemoryTrendsRepo());
    expect(svc.isRunning()).toBe(false);
  });
});