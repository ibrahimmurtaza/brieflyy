import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { DEFAULT_CLUSTER_WINDOW_DAYS, clampClusterWindowDays } from '../domain/cluster-window.js';
import {
  topicSources,
  topics,
  type TopicRow,
  type TopicSourceRow,
} from '../db/schema.js';
import type {
  Topic,
  TopicId,
  TopicOrigin,
  TopicTemplate,
  UserId,
  Cadence,
} from '../domain/types.js';

function rowToTopic(row: TopicRow, sourceIds: readonly string[]): Topic {
  const origin: TopicOrigin =
    row.originKind === 'template' && row.originTemplateId
      ? { kind: 'template', templateId: row.originTemplateId }
      : { kind: 'freeform' };
  return {
    id: row.id,
    userId: row.userId,
    slug: row.slug,
    title: row.title,
    blurb: row.blurb,
    category: row.category as TopicTemplate['category'],
    origin,
    sourceIds,
    cadence: (row.cadence ?? 'daily') as Cadence,
    clusterWindowDays: row.clusterWindowDays,
    createdAt: row.createdAt,
    removedAt: row.removedAt ?? null,
    unsubscribedAt: row.unsubscribedAt ?? null,
  };
}

function groupSourcesByTopic(
  rows: readonly TopicSourceRow[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.topicId);
    if (list) {
      list.push(r.sourceId);
    } else {
      out.set(r.topicId, [r.sourceId]);
    }
  }
  for (const list of out.values()) {
    list.sort();
  }
  return out;
}

export interface TopicRepo {
  insert(topic: Topic): Promise<void>;
  listByUser(userId: UserId): Promise<readonly Topic[]>;
  listAll(): Promise<readonly Topic[]>;
  getById(id: TopicId): Promise<Topic | null>;
  /**
   * One of a User's own Topics, by the slug their URL carries.
   *
   * Scoped to the User on purpose: a slug is only unique per User, and a page
   * reached by slug must not resolve to somebody else's Topic.
   */
  findBySlug(userId: UserId, slug: string): Promise<Topic | null>;
  insertTopicSource(
    topicId: TopicId,
    sourceId: string,
    position: number,
  ): Promise<void>;
  /**
   * Soft delete. The row stays so its brief plans and snapshots remain
   * readable, but the topic stops resolving for listings and for the ingest and
   * cluster pipelines, and it stops counting toward the free-tier cap.
   */
  remove(id: TopicId, removedAt: Date): Promise<void>;
  /**
   * Every slug the user has ever held, including removed ones. The unique
   * index on (user_id, slug) still spans soft-deleted rows, so slug allocation
   * has to see them or re-adding a removed topic raises a constraint error.
   */
  listSlugsByUser(userId: UserId): Promise<readonly string[]>;
  /**
   * Change how far back this Topic looks when it forms Clusters. The value is
   * clamped rather than rejected, so an out-of-range number typed into the form
   * narrows to the nearest window that still means something.
   */
  setClusterWindowDays(id: TopicId, days: number): Promise<void>;
  /**
   * Record or clear the opt-out a one-click unsubscribe from this Topic sets.
   *
   * A date to stop sending, and null to start again. The row is kept either way:
   * an unsubscribed Topic is still the User's, still on `/topics`, and still has
   * a brief history worth reading — which is why this is a column rather than a
   * removal.
   */
  setUnsubscribedAt(id: TopicId, at: Date | null): Promise<void>;
}

export class DrizzleTopicRepo implements TopicRepo {
  constructor(private readonly db: Db) {}

  async insert(topic: Topic): Promise<void> {
    const originTemplateId =
      topic.origin.kind === 'template' ? topic.origin.templateId : null;
    await this.db.insert(topics).values({
      id: topic.id,
      userId: topic.userId,
      slug: topic.slug,
      title: topic.title,
      blurb: topic.blurb,
      category: topic.category,
      originKind: topic.origin.kind,
      originTemplateId,
      cadence: topic.cadence ?? 'daily',
      // Required on Topic, but defaulted here the way `cadence` is: a Topic
      // assembled by a caller that predates the field still gets the window the
      // glossary names rather than a null reaching the pipeline.
      clusterWindowDays: topic.clusterWindowDays ?? DEFAULT_CLUSTER_WINDOW_DAYS,
      createdAt: topic.createdAt,
      removedAt: topic.removedAt,
      // Written rather than defaulted, because an insert is not how a User stops
      // being emailed: that arrives later as an update, from a link in a brief
      // or from the settings screen.
      unsubscribedAt: topic.unsubscribedAt,
    });
  }

