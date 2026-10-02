import { and, eq, gte, inArray, isNull, lt, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  articleEntities,
  articles,
  clusters,
  entities,
  topicSources,
  topicTrends,
  topics,
  type TopicTrendRow,
} from '../db/schema.js';
import type {
  ClusterId,
  EntityId,
  EntityMentions,
  TopicId,
  TopicTrend,
  TopicTrendMeasurement,
  TrendWindow,
} from '../domain/types.js';

/**
 * A UTC day, from a millisecond timestamp column.
 *
 * UTC rather than a local day because the measured span is defined in instants and
 * the User's own zone is not known here: bucketing by a zone nobody was asked
 * about would make the same Article fall in different days for two Topics, and the
 * chart's own x-axis is labelled in UTC for the same reason.
 */
const DAY = sql<string>`strftime('%Y-%m-%d', ${articles.publishedAt} / 1000, 'unixepoch')`;

type VolumeRow = { day: string; articles: number; stories: number };
type EntityDayRow = {
  entityId: string;
  canonicalName: string;
  day: string;
  mentions: number;
  observationMentions: number;
  baselineMentions: number;
};
type ClusterDayRow = { id: string; day: string };

/**
 * What the trends view reads: one measurement pass over stored data, and one
 * current trend per Topic.
 *
 * Two concerns, deliberately not two repositories. `measure` is the expensive half
 * and is what the hourly cadence exists for; `findByTopicId` is the cheap half and
 * is what every request that renders the page goes through. They read the same
 * Topic and produce the same shape, so splitting them would only buy a directory.
 */
export interface TrendsRepo {
  /**
   * Count what this Topic's Sources published and named, across the window and the
   * baseline before it.
   *
   * Counts and nothing else: the lift, the ranking, the spike detection and the
   * tier's cutoff are all answers to questions about these numbers rather than
   * questions about the database, and they are worked out by `domain/trends.ts`.
   */
  measure(input: {
    readonly topicId: TopicId;
    readonly window: TrendWindow;
  }): Promise<TopicTrendMeasurement>;

  /** The materialised trend for one Topic, or null if none has been computed. */
  findByTopicId(topicId: TopicId): Promise<TopicTrend | null>;

  /** Several at once, keyed by Topic. A Topic with no trend is simply absent. */
  findManyByTopicIds(topicIds: readonly TopicId[]): Promise<Map<TopicId, TopicTrend>>;

  /** Write a Topic's trend, replacing whatever was there. */
  save(input: { readonly id: string; readonly trend: TopicTrend }): Promise<void>;

  /** Every Topic there is a trend to compute for. */
  listTopicIds(): Promise<readonly TopicId[]>;
}

function rowToTrend(row: TopicTrendRow): TopicTrend {
  return {
    topicId: row.topicId as TopicId,
    computedAt: row.computedAt,
    window: {
      observationStart: row.observationStart,
      observationEnd: row.observationEnd,
      baselineStart: row.baselineStart,
      baselineEnd: row.baselineEnd,
    },
    volumeOverTime: parseJson<TopicTrend['volumeOverTime']>(row.volume),
    spikes: parseJson<TopicTrend['spikes']>(row.spikes),
    entities: parseJson<TopicTrend['entities']>(row.entities),
  };
}

function parseJson<T>(raw: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch {
    // A stored series that will not parse is a trend that cannot be drawn. An
    // empty one is a page with nothing on it, which the next recompute replaces —
    // a row that throws here would take down the whole Topic's page instead.
    return [] as unknown as T;
  }
}

export class DrizzleTrendsRepo implements TrendsRepo {
  constructor(private readonly db: Db) {}

