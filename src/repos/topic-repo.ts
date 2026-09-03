import { and, asc, eq, inArray } from 'drizzle-orm';

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
    createdAt: row.createdAt,
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
  insertTopicSource(
    topicId: TopicId,
    sourceId: string,
    position: number,
  ): Promise<void>;
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
      createdAt: topic.createdAt,
    });
  }

  async listByUser(userId: UserId): Promise<readonly Topic[]> {
    const tplRows = (await this.db
      .select()
      .from(topics)
      .where(eq(topics.userId, userId))
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
}
