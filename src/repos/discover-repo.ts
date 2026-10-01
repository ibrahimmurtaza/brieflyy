import { and, count, eq, gte, inArray, isNull, lt } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  articleEntities,
  articles,
  topicSources,
  topics,
  topicTemplateSources,
} from '../db/schema.js';
import { loadTopicTemplates } from './directory-repo.js';
import type {
  DiscoverTemplate,
  EntityId,
  SourceId,
  SourceVolume,
  TopicId,
  TopicTemplateId,
  UserId,
  UserTopicSignal,
} from '../domain/types.js';

type PairRow = { ownerId: string; entityId: string };
type VolumeRow = { sourceId: string; articleCount: number };
type TopicLinkRow = { topicId: string; sourceId: string };
type TopicHeadRow = { id: string; title: string; originTemplateId: string | null };

/**
 * The period every measurement on the DiscoverTab is taken over.
 *
 * Both ends, not just the start. An Article whose publication date is in the
 * future — a feed that mislabels an archive, a clock that was wrong when the row
 * was written — would otherwise be counted in "this week" indefinitely, and the
 * fix for that is a bound rather than a trust in the data.
 */
export interface DiscoverWindow {
  readonly start: Date;
  readonly end: Date;
}

function inWindow(column: typeof articles.publishedAt, window: DiscoverWindow) {
  return and(gte(column, window.start), lt(column, window.end));
}

function groupEntityIds(rows: readonly PairRow[]): Map<string, EntityId[]> {
  const out = new Map<string, EntityId[]>();
  for (const row of rows) {
    const list = out.get(row.ownerId);
    if (list) list.push(row.entityId as EntityId);
    else out.set(row.ownerId, [row.entityId as EntityId]);
  }
  for (const list of out.values()) list.sort();
  return out;
}

/**
 * What the DiscoverTab reads, measured rather than declared.
 *
 * Every method is a count or a set of ids taken from the database, and none of
 * them returns a ranking. What is trending, and what is like the User's Topics,
 * are the service's answer to compute from these — which is the whole reason the
 * earlier "trending" list, which arrived as `[{ templateId, lift }]`, could be
 * anything at all: nothing between the database and the screen had to have
 * measured anything. See ADR-0014.
 */
export interface DiscoverRepo {
  /**
   * Every Directory entry, each with the Entities its Sources wrote about inside
   * the window. An entry with no Articles in the window is still listed, with no
   * Entities: the Directory does not empty itself because nothing has been
   * written about it lately.
   */
  listTemplates(input: {
    readonly window: DiscoverWindow;
  }): Promise<readonly DiscoverTemplate[]>;

  /**
   * The User's own live Topics, each with the Directory entry it was cloned from,
   * the Sources it follows, and the Entities those Sources wrote about in the
   * window.
   *
   * Live means not soft-deleted: a removed Topic holds no slot, and a template it
   * was cloned from is one the User may pick again.
   */
  listUserTopics(input: {
    readonly userId: UserId;
    readonly window: DiscoverWindow;
  }): Promise<readonly UserTopicSignal[]>;

  /** How many Articles each Source published inside the window. */
  listSourceVolume(input: {
    readonly window: DiscoverWindow;
  }): Promise<readonly SourceVolume[]>;
}

export class DrizzleDiscoverRepo implements DiscoverRepo {
  constructor(private readonly db: Db) {}

  async listTemplates(input: {
    readonly window: DiscoverWindow;
  }): Promise<readonly DiscoverTemplate[]> {
    const templates = await loadTopicTemplates(this.db);
    if (templates.length === 0) return [];

    // The grouping is what makes this one query rather than one per entry: a pair
    // of (entry, Entity) repeated across ten Articles of the same story is one
    // shared Entity, and the overlap is what the entry is scored on.
    const pairs = (await this.db
      .select({
        ownerId: topicTemplateSources.topicTemplateId,
        entityId: articleEntities.entityId,
      })
      .from(topicTemplateSources)
      .innerJoin(articles, eq(articles.sourceId, topicTemplateSources.sourceId))
      .innerJoin(articleEntities, eq(articleEntities.articleId, articles.id))
      .where(inWindow(articles.publishedAt, input.window))
      .groupBy(
        topicTemplateSources.topicTemplateId,
        articleEntities.entityId,
      )) as readonly PairRow[];
    const entityIdsByTemplate = groupEntityIds(pairs);

    return templates.map((template) => ({
      ...template,
      entityIds: entityIdsByTemplate.get(template.id) ?? [],
    }));
  }

  async listUserTopics(input: {
    readonly userId: UserId;
    readonly window: DiscoverWindow;
  }): Promise<readonly UserTopicSignal[]> {
    const heads = (await this.db
      .select({
        id: topics.id,
        title: topics.title,
        originTemplateId: topics.originTemplateId,
      })
      .from(topics)
      .where(and(eq(topics.userId, input.userId), isNull(topics.removedAt)))
      .orderBy(topics.createdAt)) as readonly TopicHeadRow[];
    if (heads.length === 0) return [];

    const links = (await this.db
      .select({ topicId: topicSources.topicId, sourceId: topicSources.sourceId })
      .from(topicSources)
      .where(
        inArray(
          topicSources.topicId,
          heads.map((h) => h.id),
        ),
      )
      .orderBy(topicSources.topicId, topicSources.position)) as readonly TopicLinkRow[];
    const sourceIdsByTopic = new Map<string, string[]>();
    for (const link of links) {
      const list = sourceIdsByTopic.get(link.topicId);
      if (list) list.push(link.sourceId);
      else sourceIdsByTopic.set(link.topicId, [link.sourceId]);
    }

    // Scoped by the User in the statement rather than by filtering the Topics
    // above, so the Articles read are the ones that User's Topics follow. A
    // Recommendation that scored a User on another User's reading would be worse
    // than no Recommendation at all.
    const pairs = (await this.db
      .select({ ownerId: topicSources.topicId, entityId: articleEntities.entityId })
      .from(topicSources)
      .innerJoin(topics, eq(topics.id, topicSources.topicId))
      .innerJoin(articles, eq(articles.sourceId, topicSources.sourceId))
      .innerJoin(articleEntities, eq(articleEntities.articleId, articles.id))
      .where(
        and(
          eq(topics.userId, input.userId),
          isNull(topics.removedAt),
          inWindow(articles.publishedAt, input.window),
        ),
      )
      .groupBy(topicSources.topicId, articleEntities.entityId)) as readonly PairRow[];
    const entityIdsByTopic = groupEntityIds(pairs);

    return heads.map((head) => ({
      topicId: head.id as TopicId,
      title: head.title,
      clonedFromTemplateId: (head.originTemplateId ?? null) as TopicTemplateId | null,
      sourceIds: (sourceIdsByTopic.get(head.id) ?? []) as readonly SourceId[],
      entityIds: entityIdsByTopic.get(head.id) ?? [],
    }));
  }

  async listSourceVolume(input: {
    readonly window: DiscoverWindow;
  }): Promise<readonly SourceVolume[]> {
    const rows = (await this.db
      .select({ sourceId: articles.sourceId, articleCount: count() })
      .from(articles)
      .where(inWindow(articles.publishedAt, input.window))
      .groupBy(articles.sourceId)
      .orderBy(articles.sourceId)) as readonly VolumeRow[];
    return rows.map((r) => ({
      sourceId: r.sourceId as SourceId,
      articleCount: Number(r.articleCount),
    }));
  }
}