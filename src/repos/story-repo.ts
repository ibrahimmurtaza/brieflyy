import { and, asc, eq, gte, inArray, lte, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { articles, stories, type StoryRow } from '../db/schema.js';
import { decodeSignature, encodeSignature } from '../domain/story-signature.js';
import type { StorySignature } from '../domain/story-signature.js';
import type {
  PublishedRange,
  SourceId,
  Story,
  StoryId,
} from '../domain/types.js';

export interface StoryRepo {
  listCandidates(input: {
    readonly sourceId: SourceId;
    /** When the Article being placed was published. */
    readonly publishedAt: Date;
    /** How far the Article's date may sit from a Story's own range. */
    readonly windowMs: number;
  }): Promise<readonly Story[]>;
  listBySourceIdsInWindow(input: {
    readonly sourceIds: readonly SourceId[];
    readonly windowStart: Date;
  }): Promise<readonly Story[]>;
  insert(input: {
    readonly id: StoryId;
    readonly sourceId: SourceId;
    readonly signature: StorySignature;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
    readonly published: PublishedRange;
  }): Promise<Story>;
  touch(id: StoryId, at: Date): Promise<void>;
  /** Widen a Story's published range to take in an Article joining it. */
  widenPublishedRange(id: StoryId, publishedAt: Date): Promise<void>;
  countArticles(storyId: StoryId): Promise<number>;
  getById(id: StoryId): Promise<Story | null>;
}

export class DrizzleStoryRepo implements StoryRepo {
  constructor(private readonly db: Db) {}

  /**
   * The Stories an Article published at `publishedAt` could belong to.
   *
   * The window is measured from publication on both sides, so it is a fact about
   * when the reporting happened rather than about when a poll happened to bring
   * it in. A feed that re-lists a month-old article today is therefore compared
   * with the Stories its own date puts it beside, and forms a Story of its own
   * rather than being folded into whatever is being reported this week.
   *
   * The two bounds are crossed deliberately. Testing that the Story's range and
   * the Article's date overlap would be the looser reading, and it lets a Story's
   * range grow: a chain of copies each within the window of the last would walk
   * a single Story arbitrarily far from the first Article in it, which is the
   * same bug as measuring the window from the poll. These bounds instead admit
   * only Articles that keep the range inside the window, so every Story is within
   * one window of its own oldest Article by construction.
   */
  async listCandidates(input: {
    readonly sourceId: SourceId;
    readonly publishedAt: Date;
    readonly windowMs: number;
  }): Promise<readonly Story[]> {
    const earliest = new Date(input.publishedAt.getTime() - input.windowMs);
    const latest = new Date(input.publishedAt.getTime() + input.windowMs);
    const rows = (await this.db
      .select()
      .from(stories)
      .where(
        and(
          eq(stories.sourceId, input.sourceId),
          gte(stories.firstPublishedAt, earliest),
          lte(stories.lastPublishedAt, latest),
        ),
      )
      .orderBy(asc(stories.lastPublishedAt))) as readonly StoryRow[];
    return this.hydrateMany(rows);
  }

  async listBySourceIdsInWindow(input: {
    readonly sourceIds: readonly SourceId[];
    readonly windowStart: Date;
  }): Promise<readonly Story[]> {
    if (input.sourceIds.length === 0) return [];
    const rows = (await this.db
      .select()
      .from(stories)
      .where(
        and(
          inArray(stories.sourceId, input.sourceIds),
          gte(stories.lastSeenAt, input.windowStart),
        ),
      )
      .orderBy(asc(stories.lastSeenAt))) as readonly StoryRow[];
    return this.hydrateMany(rows);
  }

  private async hydrate(row: StoryRow): Promise<Story> {
    const articleCount = await this.countArticles(row.id as StoryId);
    return this.toStory(row, articleCount);
  }

  /**
   * Hydrate a set of Stories, counting their Articles in one query rather than
   * one per Story. Ingest reads the candidates near every Article it places, so
   * a per-Story count turns a busy poll into thousands of queries.
   */
  private async hydrateMany(rows: readonly StoryRow[]): Promise<Story[]> {
    if (rows.length === 0) return [];
    const counts = await this.db
      .select({
        storyId: articles.storyId,
        total: sql<number>`count(*)`,
      })
      .from(articles)
      .where(
        inArray(
          articles.storyId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(articles.storyId);
    const byStory = new Map(counts.map((c) => [c.storyId, c.total]));
    return rows.map((row) => this.toStory(row, byStory.get(row.id) ?? 0));
  }

  private toStory(row: StoryRow, articleCount: number): Story {
    return {
      id: row.id as StoryId,
      sourceId: row.sourceId as SourceId,
      signature: decodeSignature(row.signature),
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      published: { first: row.firstPublishedAt, last: row.lastPublishedAt },
      articleCount,
    };
  }

  async insert(input: {
    readonly id: StoryId;
    readonly sourceId: SourceId;
    readonly signature: StorySignature;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
    readonly published: PublishedRange;
  }): Promise<Story> {
    await this.db.insert(stories).values({
      id: input.id,
      sourceId: input.sourceId,
      signature: encodeSignature(input.signature),
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      firstPublishedAt: input.published.first,
      lastPublishedAt: input.published.last,
    });
    const story: Story = {
      id: input.id,
      sourceId: input.sourceId,
      signature: input.signature,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      published: input.published,
      articleCount: 0,
    };
    return story;
  }

  async touch(id: StoryId, at: Date): Promise<void> {
    await this.db
      .update(stories)
      .set({ lastSeenAt: at })
      .where(eq(stories.id, id));
  }

  /**
   * Widen a Story's published range to cover an Article joining it. The range
   * only ever grows: a copy that was published before the Story's oldest Article
   * is still part of the same event, and narrowing to fit would lose the fact
   * that it was. It cannot grow past the window either, because `listCandidates`
   * only offers a Story the Article fits inside.
   */
  async widenPublishedRange(id: StoryId, publishedAt: Date): Promise<void> {
    await this.db
      .update(stories)
      .set({
        firstPublishedAt: sql`MIN(first_published_at, ${publishedAt.getTime()})`,
        lastPublishedAt: sql`MAX(last_published_at, ${publishedAt.getTime()})`,
      })
      .where(eq(stories.id, id));
  }

  async countArticles(storyId: StoryId): Promise<number> {
    const rows = await this.db
      .select()
      .from(articles)
      .where(eq(articles.storyId, storyId));
    return rows.length;
  }

  async getById(id: StoryId): Promise<Story | null> {
    const rows = (await this.db
      .select()
      .from(stories)
      .where(eq(stories.id, id))) as readonly StoryRow[];
    const row = rows[0];
    if (!row) return null;
    return this.hydrate(row);
  }
}
