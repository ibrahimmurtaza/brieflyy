import { describe, expect, it } from 'vitest';

import {
  BASELINE_DAYS,
  MAX_LIFT,
  OBSERVATION_DAYS,
  aggregateRollup,
  buildTrendWindow,
  computeLift,
  dayKeys,
  detectSpikes,
  filterTrendForTier,
  rankEmergingEntities,
} from './trends.js';
import type {
  EmergingEntity,
  EntityMentions,
  Topic,
  TrendSpike,
  TrendVolumePoint,
} from './types.js';
import { makeTopic } from '../testing/fixtures.js';

const NOW = new Date('2024-06-15T12:00:00Z');

function volume(
  entries: readonly (readonly [string, number])[],
): readonly TrendVolumePoint[] {
  return entries.map(([date, count]) => ({
    date,
    articles: count,
    stories: count > 0 ? 1 : 0,
  }));
}

function mentions(overrides: Partial<EntityMentions> & { entityId: string }): EntityMentions {
  return {
    canonicalName: overrides.entityId,
    observationMentions: 0,
    baselineMentions: 0,
    daily: [],
    ...overrides,
  };
}

function topic(id: string, title: string): Topic {
  return makeTopic({ id, userId: 'u1', title });
}

describe('the trend window', () => {
  it('observes seven days against a thirty day baseline', () => {
    expect(OBSERVATION_DAYS).toBe(7);
    expect(BASELINE_DAYS).toBe(30);
  });

  it('puts the boundary dates where the glossary puts them', () => {
    const w = buildTrendWindow(NOW);
    expect(w.observationStart.toISOString()).toBe('2024-06-08T12:00:00.000Z');
    expect(w.observationEnd.toISOString()).toBe('2024-06-15T12:00:00.000Z');
    expect(w.baselineStart.toISOString()).toBe('2024-05-09T12:00:00.000Z');
    expect(w.baselineEnd.toISOString()).toBe('2024-06-08T12:00:00.000Z');
  });

  it('measures the baseline to the day the observation starts, with no gap', () => {
    const w = buildTrendWindow(NOW);
    // The boundary itself, in both directions: an Article at exactly this instant
    // is observed rather than baselined, so nothing is counted twice and nothing
    // falls between the two windows.
    expect(w.baselineEnd.getTime()).toBe(w.observationStart.getTime());
    expect(w.observationEnd.getTime() - w.baselineStart.getTime()).toBe(
      (OBSERVATION_DAYS + BASELINE_DAYS) * 24 * 60 * 60 * 1000,
    );
  });
});

describe('lift', () => {
  it('compares rates rather than counts, so the window sizes cancel out', () => {
    expect(computeLift(14, 7, 15, 30)).toBeCloseTo(4, 5);
  });

  it('is zero for an Entity the observation window never mentioned', () => {
    expect(computeLift(0, 7, 0, 30)).toBe(0);
  });

  it('caps a rise against an empty baseline rather than storing Infinity', () => {
    // JSON has no Infinity: `JSON.stringify(Infinity)` is `null`, so an uncapped
    // figure would come back from the stored trend as nothing at all. The page
    // reads `baselineMentions` for this case instead of the number.
    expect(computeLift(7, 7, 0, 30)).toBe(MAX_LIFT);
    expect(Number.isFinite(computeLift(1, 7, 0, 30))).toBe(true);
  });
});

describe('the daily series', () => {
  it('covers every day of the measured span, including the ones with nothing on them', () => {
    const w = buildTrendWindow(NOW);
    const keys = dayKeys(w);
    expect(keys[0]).toBe('2024-05-09');
    expect(keys.at(-1)).toBe('2024-06-15');
    // 30 days of baseline plus 7 days of observation, each boundary day counted
    // once because they share an instant.
    expect(keys).toHaveLength(BASELINE_DAYS + OBSERVATION_DAYS + 1);
  });
});

