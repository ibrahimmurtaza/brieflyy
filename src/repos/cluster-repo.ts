import { eq, and, inArray, asc, gte, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  articles,
  entities,
  articleEntities,
  stories,
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
  computeAndInsertClusters(topicId: string, windowStart: Date, windowEnd: Date): Promise<readonly Cluster[]>;
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

  async computeAndInsertClusters(
    topicId: string,
    windowStart: Date,
    windowEnd: Date,
  ): Promise<readonly Cluster[]> {
    const candidateStories = await this.db
      .select()
      .from(stories)
      .where(
        and(
          gte(stories.lastSeenAt, windowStart),
        ),
      )
      .orderBy(asc(stories.lastSeenAt)) as { id: string; lastSeenAt: Date }[];

    if (candidateStories.length === 0) return [];

    // Compute article counts per story
    const storyArticleCounts = new Map<string, number>();
    for (const s of candidateStories) {
      const countRow = await this.db.select({ count: sql<number>`count(*)` }).from(articles).where(eq(articles.storyId, s.id));
      storyArticleCounts.set(s.id, Number(countRow[0]?.count ?? 0));
    }

    const clusters: Cluster[] = [];
    let currentClusterStories: StoryId[] = [];
    let currentClusterArticleCount = 0;
    let currentClusterVelocity = 0;

    for (const story of candidateStories) {
      if (currentClusterStories.length === 0) {
        currentClusterStories = [story.id];
        const artCount = storyArticleCounts.get(story.id) ?? 0;
        currentClusterArticleCount = artCount;
        currentClusterVelocity = artCount;
        continue;
      }

      const prevIndex = candidateStories.indexOf(story) - 1;
      if (prevIndex < 0) continue;
      const previousStory = candidateStories[prevIndex];
      if (!previousStory) continue;
      const storyOverlap = await this.computeStoryOverlap(story.id, previousStory.id);

      if (storyOverlap > 0.5) {
        const artCount = storyArticleCounts.get(story.id) ?? 0;
        currentClusterStories.push(story.id);
        currentClusterArticleCount += artCount;
        currentClusterVelocity = Math.max(currentClusterVelocity, artCount);
      } else {
        const artCount = storyArticleCounts.get(story.id) ?? 0;
        await this.finalizeCluster(
          topicId,
          currentClusterStories,
          currentClusterArticleCount,
          currentClusterVelocity,
          windowStart,
          windowEnd,
          clusters,
        );
        currentClusterStories = [story.id];
        currentClusterArticleCount = artCount;
        currentClusterVelocity = artCount;
      }
    }

    if (currentClusterStories.length > 0) {
      await this.finalizeCluster(
        topicId,
        currentClusterStories,
        currentClusterArticleCount,
        currentClusterVelocity,
        windowStart,
        windowEnd,
        clusters,
      );
    }

    return clusters;
  }

  private async computeStoryOverlap(storyId1: StoryId, storyId2: StoryId): Promise<number> {
    const story1Entities = await this.db
      .select({ entityId: articleEntities.entityId })
      .from(articleEntities)
      .innerJoin(articles, eq(articleEntities.articleId, articles.id))
      .where(eq(articles.storyId, storyId1));

    const story2Entities = await this.db
      .select({ entityId: articleEntities.entityId })
      .from(articleEntities)
      .innerJoin(articles, eq(articleEntities.articleId, articles.id))
      .where(eq(articles.storyId, storyId2));

    const entities1 = new Set(story1Entities.map(e => e.entityId));
    const entities2 = new Set(story2Entities.map(e => e.entityId));

    const intersection = new Set(
      [...entities1].filter(e => entities2.has(e))
    );

    return intersection.size / Math.max(entities1.size, entities2.size);
  }

  private async finalizeCluster(
    topicId: string,
    storyIds: StoryId[],
    articleCount: number,
    _velocity: number,
    windowStart: Date,
    windowEnd: Date,
    clusters: Cluster[],
  ): Promise<void> {
    const articlesInCluster = await this.db
      .select()
      .from(articles)
      .where(inArray(articles.id, storyIds.map(id => id as never)))
      .then(rows => rows as ArticleRow[]);

    const sampleArticle = articlesInCluster[0];
    const title = sampleArticle?.title ?? '';
    const body = sampleArticle?.body ?? '';

    const { extractEntities, extractKeyPhrases } = await import('../domain/extract.js');
    const entities = extractEntities(`${title}\n${body}`);
    const keyPhrases = extractKeyPhrases(body);

    const summary = (entities.length > 0 ? entities[0] : title) ?? '';
    const bulletPoints = keyPhrases.slice(0, 3);

    const articleSourceIds = new Set<string>();
    for (const article of articlesInCluster) {
      if (article.sourceId) articleSourceIds.add(article.sourceId);
    }

    const days = Math.max(1, (windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24));
    const computedVelocity = Math.max(0, storyIds.length / days);
    const state = computedVelocity > 0 ? 'active' : 'archive';

    const clusterId = `cluster-${topicId}-${windowStart.toISOString()}-${storyIds.sort().join('-')}`;
    const cluster: Cluster = {
      id: clusterId,
      topicId,
      title,
      summary,
      bulletPoints,
      createdAt: windowEnd,
      lastSeenAt: windowEnd,
      articleCount,
      velocity: computedVelocity,
      sourceIds: Array.from(articleSourceIds),
      state,
    };

    await this.insert(cluster, storyIds);
    // Write cluster story links
    for (const sid of storyIds) {
      await this.db.insert(clusterStories).values({ clusterId, storyId: sid }).onConflictDoNothing();
    }
    clusters.push(cluster);
  }
}