  async measure(input: {
    readonly topicId: TopicId;
    readonly window: TrendWindow;
  }): Promise<TopicTrendMeasurement> {
    const sourceIds = await this.listSourceIds(input.topicId);
    if (sourceIds.length === 0) {
      return { volume: [], entities: [], clustersByDay: new Map() };
    }
    const span = and(
      inArray(articles.sourceId, sourceIds),
      gte(articles.publishedAt, input.window.baselineStart),
      // Half-open at both ends, so the boundary day is counted once and an
      // Article published in the future cannot sit in the series indefinitely.
      lt(articles.publishedAt, input.window.observationEnd),
    );

    const volume = (await this.db
      .select({
        day: DAY,
        articles: sql<number>`COUNT(*)`,
        // Each Story once, however many outlets carried it — and never counting
        // the null of an Article that has not been grouped into a Story at all.
        stories: sql<number>`COUNT(DISTINCT CASE WHEN ${articles.storyId} IS NOT NULL THEN ${articles.storyId} END)`,
      })
      .from(articles)
      .where(span)
      .groupBy(DAY)) as readonly VolumeRow[];

    const entityDays = (await this.db
      .select({
        entityId: articleEntities.entityId,
        canonicalName: entities.canonicalName,
        day: DAY,
        mentions: sql<number>`COUNT(*)`,
        // Which of the two windows this day's mentions belong to, decided on the
        // Article's own instant rather than on the day it was filed under. The
        // window bounds fall in the middle of a day, so a day-keyed split would
        // put an Article published before noon on the observation's first day into
        // the observation, where it belongs to the baseline.
        observationMentions: sql<number>`SUM(CASE WHEN ${articles.publishedAt} >= ${input.window.observationStart.getTime()} AND ${articles.publishedAt} < ${input.window.observationEnd.getTime()} THEN 1 ELSE 0 END)`,
        baselineMentions: sql<number>`SUM(CASE WHEN ${articles.publishedAt} >= ${input.window.baselineStart.getTime()} AND ${articles.publishedAt} < ${input.window.baselineEnd.getTime()} THEN 1 ELSE 0 END)`,
      })
      .from(articleEntities)
      .innerJoin(articles, eq(articles.id, articleEntities.articleId))
      .innerJoin(entities, eq(entities.id, articleEntities.entityId))
      .where(span)
      .groupBy(articleEntities.entityId, entities.canonicalName, DAY)) as readonly EntityDayRow[];

    const clustersByDay = await this.listClustersByDay(input.topicId, input.window);

    return {
      volume: volume.map((row) => ({
        date: row.day,
        articles: Number(row.articles),
        stories: Number(row.stories),
      })),
      entities: foldEntityMentions(entityDays),
      clustersByDay,
    };
  }

  private async listSourceIds(topicId: TopicId): Promise<readonly string[]> {
    const rows = (await this.db
      .select({ sourceId: topicSources.sourceId })
      .from(topicSources)
      .where(eq(topicSources.topicId, topicId))) as { sourceId: string }[];
    return rows.map((r) => r.sourceId);
  }

  /**
   * When each Cluster of this Topic arrived, by day.
   *
   * Grouped on `createdAt`, the instant the Cluster first picked up Stories, which
   * is what makes a day's jump attributable: the Cluster is the reason those
   * Articles are in the Topic at all. A Topic's Clusters only exist for as long as
   * its own Cluster window reaches back, so the annotations on a paid chart stop
   * where the Cluster window stops — which is what "what caused it" can honestly
   * mean for a Cluster that no longer exists.
   */
  private async listClustersByDay(
    topicId: TopicId,
    window: TrendWindow,
  ): Promise<Map<string, readonly ClusterId[]>> {
    const rows = (await this.db
      .select({
        id: clusters.id,
        day: sql<string>`strftime('%Y-%m-%d', ${clusters.createdAt} / 1000, 'unixepoch')`,
      })
      .from(clusters)
      .where(
        and(
          eq(clusters.topicId, topicId),
          gte(clusters.createdAt, window.baselineStart),
          lt(clusters.createdAt, window.observationEnd),
        ),
      )
      .orderBy(clusters.createdAt)) as readonly ClusterDayRow[];

    const byDay = new Map<string, ClusterId[]>();
    for (const row of rows) {
      const list = byDay.get(row.day);
      if (list) list.push(row.id as ClusterId);
      else byDay.set(row.day, [row.id as ClusterId]);
    }
    return byDay;
  }