describe('spikes', () => {
  it('marks a day that stands well above the average and names the Clusters that arrived', () => {
    const series = volume([
      ['2024-06-10', 2],
      ['2024-06-11', 2],
      ['2024-06-12', 2],
      ['2024-06-13', 20],
      ['2024-06-14', 2],
    ]);
    const clustersByDay = new Map([['2024-06-13', ['cluster-a', 'cluster-b']]]);
    const spikes = detectSpikes(series, clustersByDay);
    expect(spikes).toHaveLength(1);
    expect(spikes[0]?.date).toBe('2024-06-13');
    expect(spikes[0]?.clusterIds).toEqual(['cluster-a', 'cluster-b']);
    expect(spikes[0]?.articles).toBe(20);
  });

  it('does not mark an ordinary day, however busy it is', () => {
    const series = volume([
      ['2024-06-10', 4],
      ['2024-06-11', 5],
      ['2024-06-12', 4],
      ['2024-06-13', 5],
    ]);
    expect(detectSpikes(series, new Map())).toEqual([]);
  });

  it('does not mark a day that has no Clusters to point at', () => {
    // A jump with nothing behind it cannot be annotated, and an annotation that
    // links to nothing is worse than no annotation.
    const series = volume([
      ['2024-06-10', 1],
      ['2024-06-11', 1],
      ['2024-06-12', 30],
    ]);
    expect(detectSpikes(series, new Map())).toEqual([]);
  });

  it('finds nothing in a series too short to have an average worth comparing against', () => {
    const series = volume([['2024-06-10', 99]]);
    expect(detectSpikes(series, new Map([['2024-06-10', ['c1']]]))).toEqual([]);
  });

  it('sorts the spikes by date so the chart can walk them in order', () => {
    const series = volume([
      ['2024-06-10', 1],
      ['2024-06-11', 25],
      ['2024-06-12', 1],
      ['2024-06-13', 25],
    ]);
    const clustersByDay = new Map([
      ['2024-06-11', ['c1']],
      ['2024-06-13', ['c2']],
    ]);
    const spikes: readonly TrendSpike[] = detectSpikes(series, clustersByDay);
    expect(spikes.map((s) => s.date)).toEqual(['2024-06-11', '2024-06-13']);
  });
});

describe('the emerging entities', () => {
  const w = buildTrendWindow(NOW);

  it('ranks by lift, loudest first', () => {
    const ranked = rankEmergingEntities(
      [
        mentions({ entityId: 'a', observationMentions: 14, baselineMentions: 30 }),
        mentions({ entityId: 'b', observationMentions: 60, baselineMentions: 30 }),
        mentions({ entityId: 'c', observationMentions: 21, baselineMentions: 30 }),
      ],
      w,
    );
    expect(ranked.map((e) => e.entityId)).toEqual(['b', 'c', 'a']);
  });

  it('leaves out an Entity that did not move', () => {
    // Seven mentions in the window and thirty in the baseline is the same rate,
    // which is the whole difference between a rate and a count.
    const ranked = rankEmergingEntities(
      [mentions({ entityId: 'a', observationMentions: 7, baselineMentions: 30 })],
      w,
    );
    expect(ranked).toEqual([]);
  });

  it('leaves out an Entity the window only named once or twice', () => {
    // One mention in a week against none in a month is a great ratio and no
    // evidence at all, so a floor on the count sits under the floor on the ratio.
    const ranked = rankEmergingEntities(
      [
        mentions({ entityId: 'a', observationMentions: 2, baselineMentions: 0 }),
        mentions({ entityId: 'b', observationMentions: 5, baselineMentions: 0 }),
      ],
      w,
    );
    expect(ranked.map((e) => e.entityId)).toEqual(['b']);
  });

  it('breaks a tie on lift by how many times it was mentioned', () => {
    const ranked = rankEmergingEntities(
      [
        mentions({ entityId: 'a', observationMentions: 30, baselineMentions: 30 }),
        mentions({ entityId: 'b', observationMentions: 60, baselineMentions: 60 }),
      ],
      w,
    );
    expect(ranked.map((e) => e.entityId)).toEqual(['b', 'a']);
  });

  it('carries the daily series through, so the sparkline can be drawn', () => {
    const daily = [
      { date: '2024-06-13', mentions: 0 },
      { date: '2024-06-14', mentions: 5 },
    ];
    const ranked = rankEmergingEntities(
      [mentions({ entityId: 'b', observationMentions: 5, baselineMentions: 0, daily })],
      w,
    );
    expect(ranked[0]?.daily).toEqual(daily);
  });
});