  async listByUser(userId: UserId): Promise<readonly Topic[]> {
    const tplRows = (await this.db
      .select()
      .from(topics)
      .where(and(eq(topics.userId, userId), isNull(topics.removedAt)))
      .orderBy(asc(topics.createdAt))) as readonly TopicRow[];
    if (tplRows.length === 0) return [];
    const ids = tplRows.map((r) => r.id);
    const linkRows = (await this.db
      .select()
      .from(topicSources)
      .where(
        inArray(topicSources.topicId, ids),
      )
      .orderBy(asc(topicSources.topicId), asc(topicSources.position))) as readonly TopicSourceRow[];
    const sourcesByTopic = groupSourcesByTopic(linkRows);
    return tplRows.map((row) =>
      rowToTopic(row, sourcesByTopic.get(row.id) ?? []),
    );
  }

  async listAll(): Promise<readonly Topic[]> {
    const tplRows = (await this.db
      .select()
      .from(topics)
      .where(isNull(topics.removedAt))
      .orderBy(asc(topics.createdAt))) as readonly TopicRow[];
    if (tplRows.length === 0) return [];
    const ids = tplRows.map((r) => r.id);
    const linkRows = (await this.db
      .select()
      .from(topicSources)
      .where(inArray(topicSources.topicId, ids))
      .orderBy(asc(topicSources.topicId), asc(topicSources.position))) as readonly TopicSourceRow[];
    const sourcesByTopic = groupSourcesByTopic(linkRows);
    return tplRows.map((row) =>
      rowToTopic(row, sourcesByTopic.get(row.id) ?? []),
    );
  }

  async getById(id: TopicId): Promise<Topic | null> {
    const tplRows = (await this.db
      .select()
      .from(topics)
      .where(and(eq(topics.id, id), isNull(topics.removedAt)))) as readonly TopicRow[];
    const row = tplRows[0];
    if (!row) return null;
    const linkRows = (await this.db
      .select()
      .from(topicSources)
      .where(eq(topicSources.topicId, id))
      .orderBy(asc(topicSources.position))) as readonly TopicSourceRow[];
    const sourceIds = linkRows.map((l) => l.sourceId);
    return rowToTopic(row, sourceIds);
  }

  async findBySlug(userId: UserId, slug: string): Promise<Topic | null> {
    const rows = (await this.db
      .select()
      .from(topics)
      .where(
        and(
          eq(topics.userId, userId),
          eq(topics.slug, slug),
          isNull(topics.removedAt),
        ),
      )) as readonly TopicRow[];
    const row = rows[0];
    if (!row) return null;
    const linkRows = (await this.db
      .select()
      .from(topicSources)
      .where(eq(topicSources.topicId, row.id))
      .orderBy(asc(topicSources.position))) as readonly TopicSourceRow[];
    return rowToTopic(row, linkRows.map((l) => l.sourceId));
  }

  async insertTopicSource(
    topicId: TopicId,
    sourceId: string,
    position: number,
  ): Promise<void> {
    await this.db.insert(topicSources).values({
      topicId,
      sourceId,
      position,
    });
  }

  async remove(id: TopicId, removedAt: Date): Promise<void> {
    await this.db
      .update(topics)
      .set({ removedAt })
      .where(and(eq(topics.id, id), isNull(topics.removedAt)));
  }

  async listSlugsByUser(userId: UserId): Promise<readonly string[]> {
    const rows = (await this.db
      .select({ slug: topics.slug })
      .from(topics)
      .where(eq(topics.userId, userId))) as { slug: string }[];
    return rows.map((r) => r.slug);
  }

  async setClusterWindowDays(id: TopicId, days: number): Promise<void> {
    await this.db
      .update(topics)
      .set({ clusterWindowDays: clampClusterWindowDays(days) })
      .where(eq(topics.id, id));
  }

  async setUnsubscribedAt(id: TopicId, at: Date | null): Promise<void> {
    await this.db.update(topics).set({ unsubscribedAt: at }).where(eq(topics.id, id));
  }
}