  async findByTopicId(topicId: TopicId): Promise<TopicTrend | null> {
    const rows = (await this.db
      .select()
      .from(topicTrends)
      .where(eq(topicTrends.topicId, topicId))) as readonly TopicTrendRow[];
    const row = rows[0];
    return row ? rowToTrend(row) : null;
  }

  async findManyByTopicIds(topicIds: readonly TopicId[]): Promise<Map<TopicId, TopicTrend>> {
    const out = new Map<TopicId, TopicTrend>();
    if (topicIds.length === 0) return out;
    const rows = (await this.db
      .select()
      .from(topicTrends)
      .where(inArray(topicTrends.topicId, topicIds))) as readonly TopicTrendRow[];
    for (const row of rows) out.set(row.topicId as TopicId, rowToTrend(row));
    return out;
  }

  async save(input: { readonly id: string; readonly trend: TopicTrend }): Promise<void> {
    const { trend } = input;
    const values = {
      id: input.id,
      topicId: trend.topicId,
      computedAt: trend.computedAt,
      observationStart: trend.window.observationStart,
      observationEnd: trend.window.observationEnd,
      baselineStart: trend.window.baselineStart,
      baselineEnd: trend.window.baselineEnd,
      volume: JSON.stringify(trend.volumeOverTime),
      spikes: JSON.stringify(trend.spikes),
      entities: JSON.stringify(trend.entities),
    };
    // On the Topic rather than the id, because the row's identity is the Topic it
    // describes: the job runs again an hour later and lands on the row that is
    // already there, and a second id with the same Topic would fail the unique
    // index rather than replace anything.
    await this.db
      .insert(topicTrends)
      .values(values)
      .onConflictDoUpdate({
        target: topicTrends.topicId,
        set: {
          computedAt: values.computedAt,
          observationStart: values.observationStart,
          observationEnd: values.observationEnd,
          baselineStart: values.baselineStart,
          baselineEnd: values.baselineEnd,
          volume: values.volume,
          spikes: values.spikes,
          entities: values.entities,
        },
      });
  }

  async listTopicIds(): Promise<readonly TopicId[]> {
    // Live Topics only: a soft-removed one holds no slot, is listed nowhere, and
    // keeps its history so it can be restored. Measuring it would spend a scan of
    // thirty-seven days of Articles on something no page can reach.
    const rows = (await this.db
      .select({ id: topics.id })
      .from(topics)
      .where(isNull(topics.removedAt))
      .orderBy(topics.createdAt)) as { id: string }[];
    return rows.map((r) => r.id as TopicId);
  }
}

/**
 * Each Entity's mentions, split by which of the two windows they fell in.
 *
 * The split arrives already decided on each grouped row, and is only added up here.
 * The daily series and the two counts therefore come out of one pass over the same
 * rows, so the counts a rate is computed from can never disagree with the series
 * the sparkline is drawn from.
 */
function foldEntityMentions(rows: readonly EntityDayRow[]): readonly EntityMentions[] {
  interface Folded {
    readonly entityId: EntityId;
    readonly canonicalName: string;
    observationMentions: number;
    baselineMentions: number;
    readonly daily: { date: string; mentions: number }[];
  }
  const folded = new Map<string, Folded>();
  for (const row of rows) {
    const current = folded.get(row.entityId);
    if (!current) {
      folded.set(row.entityId, {
        entityId: row.entityId as EntityId,
        canonicalName: row.canonicalName,
        observationMentions: Number(row.observationMentions),
        baselineMentions: Number(row.baselineMentions),
        daily: [{ date: row.day, mentions: Number(row.mentions) }],
      });
      continue;
    }
    current.observationMentions += Number(row.observationMentions);
    current.baselineMentions += Number(row.baselineMentions);
    current.daily.push({ date: row.day, mentions: Number(row.mentions) });
  }
  return [...folded.values()].map((entity) => ({
    entityId: entity.entityId,
    canonicalName: entity.canonicalName,
    observationMentions: entity.observationMentions,
    baselineMentions: entity.baselineMentions,
    // Sorted by date so the series reads left to right as the chart does, rather
    // than in whatever order the grouped rows came back in.
    daily: [...entity.daily].sort((a, b) => a.date.localeCompare(b.date)),
  }));
}