describe('the tier cutoff', () => {
  const w = buildTrendWindow(NOW);

  const trend = {
    topicId: 'topic-1',
    computedAt: NOW,
    window: w,
    volumeOverTime: volume([
      ['2024-06-10', 1],
      ['2024-06-13', 2],
      ['2024-06-14', 3],
    ]),
    spikes: [
      { date: '2024-06-10', articles: 1, clusterIds: ['old'] as const },
      { date: '2024-06-14', articles: 3, clusterIds: ['new'] as const },
    ],
    entities: [
      {
        entityId: 'quiet',
        canonicalName: 'Quiet',
        lift: 9,
        observationMentions: 1,
        baselineMentions: 0,
        daily: [{ date: '2024-06-10', mentions: 1 }],
      },
      {
        entityId: 'loud',
        canonicalName: 'Loud',
        lift: 4,
        observationMentions: 9,
        baselineMentions: 0,
        daily: [
          { date: '2024-06-10', mentions: 1 },
          { date: '2024-06-14', mentions: 8 },
        ],
      },
    ] satisfies readonly EmergingEntity[],
  };

  it('keeps the whole history for a paid User', () => {
    const filtered = filterTrendForTier(trend, 'paid', NOW);
    expect(filtered.volumeOverTime).toHaveLength(3);
    expect(filtered.spikes).toHaveLength(2);
    expect(filtered.entities).toHaveLength(2);
    const loud = filtered.entities.find((e) => e.entityId === 'loud');
    expect(loud?.daily).toHaveLength(2);
  });

  it('cuts the volume series to the last three days for a free User', () => {
    const filtered = filterTrendForTier(trend, 'free', NOW);
    expect(filtered.volumeOverTime.map((p) => p.date)).toEqual(['2024-06-13', '2024-06-14']);
  });

  it('cuts the annotations and the entity series to the same three days', () => {
    // The leak this closes: the volume series was narrowed and the entity list
    // passed through whole, so a free User was served the very history the
    // paywall is for.
    const filtered = filterTrendForTier(trend, 'free', NOW);
    expect(filtered.spikes.map((s) => s.date)).toEqual(['2024-06-14']);
    expect(filtered.entities.map((e) => e.entityId)).toEqual(['loud']);
    expect(filtered.entities[0]?.daily.map((d) => d.date)).toEqual(['2024-06-14']);
  });

  it('takes the lift and the two window counts with the series', () => {
    // They are ratios between a seven-day window and a thirty-day baseline.
    // Leaving them beside a three-day chart would describe the month in three
    // numbers, which is the history the tier is being held back from.
    const filtered = filterTrendForTier(trend, 'free', NOW);
    const loud = filtered.entities[0];
    expect(loud?.lift).toBeNull();
    expect(loud?.observationMentions).toBeNull();
    expect(loud?.baselineMentions).toBeNull();
    // Not zero: "not shown to you" and "nothing happened" are different facts.
    expect(loud).not.toEqual(expect.objectContaining({ lift: 0 }));
  });

  it('leaves the order the lift put them in, which is what a limited tier does get', () => {
    const emerging = (id: string, lift: number): EmergingEntity => ({
      entityId: id,
      canonicalName: id,
      lift,
      observationMentions: 9,
      baselineMentions: 1,
      daily: [{ date: '2024-06-14', mentions: 9 }],
    });
    const filtered = filterTrendForTier(
      { ...trend, entities: [emerging('first', 9), emerging('second', 2)] },
      'free',
      NOW,
    );
    expect(filtered.entities.map((e) => e.entityId)).toEqual(['first', 'second']);
  });

  it('leaves the window and the computed-at untouched', () => {
    // They describe how the trend was measured, not how much of it this User may
    // see, so narrowing the series must not claim a narrower measurement.
    const filtered = filterTrendForTier(trend, 'free', NOW);
    expect(filtered.window).toBe(w);
    expect(filtered.computedAt).toBe(NOW);
  });

  it('keeps the day the cutoff falls on', () => {
    // Three days of history means three days: the boundary day is in, the one
    // before it is out.
    const filtered = filterTrendForTier(trend, 'free', new Date('2024-06-14T12:00:00Z'));
    expect(filtered.volumeOverTime.map((p) => p.date)).toEqual(['2024-06-13', '2024-06-14']);
  });
});

