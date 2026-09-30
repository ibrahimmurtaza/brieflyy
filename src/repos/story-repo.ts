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
    /** When the Article being placed was published. */
    readonly publishedAt: Date;
    /** How far the Article's date may sit from a Story's own range. */
    readonly windowMs: number;
  }): Promise<readonly Story[]>;
  /**
   * The Stories at least one of these Sources has Articles in, seen since
   * `windowStart`.
   */
  listBySourceIdsInWindow(input: {
    readonly sourceIds: readonly SourceId[];
    readonly windowStart: Date;
  }): Promise<readonly Story[]>;
  insert(input: {
    readonly id: StoryId;
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
   *
   * There is no Source in the lookup, and that is the point rather than a
   * simplification: an Article is compared with every Story published near it,
   * whichever outlet that Story's copies came from. Scoping the candidates to one
   * Source made syndicated coverage of one story arrive as one Story per outlet,
   * which is the case a Story exists to collapse. The cost is that the candidate
   * set is now every Story in the window rather than one feed's, so it grows with
   * how much the whole registry published in three days; the window itself is
   * unchanged, and its upper bound is the indexed one.
   */
  async listCandidates(input: {
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
          gte(stories.firstPublishedAt, earliest),
          lte(stories.lastPublishedAt, latest),
        ),
      )
      .orderBy(asc(stories.lastPublishedAt))) as readonly StoryRow[];
    return this.hydrateMany(rows);
  }

  /**
   * The Stories a set of Sources has Articles in.
   *
   * Which Sources a Story belongs to is read off its Articles rather than off a
   * column on the Story, so the join is the lookup: a Story is in scope for a
   * Topic when any Source the Topic follows reported it. Filtering on a single
   * Source per Story would drop a syndicated Story from every Topic that follows
   * an outlet other than the one that happened to be polled first.
   */
  async listBySourceIdsInWindow(input: {
    readonly sourceIds: readonly SourceId[];
    readonly windowStart: Date;
  }): Promise<readonly Story[]> {
    if (input.sourceIds.length === 0) return [];
    const selected = await this.db
      .selectDistinct({ story: stories })
      .from(stories)
      .innerJoin(articles, eq(articles.storyId, stories.id))
      .where(
        and(
          inArray(articles.sourceId, input.sourceIds),
          gte(stories.lastSeenAt, input.windowStart),
        ),
      )
      .orderBy(asc(stories.lastSeenAt));
    return this.hydrateMany(selected.map((row) => row.story));
  }

  /**
   * Hydrate a set of Stories, counting their Articles and collecting the Sources
   * they came from in one query rather than one or two per Story. Ingest reads
   * the candidates near every Article it places, so a per-Story count turns a
   * busy poll into thousands of queries.
   */
  private async hydrateMany(rows: readonly StoryRow[]): Promise<Story[]> {
    if (rows.length === 0) return [];
    const tallies = await this.db
      .select({
        storyId: articles.storyId,
        sourceId: articles.sourceId,
        total: sql<number>`count(*)`,
      })
      .from(articles)
      .where(
        inArray(
          articles.storyId,
          rows.map((r) => r.id),
        ),
      )
      .groupBy(articles.storyId, articles.sourceId);
    const counts = new Map<string, number>();
    const sourceIds = new Map<string, Set<SourceId>>();
    for (const tally of tallies) {
      if (tally.storyId === null) continue;
      counts.set(
        tally.storyId,
        (counts.get(tally.storyId) ?? 0) + tally.total,
      );
      const sources = sourceIds.get(tally.storyId) ?? new Set<SourceId>();
      sources.add(tally.sourceId as SourceId);
      sourceIds.set(tally.storyId, sources);
    }
    return rows.map((row) =>
      this.toStory(row, counts.get(row.id) ?? 0, sourceIds.get(row.id) ?? new Set()),
    );
  }

  private toStory(
    row: StoryRow,
    articleCount: number,
    sourceIds: ReadonlySet<SourceId>,
  ): Story {
    return {
      id: row.id as StoryId,
      sourceIds: [...sourceIds].sort(),
      signature: decodeSignature(row.signature),
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      published: { first: row.firstPublishedAt, last: row.lastPublishedAt },
      articleCount,
    };
  }

  async insert(input: {
    readonly id: StoryId;
    readonly signature: StorySignature;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
    readonly published: PublishedRange;
  }): Promise<Story> {
    await this.db.insert(stories).values({
      id: input.id,
      signature: encodeSignature(input.signature),
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      firstPublishedAt: input.published.first,
      lastPublishedAt: input.published.last,
    });
    // The Story has no Articles yet, and it has no Source of its own: the Source
    // it belongs to is a fact about the Articles in it, and the first one is
    // written a line later.
    const story: Story = {
      id: input.id,
      sourceIds: [],
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
    if (rows.length === 0) return null;
    const [story] = await this.hydrateMany(rows);
    return story ?? null;
  }
}
