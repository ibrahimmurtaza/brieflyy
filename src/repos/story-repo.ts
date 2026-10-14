import { and, asc, eq, gt, gte, inArray, lte, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { articles, stories, type StoryRow } from '../db/schema.js';
import { decodeSignature, encodeSignature } from '../domain/story-signature.js';
import type { StorySignature } from '../domain/story-signature.js';
import { decodeEmbedding, encodeEmbedding } from '../domain/embedding.js';
import type { StoryEmbedding } from '../domain/embedding.js';
import type {
  PublishedRange,
  SourceId,
  Story,
  StoryId,
} from '../domain/types.js';

/**
 * A Story carrying no embedding, and the Article whose text one would be taken
 * from.
 *
 * Title and body rather than the text itself, because joining a headline to a
 * body is `articleText`'s decision and it is the same decision formation makes —
 * two readers joining them differently is how the two halves of one Story's
 * identity came to disagree once (see ADR-0037).
 */
export interface UnembeddedStory {
  readonly id: StoryId;
  /** Null where the Story holds no Article to take a reading from. */
  readonly title: string | null;
  readonly body: string | null;
}

/**
 * The rows `decodeEmbedding` reads as carrying no embedding.
 *
 * Every case the decoder answers `null` for that SQL can see: an absent column,
 * and a vector or a model half-migrated away from its other. The two are named
 * separately in `stories` and were added separately by the migration, so a row
 * carrying one without the other is a state this database can actually be in —
 * and it reads as no embedding everywhere else, so leaving it there would leave a
 * Story nothing will ever fill in.
 *
 * Deliberately *not* everything the decoder refuses: a value it cannot decode is
 * not detectable here, and a Story carrying one is left alone rather than
 * overwritten, because the vector is the only reading that Story has.
 *
 * One predicate for the read and the write, so the Stories a backfill offers and
 * the Stories it will accept are the same set. Two copies of this would be two
 * answers, and the gap between them would be a re-run that quietly replaces
 * vectors.
 */
const CARRIES_NO_EMBEDDING = sql`(
  ${stories.embedding} IS NULL
  OR ${stories.embeddingModel} IS NULL
  OR TRIM(${stories.embeddingModel}) = ''
)`;

/**
 * The Article that formed a Story, which is its oldest.
 *
 * A Story's signature and its embedding are both fixed by the Article that created
 * it, and the oldest Article in a Story is that one by construction: a Story's
 * published range can only grow towards newer Articles, since `listCandidates`
 * only offers a Story an Article fits inside the window of. Taking the newest
 * instead would embed a syndication copy rather than the report the Story is a
 * reading of, and two Stories whose newest copies happened to match would compare
 * alike for a reason nobody chose.
 *
 * Ordered by publication and then by id so the choice is the same one every time
 * the row is read: two Articles published at the same instant are ordered by
 * something stored rather than by whatever SQLite happened to return first.
 */
const FORMING_ARTICLE = sql`${articles}.id = (
  SELECT a.id FROM ${articles} a
  WHERE a.story_id = ${stories}.id
  ORDER BY a.published_at, a.id
  LIMIT 1
)`;

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
  /**
   * The Stories carrying no embedding, with the Article one would be taken from,
   * a page at a time.
   *
   * A Story holding **no Article** comes back with nothing to read rather than
   * not coming back. It cannot be embedded — there is no text to embed — but it
   * is still carrying no vector, and a reader that dropped it would let a corpus
   * holding one print as a corpus where nothing was left to do. One Story is
   * inserted before its first Article is attached, so this is the window a cycle
   * runs in rather than a shape no database reaches.
   *
   * Paged by `limit` and resumable by `after`, because a backfill walks this
   * repeatedly — once per batch, and again on the next run of the command — and
   * has to move forwards whether or not the last page was a success. A Story
   * nothing could embed is still carrying none when the next page is asked for, so
   * a reader that started at the beginning every time would ask about the same
   * failures for ever. Ordered by id because that is a fact stored rather than one
   * SQLite returns differently twice.
   */
  listUnembedded(input: {
    readonly limit: number;
    /** Start after this Story, so a run continues where the last one stopped. */
    readonly after?: StoryId | undefined;
  }): Promise<readonly UnembeddedStory[]>;
  insert(input: {
    readonly id: StoryId;
    readonly signature: StorySignature;
    /**
     * The vector for the Article that formed this Story, or none.
     *
     * Stated rather than optional: absence is a state this is designed for, and a
     * caller that can leave it out is a caller whose formation path does not have
     * to answer whether the deployment embeds at all.
     */
    readonly embedding: StoryEmbedding | null;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
    readonly published: PublishedRange;
  }): Promise<Story>;
  /**
   * Put an embedding on a Story carrying none, and say whether it did.
   *
   * The condition is in the statement rather than in the caller, because this is
   * the one write in the application that can be aimed at a row that already
   * holds a vector — a backfill over a corpus formed while the deployment was
   * embedding carries both. **It never overwrites one**: an existing vector is
   * the Article's own second reading, computed once at formation, and replacing
   * it with a later model would make the Story disagree with every other Story
   * formed since — and would report progress while doing it.
   *
   * The answer is `false` in that case rather than a throw, because a second run
   * of a backfill that finds nothing is the correct outcome and not a failure.
   */
  backfillEmbedding(id: StoryId, embedding: StoryEmbedding): Promise<boolean>;
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
      // Read back through the one decoder, so a row whose two columns disagree is
      // read as carrying none rather than as whichever half survived.
      embedding: decodeEmbedding(row.embedding, row.embeddingModel),
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      published: { first: row.firstPublishedAt, last: row.lastPublishedAt },
      articleCount,
      state: (row.state as 'active' | 'archive') ?? 'active',
    };
  }

  /**
   * The Stories carrying no embedding, each with the Article one would be taken
   * from, a page at a time.
   *
   * One query rather than a page of reads: a corpus of any size is walked in
   * batches, and asking each Story for its own oldest Article would turn a
   * backfill into a query per Story before a single vector was asked for.
   */
  async listUnembedded(input: {
    readonly limit: number;
    readonly after?: StoryId | undefined;
  }): Promise<readonly UnembeddedStory[]> {
    const rows = await this.db
      .select({ id: stories.id, title: articles.title, body: articles.body })
      .from(stories)
      // Left rather than inner, so a Story holding no Article is reported as
      // carrying no embedding with nothing to embed from rather than being
      // dropped: dropping it is what lets a corpus holding one read as a corpus
      // that had nothing left to do.
      .leftJoin(articles, and(eq(articles.storyId, stories.id), FORMING_ARTICLE))
      .where(
        input.after === undefined ? CARRIES_NO_EMBEDDING : and(CARRIES_NO_EMBEDDING, gt(stories.id, input.after)),
      )
      .orderBy(asc(stories.id))
      .limit(input.limit);
    return rows.map((row) => ({ id: row.id as StoryId, title: row.title, body: row.body }));
  }

  async insert(input: {
    readonly id: StoryId;
    readonly signature: StorySignature;
    readonly embedding: StoryEmbedding | null;
    readonly firstSeenAt: Date;
    readonly lastSeenAt: Date;
    readonly published: PublishedRange;
  }): Promise<Story> {
    await this.db.insert(stories).values({
      id: input.id,
      signature: encodeSignature(input.signature),
      // Both halves or neither, so a later reader cannot hold one without the other.
      ...(input.embedding === null
        ? { embedding: null, embeddingModel: null }
        : {
            embedding: encodeEmbedding(input.embedding),
            embeddingModel: input.embedding.model,
          }),
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      firstPublishedAt: input.published.first,
      lastPublishedAt: input.published.last,
    });
    // The Story has no Articles yet, and it has no Source of its own: the Source
    // it belongs to is a fact about the Articles in it, and the first one is
    // written a line later. Its state is Active for the same reason: it was just
    // formed out of reporting happening now, and only the pass that decides which
    // Clusters are Active may say otherwise.
    const story: Story = {
      id: input.id,
      sourceIds: [],
      signature: input.signature,
      embedding: input.embedding,
      firstSeenAt: input.firstSeenAt,
      lastSeenAt: input.lastSeenAt,
      published: input.published,
      articleCount: 0,
      state: 'active',
    };
    return story;
  }

  async backfillEmbedding(id: StoryId, embedding: StoryEmbedding): Promise<boolean> {
    const rows = await this.db
      .update(stories)
      .set({ embedding: encodeEmbedding(embedding), embeddingModel: embedding.model })
      .where(and(eq(stories.id, id), CARRIES_NO_EMBEDDING))
      .returning({ id: stories.id });
    return rows.length > 0;
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
