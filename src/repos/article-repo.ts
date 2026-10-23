import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  articleEntities,
  articles,
  entities,
  type ArticleEntityRow,
  type ArticleRow,
  type EntityRow,
} from '../db/schema.js';
import { decodeSignature, encodeSignature } from '../domain/story-signature.js';
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
    storyId: (row.storyId ?? null) as StoryId | null,
    entities: entityRows.map((r) => ({
      id: r.id as EntityId,
      canonicalName: r.canonicalName,
      kind: r.kind,
    })),
    // The signature an Article was matched on is part of how the pipeline
    // recognises it, so it has to come back with it. An Article written before
    // the column existed reads back empty, which says only that nothing has
    // re-signed it yet.
    signature: decodeSignature(row.signature),
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
  listBySourceIdsInWindow(input: {
    readonly sourceIds: readonly SourceId[];
    readonly windowStart: Date;
  }): Promise<readonly Article[]>;
  assignToStory(articleId: ArticleId, storyId: StoryId): Promise<void>;
  listByStory(storyId: StoryId): Promise<readonly Article[]>;
  /**
   * A page of the corpus's Articles, oldest ingested first, each carrying the
   * Entities it does now; `hasMore` says another page stands beyond this one.
   *
   * Read by the command that re-reads an Article's names, which has to walk the
   * whole corpus rather than a window of it — a rule change to what a name is
   * reaches Articles of any age — but which walks it in pages: read whole, the
   * corpus would be held in memory with every link before its first Article had
   * been read again. The page is read ahead of the count, so `hasMore` is
   * answered without a second query: one more row is fetched than asked for,
   * and our having got it is the answer.
   */
  listArticles(input: {
    readonly offset: number;
    readonly number: number;
  }): Promise<{
    readonly articles: readonly Article[];
    readonly hasMore: boolean;
  }>;
  /**
   * Put one Article's Entities exactly as given, dropping the links it had.
   *
   * The whole set is written where the old set stood, because a re-read can
   * both add a name and take one away; writing the difference would leave the
   * question of which half is stale to be asked again by the next reader.
   * The Entity rows themselves are not touched — they belong to every Article
   * that names them, so one Article stopping carrying a name is not the Entity
   * leaving the corpus.
   */
  replaceArticleEntities(input: {
    readonly articleId: ArticleId;
    readonly entityIds: readonly EntityId[];
  }): Promise<void>;
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
      signature: encodeSignature(input.article.signature),
      storyId: input.article.storyId,
    });
    this.insertEntityLinks(this.db, input.article.id, input.entityIds);
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

  async listBySourceIdsInWindow(input: {
    readonly sourceIds: readonly SourceId[];
    readonly windowStart: Date;
  }): Promise<readonly Article[]> {
    if (input.sourceIds.length === 0) return [];
    const rows = (await this.db
      .select()
      .from(articles)
      .where(
        and(
          inArray(articles.sourceId, input.sourceIds),
          gte(articles.publishedAt, input.windowStart),
        ),
      )
      .orderBy(asc(articles.publishedAt))) as readonly ArticleRow[];
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

  async listArticles(input: {
    readonly offset: number;
    readonly number: number;
  }): Promise<{
    readonly articles: readonly Article[];
    readonly hasMore: boolean;
  }> {
    const rows = (await this.db
      .select()
      .from(articles)
      .orderBy(asc(articles.ingestedAt))
      .limit(input.number + 1)
      .offset(input.offset)) as readonly ArticleRow[];
    const page = rows.slice(0, input.number);
    if (page.length === 0) return { articles: [], hasMore: false };
    const byArticle = await this.loadEntitiesByArticleId(page.map((r) => r.id));
    return {
      articles: page.map((row) =>
        rowToArticle(row, byArticle.get(row.id) ?? []),
      ),
      hasMore: rows.length > input.number,
    };
  }

  async replaceArticleEntities(input: {
    readonly articleId: ArticleId;
    readonly entityIds: readonly EntityId[];
  }): Promise<void> {
    // The delete and the insert are one write, because a run that died between
    // them would leave the Article carrying no names at all — and the re-read
    // that uses this is promised to be safe to run twice, which a half-written
    // Article is not.
    await this.db.transaction((tx) => {
      tx.delete(articleEntities)
        .where(eq(articleEntities.articleId, input.articleId))
        .run();
      this.insertEntityLinks(tx, input.articleId, input.entityIds);
    });
  }

  /**
   * The Entity links one Article carries, put down one link per name and
   * idempotently — a link that is already there is left as it is. Shared by the
   * Article's first writing and its re-read's rewriting.
   */
  private insertEntityLinks(
    executor: Db,
    articleId: ArticleId,
    entityIds: readonly EntityId[],
  ): void {
    for (const entityId of entityIds) {
      executor
        .insert(articleEntities)
        .values({ articleId, entityId })
        .onConflictDoNothing()
        .run();
    }
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