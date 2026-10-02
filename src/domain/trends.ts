import { entitlementsFor } from './tier.js';
import type {
  ClusterId,
  EmergingEntity,
  EntityMentions,
  RollupEntity,
  Tier,
  Topic,
  TopicTrend,
  TrendSpike,
  TrendVolumePoint,
  TrendWindow,
  TrendsRollup,
} from './types.js';

/** How long the observation window is. The glossary's seven days. */
export const OBSERVATION_DAYS = 7;

/** How long the baseline it is compared against reaches back. The glossary's thirty. */
export const BASELINE_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The ceiling a lift is stored at.
 *
 * An Entity the baseline never mentioned has an unbounded ratio, and JSON has no
 * way to write one: `JSON.stringify(Infinity)` is `null`, so an uncapped figure
 * comes back out of the stored trend as nothing at all and the Entity silently
 * disappears from the ranked list. A finite ceiling keeps it rankable, and the page
 * reads `baselineMentions` rather than the number, so the ceiling is never printed
 * as though it were a multiple anybody measured.
 */
export const MAX_LIFT = 999;

/**
 * How much louder an Entity has to be before it is Emerging.
 *
 * Half again as often over the window as it was over the baseline. Low, because
 * the count floor below is doing most of the work: this only has to exclude the
 * Entities that were merely steady.
 */
export const MIN_EMERGING_LIFT = 1.5;

/**
 * How many times the window must name an Entity before its rate counts.
 *
 * One mention in a week against none in a month is an excellent ratio and no
 * evidence at all, and a list of those is a list of noise. Three is the point
 * where a rate has something behind it.
 */
export const MIN_EMERGING_MENTIONS = 3;

/**
 * How far above the average a day has to sit before it is a spike.
 *
 * Against the mean rather than against the day before it: a run of rising days
 * should not annotate itself five times in a row, and a comparison with the
 * neighbouring day turns ordinary Tuesday-and-Wednesday reporting into a story.
 */
export const SPIKE_MEAN_FACTOR = 1.5;

/** And how many Articles it has to have, so a quiet topic produces no spikes. */
export const SPIKE_MIN_ARTICLES = 3;

/** A UTC day as `YYYY-MM-DD`. The key every series in here is indexed by. */
export function dayKey(at: Date): string {
  return at.toISOString().slice(0, 10);
}

function dayStart(key: string): Date {
  return new Date(`${key}T00:00:00.000Z`);
}

/**
 * The 7d observation window, and the 30d baseline it is compared against.
 *
 * The bounds are instants rather than days, because `now` is an instant: the
 * window ends exactly where the clock was when the trend was taken, so two
 * measurements an hour apart do not disagree about which Article is the newest
 * one inside them. What is bucketed into days happens further down, where the day
 * boundary is the thing that matters.
 */
export function buildTrendWindow(now: Date): TrendWindow {
  const observationEnd = new Date(now);
  const observationStart = new Date(observationEnd);
  observationStart.setUTCDate(observationEnd.getUTCDate() - OBSERVATION_DAYS);

  const baselineEnd = new Date(observationStart);
  const baselineStart = new Date(baselineEnd);
  baselineStart.setUTCDate(baselineEnd.getUTCDate() - BASELINE_DAYS);

  return {
    observationStart,
    observationEnd,
    baselineStart,
    baselineEnd,
  };
}

/**
 * Every UTC day from the start of the baseline to the end of the observation.
 *
 * The axis is whole days, and the window's bounds are instants inside them, so the
 * first and last buckets are partial: the last one is today and today is not over.
 * The page says that rather than letting the chart's final point read as a collapse.
 * Filling the axis is this function's job rather than the repository's, because the
 * repository counts and only the window knows how long a chart is.
 */
export function dayKeys(window: TrendWindow): readonly string[] {
  const keys: string[] = [];
  for (
    let day = dayStart(dayKey(window.baselineStart));
    day.getTime() <= window.observationEnd.getTime();
    day = new Date(day.getTime() + DAY_MS)
  ) {
    keys.push(dayKey(day));
  }
  return keys;
}

/** The length of a window half in whole days, which is how a rate is measured. */
export function windowDays(from: Date, to: Date): number {
  return Math.max(1, Math.round((to.getTime() - from.getTime()) / DAY_MS));
}

