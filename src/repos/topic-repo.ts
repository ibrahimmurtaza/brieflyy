import { and, asc, eq, inArray, isNull } from 'drizzle-orm';

import type { Db } from '../db/client.js';
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
    createdAt: row.createdAt,
    removedAt: row.removedAt ?? null,
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
      createdAt: topic.createdAt,
      removedAt: topic.removedAt,
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
      .where(eq(topics.userId, userId))) as readonly { slug: string }[];
    return rows.map((r) => r.slug);
  }
}
