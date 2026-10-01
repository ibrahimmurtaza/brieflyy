import { and, asc, eq, inArray, notInArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  articles,
  entities,
  articleEntities,
  clusters,
  clusterStories,
  type ClusterRow,
  type ArticleRow,
  type EntityRow,
} from '../db/schema.js';
import { decodeSignature } from '../domain/story-signature.js';
import type {
  Article,
  Cluster,
  ClusterId,
  EntityId,
  StoryId,
  ArticleId,
  SourceId,
} from '../domain/types.js';

export interface ClusterRepo {
  findById(id: ClusterId): Promise<Cluster | null>;
  listByTopicId(topicId: string): Promise<readonly Cluster[]>;
  listArticlesByTopicId(topicId: string): Promise<readonly Article[]>;
  /**
   * The Articles of a Cluster, from the Sources its Topic follows.
   *
   * A Story can span Sources, so a Story grouped into a Cluster can hold Articles
   * this Topic does not follow — ingested for a different Topic, or a different
   * User. Those Articles are not in this Cluster: formation left them out of it,
   * along with their Source, and a Cluster summary is only ever quoted from
   * Articles the Cluster has. Passing the Topic's Sources rather than defaulting
   * to every Article is what keeps the read path saying the same thing the
   * Cluster was built from.
   */
  listArticlesByClusterId(
    clusterId: string,
    sourceIds: readonly SourceId[],
  ): Promise<readonly Article[]>;
  /**
   * Write a Cluster and the Stories it groups, replacing any Cluster already
   * under the same id.
   *
   * Formation runs again on every ingest cycle, and a Cluster's id is derived
   * from the Stories in it, so re-forming one has to land on the row that is
   * already there. Inserting instead would fail on the primary key and take the
   * whole cycle with it.
   */
  /**
   * The Stories a Cluster groups, which is the hop from a signal about a Cluster
   * to the Articles it has to reach.
   *
   * Unfiltered by Source, unlike `listArticlesByClusterId`: propagating a signal
   * is not a question about what a Topic shows, and an Article from an outlet
   * this Topic does not follow is still one of the Articles whose weight decides
   * where another Cluster lands.
   */
  listStoryIdsByClusterId(clusterId: ClusterId): Promise<readonly StoryId[]>;
  insert(cluster: Cluster, storyIds?: readonly StoryId[]): Promise<void>;
  /**
   * Archive every Cluster of a Topic that is not in `keepIds`, and report how
   * many changed. A Cluster whose Stories have all aged out of the window stops
   * being formed, and without this it would stay Active in the LivingBrief
   * forever as a copy of a story that has moved on.
   */
  archiveExcluding(
    topicId: string,
    keepIds: readonly ClusterId[],
    at: Date,
  ): Promise<number>;
}

function rowToCluster(row: ClusterRow): Cluster {
  return {
    id: row.id as ClusterId,
    topicId: row.topicId,
    title: row.title,
    summary: row.summary,
    bulletPoints: typeof row.bulletPoints === 'string'
      ? (row.bulletPoints ? JSON.parse(row.bulletPoints) : [])
      : (row.bulletPoints ?? []),
    createdAt: row.createdAt,
    lastSeenAt: row.lastSeenAt,
    articleCount: row.articleCount,
    velocity: row.velocity,
    sourceIds: row.sourceIds ? row.sourceIds.split(',').filter((s) => s.length > 0) : [],
    state: (row.state as 'active' | 'archive') ?? 'active',
  };
}

function rowToArticle(row: ArticleRow, entityRows: readonly EntityRow[]): Article {
  return {
    id: row.id as ArticleId,
    sourceId: row.sourceId as SourceId,
    externalId: row.externalId,
    url: row.url,
    title: row.title,
    body: row.body,
    publishedAt: row.publishedAt,
    ingestedAt: row.ingestedAt,
    storyId: (row.storyId ?? null) as StoryId | null,
    entities: entityRows.map((r) => ({
      id: r.id as EntityId,
      canonicalName: r.canonicalName,
      kind: r.kind,
    })),
    signature: decodeSignature(row.signature),
  };
}

export class DrizzleClusterRepo implements ClusterRepo {
  constructor(private readonly db: Db) {}

  async findById(id: ClusterId): Promise<Cluster | null> {
    const rows = (await this.db
      .select()
      .from(clusters)
      .where(eq(clusters.id, id))) as readonly ClusterRow[];
    const row = rows[0];
    if (!row) return null;
    return rowToCluster(row);
  }

  async listByTopicId(topicId: string): Promise<readonly Cluster[]> {
    const rows = (await this.db
      .select()
      .from(clusters)
      .where(eq(clusters.topicId, topicId))
      .orderBy(asc(clusters.createdAt))) as readonly ClusterRow[];
    return rows.map((row) => rowToCluster(row));
  }