/**
 * One Entity's observation rate divided by its baseline rate.
 *
 * Rates rather than counts, because the two windows are not the same length: a
 * 7d window and a 30d baseline compared as totals would make every Entity look
 * like it had tripled, and the whole of the trend layer would be measuring the
 * arithmetic rather than the news.
 */
export function computeLift(
  observationCount: number,
  observationDays: number,
  baselineCount: number,
  baselineDays: number,
): number {
  const obsRate = observationCount / Math.max(observationDays, 1);
  const baseRate = baselineCount / Math.max(baselineDays, 1);
  if (baseRate === 0) {
    return obsRate > 0 ? MAX_LIFT : 0;
  }
  return Math.min(obsRate / baseRate, MAX_LIFT);
}

/**
 * How many Articles a Topic's Sources published on one day — Mention volume, which
 * is what a spike is measured against.
 *
 * Articles and not Articles-plus-Stories, because Mention volume is defined as the
 * Articles and a second measure under the same name would be the two disagreeing
 * about what "volume" is. The chart draws Stories as their own line, so the reason
 * a day was loud — many outlets, or many events — is visible rather than averaged
 * into one number.
 */
export function articlesOn(point: TrendVolumePoint): number {
  return point.articles;
}

/**
 * The days whose mention volume stands out, and the Clusters that arrived on them.
 *
 * A spike with no Cluster behind it is not annotated and is dropped rather than
 * rendered bare: a marker on the chart that links to nothing is worse than no
 * marker, because it invites a User to ask what happened and get nothing.
 */
