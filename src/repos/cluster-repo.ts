import { eq, inArray, asc, sql } from 'drizzle-orm';

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
  listArticlesByClusterId(clusterId: string): Promise<readonly Article[]>;
  insert(cluster: Cluster, storyIds: readonly StoryId[]): Promise<void>;
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
    fingerprint: row.fingerprint,
    storyId: (row.storyId ?? null) as StoryId | null,
    entities: entityRows.map((r) => ({
      id: r.id as EntityId,
      canonicalName: r.canonicalName,
      kind: r.kind,
    })),
    keyPhrases: [],
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
    if (rows.length === 0) return [];

    const clusterIds = rows.map((r) => r.id);
    const storyRows = (await this.db
      .select()
      .from(clusterStories)
      .where(inArray(clusterStories.clusterId, clusterIds))) as { clusterId: string; storyId: string }[];
    const storyIdsByCluster = new Map<string, string[]>();
    for (const sr of storyRows) {
      const list = storyIdsByCluster.get(sr.clusterId) ?? [];
      list.push(sr.storyId);
      storyIdsByCluster.set(sr.clusterId, list);
    }

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

  async listArticlesByClusterId(clusterId: string): Promise<readonly Article[]> {
    const storyRows = (await this.db
      .select()
      .from(clusterStories)
      .where(eq(clusterStories.clusterId, clusterId))) as { clusterId: string; storyId: string }[];
    const storyIds = storyRows.map((sr) => sr.storyId);
    if (storyIds.length === 0) return [];
    const articleRows = (await this.db
      .select()
      .from(articles)
      .where(inArray(articles.storyId, storyIds))
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
    await this.db.insert(clusters).values({
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
    });
    for (const sid of storyIds) {
      await this.db.insert(clusterStories).values({ clusterId: cluster.id, storyId: sid }).onConflictDoNothing();
    }
  }

  async updateLastSeenAt(id: ClusterId, at: Date): Promise<void> {
    await this.db
      .update(clusters)
      .set({ lastSeenAt: at })
      .where(eq(clusters.id, id));
  }
}
