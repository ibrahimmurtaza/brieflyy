import { and, eq, gte, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  articleEntities,
  articles,
  entities,
  type ArticleEntityRow,
  type ArticleRow,
  type EntityRow,
} from '../db/schema.js';
import type {
  Article,
  ArticleId,
  EntityId,
  SourceId,
  StoryId,
} from '../domain/types.js';

function rowToArticle(
  row: ArticleRow,
  entityRows: readonly EntityRow[],
): Article {
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

export interface ArticleRepo {
  insert(input: {
    readonly article: Article;
    readonly entityIds: readonly EntityId[];
  }): Promise<void>;
  findByExternalId(
    sourceId: SourceId,
    externalId: string,
  ): Promise<Article | null>;
  findByFingerprintInWindow(input: {
    readonly sourceId: SourceId;
    readonly fingerprint: string;
    readonly windowStart: Date;
  }): Promise<readonly Article[]>;
  assignToStory(articleId: ArticleId, storyId: StoryId): Promise<void>;
  listByStory(storyId: StoryId): Promise<readonly Article[]>;
}

export class DrizzleArticleRepo implements ArticleRepo {
  constructor(private readonly db: Db) {}

  async insert(input: {
    readonly article: Article;
    readonly entityIds: readonly EntityId[];
  }): Promise<void> {
    await this.db.insert(articles).values({
      id: input.article.id,
      sourceId: input.article.sourceId,
      externalId: input.article.externalId,
      url: input.article.url,
      title: input.article.title,
      body: input.article.body,
      publishedAt: input.article.publishedAt,
      ingestedAt: input.article.ingestedAt,
      fingerprint: input.article.fingerprint,
      storyId: input.article.storyId,
    });
    for (const entityId of input.entityIds) {
      await this.db
        .insert(articleEntities)
        .values({ articleId: input.article.id, entityId })
        .onConflictDoNothing();
    }
  }

  async findByExternalId(
    sourceId: SourceId,
    externalId: string,
  ): Promise<Article | null> {
    const rows = (await this.db
      .select()
      .from(articles)
      .where(
        and(
          eq(articles.sourceId, sourceId),
          eq(articles.externalId, externalId),
        ),
      )) as readonly ArticleRow[];
    const row = rows[0];
    if (!row) return null;
    const byArticle = await this.loadEntitiesByArticleId([row.id]);
    return rowToArticle(row, byArticle.get(row.id) ?? []);
  }

  async findByFingerprintInWindow(input: {
    readonly sourceId: SourceId;
    readonly fingerprint: string;
    readonly windowStart: Date;
  }): Promise<readonly Article[]> {
    const rows = (await this.db
      .select()
      .from(articles)
      .where(
        and(
          eq(articles.sourceId, input.sourceId),
          eq(articles.fingerprint, input.fingerprint),
          gte(articles.publishedAt, input.windowStart),
        ),
      )) as readonly ArticleRow[];
    if (rows.length === 0) return [];
    const byArticle = await this.loadEntitiesByArticleId(
      rows.map((r) => r.id),
    );
    return rows.map((row) => rowToArticle(row, byArticle.get(row.id) ?? []));
  }

  async assignToStory(articleId: ArticleId, storyId: StoryId): Promise<void> {
    await this.db
      .update(articles)
      .set({ storyId })
      .where(eq(articles.id, articleId));
  }

  async listByStory(storyId: StoryId): Promise<readonly Article[]> {
    const rows = (await this.db
      .select()
      .from(articles)
      .where(eq(articles.storyId, storyId))) as readonly ArticleRow[];
    if (rows.length === 0) return [];
    const byArticle = await this.loadEntitiesByArticleId(rows.map((r) => r.id));
    return rows.map((row) => rowToArticle(row, byArticle.get(row.id) ?? []));
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
      )) as readonly ArticleEntityRow[];
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
      )) as readonly EntityRow[];
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
}