export function detectSpikes(
  volume: readonly TrendVolumePoint[],
  clustersByDay: ReadonlyMap<string, readonly ClusterId[]>,
): readonly TrendSpike[] {
  const counted = volume.filter((point) => articlesOn(point) >= SPIKE_MIN_ARTICLES);
  if (counted.length === 0) return [];
  const mean =
    volume.reduce((sum, point) => sum + articlesOn(point), 0) / Math.max(volume.length, 1);
  const threshold = mean * SPIKE_MEAN_FACTOR;
  return volume
    .filter(
      (point) =>
        articlesOn(point) >= SPIKE_MIN_ARTICLES && articlesOn(point) > threshold,
    )
    .flatMap((point) => {
      const clusterIds = clustersByDay.get(point.date) ?? [];
      if (clusterIds.length === 0) return [];
      return [{ date: point.date, articles: articlesOn(point), clusterIds }];
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}

/**
 * The Entities whose mention rate rose, loudest first.
 *
 * Two floors, and both are needed: the ratio says an Entity moved, the count says
 * something moved it. Ties break on how many times it was mentioned, because two
 * Entities at the ceiling — both new to the window — are otherwise an arbitrary
 * order, and the one that was actually written about more belongs first.
 */
export function rankEmergingEntities(
  entities: readonly EntityMentions[],
  window: TrendWindow,
): readonly EmergingEntity[] {
  const observationDays = windowDays(window.observationStart, window.observationEnd);
  const baselineDays = windowDays(window.baselineStart, window.baselineEnd);
  return entities
    .map((entity) => ({
      entityId: entity.entityId,
      canonicalName: entity.canonicalName,
      lift: computeLift(
        entity.observationMentions,
        observationDays,
        entity.baselineMentions,
        baselineDays,
      ),
      observationMentions: entity.observationMentions,
      baselineMentions: entity.baselineMentions,
      daily: entity.daily,
    }))
    .filter((entity) => entity.lift >= MIN_EMERGING_LIFT)
    .filter((entity) => entity.observationMentions >= MIN_EMERGING_MENTIONS)
    .sort(
      (a, b) =>
        b.lift - a.lift ||
        b.observationMentions - a.observationMentions ||
        a.canonicalName.localeCompare(b.canonicalName),
    );
}

/**
 * What a User's tier lets them see of a trend.
 *
 * Every series is cut, not just the volume one: the derived per-Entity history is
 * exactly what the paywall is for, so a narrowed volume series beside an untouched
 * entity list leaked the whole of it. An Entity whose mentions all fall before the
 * cutoff is dropped, because a row with an empty sparkline is a claim about a
 * month the User has not been shown.
 *
 * The lift and the two counts go with the series rather than beside it. They are
 * ratios between a seven-day window and a thirty-day baseline, so printing them
 * next to three days of chart would describe the month in three numbers — and the
 * point of narrowing the series is that the rest of the measurement is not served.
 * The order the list is in survives: it was worked out before the filter ran, and
 * it says which of these got louder without saying by how much.
 */
export function filterTrendForTier(
  trend: TopicTrend,
  tier: Tier,
  now: Date,
): TopicTrend {
  const historyDays = entitlementsFor(tier).trendHistoryDays;
  // A null history is the paid tier's full history, which needs no cutoff.
  if (historyDays === null) return trend;
  // Three days of history is the three days the User has lived through, today
  // included — hence the `- 1`. Cutting at `now - 3d` would keep four calendar
  // days, because the day the cutoff falls in is itself one of them.
  const cutoff = dayKey(new Date(now.getTime() - (historyDays - 1) * DAY_MS));
  const from = (date: string): boolean => date >= cutoff;
  return {
    ...trend,
    volumeOverTime: trend.volumeOverTime.filter((point) => from(point.date)),
    spikes: trend.spikes.filter((spike) => from(spike.date)),
    entities: trend.entities
      .map((entity) => ({
        ...entity,
        lift: null,
        observationMentions: null,
        baselineMentions: null,
        daily: entity.daily.filter((point) => from(point.date)),
      }))
      .filter((entity) => entity.daily.length > 0),
  };
}

/**
 * Several Topics, added together.
 *
 * A Topic with no stored trend yet contributes nothing rather than being counted
 * as a Topic with nothing in it, which is the difference between "we have not
 * looked" and "there is nothing there" — the same distinction the LivingBrief keeps
 * its four empty states apart for.
 *
 * The Topics are passed in rather than looked up, because the caller already has
 * the list it shows the User: a second query asking which Topics this User has
 * would be one more place for the two answers to disagree.
 */
export function aggregateRollup(
  trends: readonly (TopicTrend | null)[],
  topics: readonly Topic[],
  window: TrendWindow,
  tier: Tier,
  now: Date,
): TrendsRollup {
  const slugByTopic = new Map(topics.map((t) => [t.id, t] as const));

  const byDate = new Map<string, { articles: number; stories: number }>();
  const entities = new Map<string, RollupEntity>();
  for (const stored of trends) {
    if (!stored) continue;
    const trend = filterTrendForTier(stored, tier, now);
    for (const point of trend.volumeOverTime) {
      const current = byDate.get(point.date) ?? { articles: 0, stories: 0 };
      current.articles += point.articles;
      current.stories += point.stories;
      byDate.set(point.date, current);
    }
    for (const entity of trend.entities) {
      // One Entity however many Topics it rose in: three of the User's Topics
      // naming the same company is one thing getting louder, and listing it three
      // times would fill the rollup with a single story.
      // The order entities arrive in is the Topics' own lift ranking, so the rollup
      // is as loud-first as the Topics each of them came from. The tier filter cuts
      // what is printed, not what decided the order.
      const topic = slugByTopic.get(trend.topicId);
      if (!topic) continue;
      const current = entities.get(entity.entityId);
      if (current) {
        // The one it rose in most, which is the higher lift — the two entries are
        // otherwise the same Entity measured against the same window and differ
        // only in how many of its Articles each Topic's Sources carried. With the
        // lifts taken away by the tier filter there is nothing left to compare, so
        // the first Topic to carry it stands.
        if (current.lift === null || entity.lift === null) continue;
        if (current.lift >= entity.lift) continue;
      }
      entities.set(entity.entityId, {
        entityId: entity.entityId,
        canonicalName: entity.canonicalName,
        lift: entity.lift,
        baselineMentions: entity.baselineMentions,
        topicId: topic.id,
        topicSlug: topic.slug,
        topicTitle: topic.title,
      });
    }
  }

  return {
    window,
    volumeOverTime: [...byDate.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, counts]) => ({ date, ...counts })),
    // The order is the order the Topics were aggregated in and the lift ranked
    // within each — untouched by the tier filter, which cuts what is printed
    // rather than what decides the order.
    entities: [...entities.values()],
  };
}