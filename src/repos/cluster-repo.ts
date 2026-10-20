import { and, asc, eq, inArray, ne, notInArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { STORY_IS_ACTIVE } from '../db/story-state.js';
import {
  articles,
  entities,
  articleEntities,
  clusters,
  clusterStories,
  stories,
  type ClusterRow,
  type ArticleRow,
  type EntityRow,
} from '../db/schema.js';
import type { HeldCluster } from '../domain/cluster-identity.js';
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
   * The Stories a Cluster groups, which is the hop from a signal about a Cluster
   * to the Articles it has to reach.
   *
   * Unfiltered by Source, unlike `listArticlesByClusterId`: propagating a signal
   * is not a question about what a Topic shows, and an Article from an outlet
   * this Topic does not follow is still one of the Articles whose weight decides
   * where another Cluster lands.
   */
  listStoryIdsByClusterId(clusterId: ClusterId): Promise<readonly StoryId[]>;
  /**
   * The Clusters of a Topic that hold Stories, with the Stories each holds.
   *
   * What the last cycle formed, read back rather than remembered. Re-forming asks
   * which Cluster a group of Stories is the continuation of
   * (`domain/cluster-identity.ts`), so this is the whole of what it has to know
   * and nothing else decides it.
   *
   * Every Cluster holding anything, archived or not. A Cluster that fell below the
   * velocity threshold is formed again on every cycle while its Stories are in the
   * window, and one that did not get to keep its id for a cycle would mint a fresh
   * one and be archived beside the copy it had just been — which is the shape this
   * change exists to remove. A Cluster the Topic has stopped forming is here for
   * the same reason: if a Story of its is covered again, that is the same Cluster
   * being covered again, with the Feedback a User gave it six weeks ago still on
   * it.
   *
   * A Cluster holding nothing is not in it: there is no membership to recognise a
   * group of Stories against, and asking which Stories are the same as this
   * Cluster's would be asking about all of them.
   */
  listHeldByTopicId(topicId: string): Promise<readonly HeldCluster[]>;
  /**
   * Write a Cluster and the Stories it groups, replacing any Cluster already
   * under the same id.
   *
   * Formation runs again on every ingest cycle, and a Cluster's id is carried
   * forward from the Cluster it was rather than derived from the Stories it now
   * holds, so re-forming one has to land on the row that is already there.
   * Inserting instead would fail on the primary key and take the whole cycle with
   * it.
   *
   * The membership is replaced rather than added to, because the Stories a Cluster
   * groups are the ones it was formed with and no others. A Story that has aged
   * out of it, or moved into a Cluster of its own, loses its row: a row left behind
   * is a Story in a Cluster that no longer holds it, which is how a Story came to
   * sit in more Clusters than its Topic had and the same reporting to be listed
   * under several of them.
   */
  insert(cluster: Cluster, storyIds?: readonly StoryId[], tx?: Db): void;
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
    tx?: Db,
  ): number;
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

  async listHeldByTopicId(topicId: string): Promise<readonly HeldCluster[]> {
    const rows = (await this.db
      .select({ clusterId: clusterStories.clusterId, storyId: clusterStories.storyId })
      .from(clusterStories)
      .innerJoin(clusters, eq(clusters.id, clusterStories.clusterId))
      .where(eq(clusters.topicId, topicId))
      .orderBy(asc(clusterStories.clusterId), asc(clusterStories.storyId))) as {
      clusterId: string;
      storyId: string;
    }[];
    const held = new Map<ClusterId, StoryId[]>();
    for (const row of rows) {
      const storyIds = held.get(row.clusterId as ClusterId) ?? [];
      storyIds.push(row.storyId as StoryId);
      held.set(row.clusterId as ClusterId, storyIds);
    }
    return [...held].map(([clusterId, storyIds]) => ({ clusterId, storyIds }));
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

  insert(cluster: Cluster, storyIds: readonly StoryId[] = [], tx: Db = this.db): void {
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
    tx.insert(clusters)
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
      })
      .run();
    const held = tx
      .select({ storyId: clusterStories.storyId })
      .from(clusterStories)
      .where(eq(clusterStories.clusterId, cluster.id))
      .all() as { storyId: string }[];
    tx.delete(clusterStories)
      .where(
        and(
          eq(clusterStories.clusterId, cluster.id),
          // An empty membership means this Cluster groups nothing, and
          // `notInArray` with no values is a query with no parameters.
          ...(storyIds.length > 0
            ? [notInArray(clusterStories.storyId, [...storyIds])]
            : []),
        ),
      )
      .run();
    for (const sid of storyIds) {
      tx.insert(clusterStories)
        .values({ clusterId: cluster.id, storyId: sid })
        .onConflictDoNothing()
        .run();
    }
    // Both sides of the membership, because a Story that has just left this
    // Cluster is the one whose Retired state has to be written and no longer has a
    // row here to be written from.
    this.writeStateOfStories([...new Set([...held.map((row) => row.storyId as StoryId), ...storyIds])], tx);
  }

  /**
   * Write the state of every Story these Clusters hold, from the Clusters rather
   * than from what the caller thinks it is.
   *
   * This is the pass that decides which Clusters are Active, and a Story is
   * Retired exactly when none of its Clusters is — so it is the only place that can
   * say it without asking, and the Archive reads the answer rather than doing the
   * asking itself. Written on both the way a Cluster is written up and the way it
   * is put away, which is what makes a Story leave Retired on its own when a
   * Cluster it is in is covered again.
   */
  private writeStateOfStoriesHeldBy(clusterIds: readonly ClusterId[], tx: Db = this.db): void {
    if (clusterIds.length === 0) return;
    const rows = tx
      .selectDistinct({ storyId: clusterStories.storyId })
      .from(clusterStories)
      .where(inArray(clusterStories.clusterId, [...clusterIds]))
      .all() as { storyId: string }[];
    this.writeStateOfStories(rows.map((row) => row.storyId as StoryId), tx);
  }

  /**
   * Write whether each of these Stories is Retired, from the Clusters holding it.
   *
   * Each statement is guarded on the stored state disagreeing, which is not a
   * saving of work for its own sake: `stories` carries a trigger that rewrites that
   * Story's Archive row on every write, and `UPDATE OF state` fires whenever the
   * column is named rather than when it changes. An unguarded pair would reindex
   * every Story a re-formed Cluster holds on every ingest cycle to arrive at the
   * answer it already had.
   *
   * Named for the Stories rather than for the Clusters holding them because a Story
   * does not always arrive through a Cluster: one that has just been dropped by the
   * Cluster it was in is named here directly, since the row that would have said so
   * is the one that was removed.
   */
  private writeStateOfStories(storyIds: readonly StoryId[], tx: Db = this.db): void {
    if (storyIds.length === 0) return;
    const named = inArray(stories.id, [...storyIds]);
    const isActive = sql.raw(STORY_IS_ACTIVE);
    tx.update(stories)
      .set({ state: 'archive' })
      .where(and(named, sql`NOT ${isActive}`, ne(stories.state, 'archive')))
      .run();
    tx.update(stories)
      .set({ state: 'active' })
      .where(and(named, isActive, ne(stories.state, 'active')))
      .run();
  }

  archiveExcluding(
    topicId: string,
    keepIds: readonly ClusterId[],
    at: Date,
    tx: Db = this.db,
  ): number {
    const stale = tx
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
      )
      .all() as { id: string }[];
    if (stale.length === 0) return 0;
    tx.update(clusters)
      .set({ state: 'archive', lastSeenAt: at })
      .where(
        and(
          eq(clusters.topicId, topicId),
          inArray(clusters.id, stale.map((r) => r.id)),
        ),
      )
      .run();
    // The Clusters are the fact the Stories' state is derived from, so it is
    // written here rather than by the caller: this is the one pass, and a second
    // path that archived a Cluster would be a second place to have remembered.
    this.writeStateOfStoriesHeldBy(stale.map((r) => r.id), tx);
    return stale.length;
  }
}