  async listArticlesByTopicId(topicId: string): Promise<readonly Article[]> {
    const rows = (await this.db
      .select()
      .from(clusters)
      .where(eq(clusters.topicId, topicId))) as readonly ClusterRow[];
    if (rows.length === 0) return [];

    const clusterIds = rows.map((r) => r.id);
    const storyRows = (await this.db
      .select()
      .from(clusterStories)
      .where(inArray(clusterStories.clusterId, clusterIds))) as { clusterId: string; storyId: string }[];
    const storyIds = Array.from(new Set(storyRows.map((sr) => sr.storyId)));
    if (storyIds.length === 0) return [];

    const articleRows = (await this.db
      .select()
      .from(articles)
      .where(inArray(articles.storyId, storyIds))
      .orderBy(asc(articles.publishedAt))) as readonly ArticleRow[];
    if (articleRows.length === 0) return [];

    const byArticle = await this.loadEntitiesByArticleId(articleRows.map((r) => r.id));
    return articleRows.map((row) =>
      rowToArticle(row, byArticle.get(row.id) ?? []),
    );
  }

  async listStoryIdsByClusterId(clusterId: ClusterId): Promise<readonly StoryId[]> {
    const rows = (await this.db
      .select({ storyId: clusterStories.storyId })
      .from(clusterStories)
      .where(eq(clusterStories.clusterId, clusterId))) as { storyId: string }[];
    return rows.map((r) => r.storyId as StoryId);
  }

  async listArticlesByClusterId(
    clusterId: string,
    sourceIds: readonly SourceId[],
  ): Promise<readonly Article[]> {
    if (sourceIds.length === 0) return [];
    const storyRows = (await this.db
      .select()
      .from(clusterStories)
      .where(eq(clusterStories.clusterId, clusterId))) as { clusterId: string; storyId: string }[];
    const storyIds = storyRows.map((sr) => sr.storyId);
    if (storyIds.length === 0) return [];
    const articleRows = (await this.db
      .select()
      .from(articles)
      .where(
        and(
          inArray(articles.storyId, storyIds),
          inArray(articles.sourceId, sourceIds),
        ),
      )
      .orderBy(asc(articles.publishedAt))) as readonly ArticleRow[];
    if (articleRows.length === 0) return [];
    const byArticle = await this.loadEntitiesByArticleId(articleRows.map((r) => r.id));
    return articleRows.map((row) => rowToArticle(row, byArticle.get(row.id) ?? []));
  }

  private async loadEntitiesByArticleId(
    articleIds: readonly string[],
  ): Promise<Map<string, EntityRow[]>> {
    const out = new Map<string, EntityRow[]>();
    if (articleIds.length === 0) return out;
    const links = (await this.db
      .select()
      .from(articleEntities)
      .where(
        sql`${articleEntities.articleId} IN (${sql.join(
          articleIds.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      )) as { articleId: string; entityId: string }[];
    if (links.length === 0) return out;
    const entityIds = Array.from(new Set(links.map((l) => l.entityId)));
    const allEntities = (await this.db
      .select()
      .from(entities)
      .where(
        sql`${entities.id} IN (${sql.join(
          entityIds.map((i) => sql`${i}`),
          sql`, `,
        )})`,
      )) as EntityRow[];
    const entityById = new Map(allEntities.map((e) => [e.id, e]));
    for (const link of links) {
      const e = entityById.get(link.entityId);
      if (!e) continue;
      const list = out.get(link.articleId);
      if (list) list.push(e);
      else out.set(link.articleId, [e]);
    }
    return out;
  }

  async insert(cluster: Cluster, storyIds: readonly StoryId[] = []): Promise<void> {
    const values = {
      id: cluster.id,
      topicId: cluster.topicId,
      title: cluster.title,
      summary: cluster.summary,
      bulletPoints: JSON.stringify(cluster.bulletPoints),
      createdAt: cluster.createdAt,
      lastSeenAt: cluster.lastSeenAt,
      articleCount: cluster.articleCount,
      velocity: cluster.velocity,
      sourceIds: cluster.sourceIds.join(','),
      state: cluster.state ?? 'active',
    };
    await this.db
      .insert(clusters)
      .values(values)
      .onConflictDoUpdate({
        target: clusters.id,
        set: {
          title: values.title,
          summary: values.summary,
          bulletPoints: values.bulletPoints,
          lastSeenAt: values.lastSeenAt,
          articleCount: values.articleCount,
          velocity: values.velocity,
          sourceIds: values.sourceIds,
          state: values.state,
        },
      });
    for (const sid of storyIds) {
      await this.db.insert(clusterStories).values({ clusterId: cluster.id, storyId: sid }).onConflictDoNothing();
    }
  }

  async archiveExcluding(
    topicId: string,
    keepIds: readonly ClusterId[],
    at: Date,
  ): Promise<number> {
    const stale = (await this.db
      .select({ id: clusters.id })
      .from(clusters)
      .where(
        and(
          eq(clusters.topicId, topicId),
          eq(clusters.state, 'active'),
          // An empty keep-list means every Cluster is stale, and
          // `notInArray` with no values is a query with no parameters.
          ...(keepIds.length > 0 ? [notInArray(clusters.id, [...keepIds])] : []),
        ),
      )) as { id: string }[];
    if (stale.length === 0) return 0;
    await this.db
      .update(clusters)
      .set({ state: 'archive', lastSeenAt: at })
      .where(
        and(
          eq(clusters.topicId, topicId),
          inArray(clusters.id, stale.map((r) => r.id)),
        ),
      );
    return stale.length;
  }
}