describe('the across-your-topics rollup', () => {
  const w = buildTrendWindow(NOW);

  const trendFor = (topicId: string, points: readonly TrendVolumePoint[], entities: readonly EmergingEntity[]) => ({
    topicId,
    computedAt: NOW,
    window: w,
    volumeOverTime: points,
    spikes: [],
    entities,
  });

  it('adds up the volume of every Topic by day', () => {
    const rollup = aggregateRollup(
      [
        trendFor('t1', volume([['2024-06-14', 2]]), []),
        trendFor('t2', volume([['2024-06-14', 3]]), []),
      ],
      [topic('t1', 'World news'), topic('t2', 'Fusion energy')],
      w,
      'paid',
      NOW,
    );
    expect(rollup.volumeOverTime).toEqual([{ date: '2024-06-14', articles: 5, stories: 2 }]);
  });

  it('names one Entity once, in the Topic it rose in most', () => {
    const shared: EmergingEntity = {
      entityId: 'e1',
      canonicalName: 'Acme',
      lift: 2,
      observationMentions: 4,
      baselineMentions: 2,
      daily: [],
    };
    const rollup = aggregateRollup(
      [
        trendFor('t1', [], [shared]),
        trendFor('t2', [], [{ ...shared, lift: 7 }]),
      ],
      [topic('t1', 'World news'), topic('t2', 'Fusion energy')],
      w,
      'paid',
      NOW,
    );
    expect(rollup.entities).toHaveLength(1);
    expect(rollup.entities[0]?.lift).toBe(7);
    expect(rollup.entities[0]?.topicId).toBe('t2');
    expect(rollup.entities[0]?.topicTitle).toBe('Fusion energy');
  });

  it('carries the winning Topic\'s own series, rather than summing the Topics', () => {
    // The lift on a rollup entry is one Topic's measurement, so the days drawn under
    // it have to be that Topic's too. A summed series would be evidence for a ratio
    // measured somewhere else, which is the disagreement the entry exists to avoid.
    const shared: EmergingEntity = {
      entityId: 'e1',
      canonicalName: 'Acme',
      lift: 2,
      observationMentions: 4,
      baselineMentions: 2,
      daily: [],
    };
    const rollup = aggregateRollup(
      [
        trendFor('t1', [], [{ ...shared, daily: [{ date: '2024-06-14', mentions: 5 }] }]),
        trendFor('t2', [], [{ ...shared, lift: 7, daily: [{ date: '2024-06-14', mentions: 1 }] }]),
      ],
      [topic('t1', 'World news'), topic('t2', 'Fusion energy')],
      w,
      'paid',
      NOW,
    );
    expect(rollup.entities).toHaveLength(1);
    // t2's day alone — not 5 + 1, which would be a figure for neither Topic.
    expect(rollup.entities[0]?.daily).toEqual([{ date: '2024-06-14', mentions: 1 }]);
    expect(rollup.entities[0]?.topicId).toBe('t2');
  });

  it('narrows a rollup entry\'s series to the tier, and drops one with nothing left', () => {
    const entity: EmergingEntity = {
      entityId: 'e1',
      canonicalName: 'Acme',
      lift: 2,
      observationMentions: 4,
      baselineMentions: 2,
      daily: [
        { date: '2024-06-10', mentions: 2 },
        { date: '2024-06-14', mentions: 2 },
      ],
    };
    const narrowed = aggregateRollup(
      [trendFor('t1', [], [entity])],
      [topic('t1', 'World news')],
      w,
      'free',
      NOW,
    );
    expect(narrowed.entities[0]?.daily).toEqual([{ date: '2024-06-14', mentions: 2 }]);
    // And a series that fell entirely before the cutoff takes the Entity with it,
    // so the rollup never prints a multiple over days the User was not shown.
    const beforeCutoff = aggregateRollup(
      [
        trendFor('t1', [], [{ ...entity, daily: [{ date: '2024-06-01', mentions: 4 }] }]),
      ],
      [topic('t1', 'World news')],
      w,
      'free',
      NOW,
    );
    expect(beforeCutoff.entities).toEqual([]);
  });

  it('skips a Topic whose trend has not been computed yet', () => {
    const rollup = aggregateRollup(
      [trendFor('t1', volume([['2024-06-14', 1]]), [])],
      [topic('t1', 'World news'), topic('t2', 'Fusion energy')],
      w,
      'paid',
      NOW,
    );
    expect(rollup.volumeOverTime).toHaveLength(1);
    expect(rollup.entities).toEqual([]);
  });

  it('narrows to the tier like every other surface', () => {
    const rollup = aggregateRollup(
      [trendFor('t1', volume([['2024-06-10', 9], ['2024-06-14', 1]]), [])],
      [topic('t1', 'World news')],
      w,
      'free',
      NOW,
    );
    expect(rollup.volumeOverTime.map((p) => p.date)).toEqual(['2024-06-14']);
  });
});