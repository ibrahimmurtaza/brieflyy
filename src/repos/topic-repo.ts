import { and, asc, eq, inArray, isNull, max } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { DEFAULT_CLUSTER_WINDOW_DAYS, clampClusterWindowDays } from '../domain/cluster-window.js';
import {
  topicSources,
  topics,
  type TopicRow,
  type TopicSourceRow,
} from '../db/schema.js';
import {
  DEFAULT_WEEKLY_DAY,
  type Cadence,
  type SourceId,
  type Topic,
  type TopicId,
  type TopicOrigin,
  type TopicTemplate,
  type UserId,
  type Weekday,
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
    cadenceDay: row.cadenceDay ?? null,
    clusterWindowDays: row.clusterWindowDays,
    createdAt: row.createdAt,
    removedAt: row.removedAt ?? null,
    unsubscribedAt: row.unsubscribedAt ?? null,
  };
}

/**
 * The day a Cadence stores, given what the User submitted.
 *
 * A weekly Cadence is never stored without one, because "every week" is not an
 * answer the daily job could act on and a null here is a Topic that has silently
 * stopped briefing. Every other Cadence stores none, so the column keeps meaning
 * one thing: the day this Topic briefs on when it is weekly.
 */
function cadenceDayToStore(cadence: Cadence, day: Weekday | null): Weekday | null {
  return cadence === 'weekly' ? (day ?? DEFAULT_WEEKLY_DAY) : null;
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
  /**
   * Create every one of these Topics, with their Sources, as a single unit.
   *
   * A User picks several Topics in one submission, so "several Topics" is the
   * unit the User means and not three writes that happen to follow one another: a
   * failure on the second left the first committed, and a retry then hit the
   * free-tier cap with Topics the User never finished choosing — a User holding
   * two of their three, unable to pick a third and unable to finish onboarding.
   *
   * The Sources go in with the Topic rather than after it, because a Topic row
   * with no links to its Sources is a Topic that briefs nothing, and one that is
   * rolled back must take the links with it.
   */
  insertMany(topics: readonly Topic[]): Promise<void>;
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
   * Follow this Topic with one more Source, after the ones it already has.
   *
   * A Source it already follows is left alone rather than refused: the User asked
   * for it to be on this Topic and it is, and the link form cannot tell that
   * apart from a first time.
   */
  addSource(topicId: TopicId, sourceId: SourceId): Promise<void>;
  /**
   * Stop following a Source. The User chose what this Topic reads from, so the
   * list has to be shortenable as well as lengthenable — and the remaining order
   * is closed up afterwards, because position is the order the User chose rather
   * than a gap-tolerant index.
   *
   * Scoped by Topic, so removing one from a Topic nobody else follows does not
   * take it off another User's Topic that does.
   */
  removeSource(topicId: TopicId, sourceId: SourceId): Promise<void>;
  /**
   * Soft delete. The row stays so its brief plans and snapshots remain
   * readable, but the topic stops resolving for listings and for the ingest and
   * cluster pipelines, and it stops counting toward the free-tier cap.
   */
  remove(id: TopicId, removedAt: Date): Promise<void>;
  /**
   * Soft delete several of a User's Topics at once.
   *
   * One statement rather than several, because the caller is removing a whole group
   * — the Topics over the cap when a paid plan ends — and six statements can leave
   * three of them removed. It is the same soft delete as `remove`, with the same
   * guard against writing a second date onto a row that already has one, and the
   * same promise: the row stays, so the Topic's brief history is readable and its
   * slug still belongs to the User.
   *
   * Scoped by nothing but the ids, because every id in it was resolved against one
   * User's own Topics by the caller. That is stated rather than enforced here, and
   * it is the one obligation on a caller of a batch method — a batch removal that
   * took a User's argument for authority over whose Topics it was would remove
   * somebody else's.
   */
  removeMany(ids: readonly TopicId[], removedAt: Date): Promise<void>;
  /**
   * Every slug the user has ever held, including removed ones. The unique
   * index on (user_id, slug) still spans soft-deleted rows, so slug allocation
   * has to see them or re-adding a removed topic raises a constraint error.
   */
  listSlugsByUser(userId: UserId): Promise<readonly string[]>;
  /**
   * How often, and on which day, this Topic briefs.
   *
   * The day is only meaningful for a weekly Cadence and is resolved to a real one
   * before it is stored, so a row cannot come to mean "every week, on no
   * particular day" — which is the one reading of this pair the scheduler has no
   * answer for.
   */
  setCadence(id: TopicId, cadence: Cadence, day: Weekday | null): Promise<void>;
  /**
   * Change what this Topic is called. The slug is deliberately untouched: it is
   * the Topic's address, briefs link to it, and a User who has shared one should
   * not find it broken because they retyped a title.
   */
  rename(id: TopicId, title: string): Promise<void>;
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

/**
 * The columns a Topic is stored as, so the single insert and the batch insert
 * cannot come to describe different rows.
 */
function topicRowValues(topic: Topic) {
  return {
    id: topic.id,
    userId: topic.userId,
    slug: topic.slug,
    title: topic.title,
    blurb: topic.blurb,
    category: topic.category,
    originKind: topic.origin.kind,
    originTemplateId: topic.origin.kind === 'template' ? topic.origin.templateId : null,
    cadence: topic.cadence ?? 'daily',
    cadenceDay: cadenceDayToStore(topic.cadence ?? 'daily', topic.cadenceDay ?? null),
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
  };
}

export class DrizzleTopicRepo implements TopicRepo {
  constructor(private readonly db: Db) {}

  async insert(topic: Topic): Promise<void> {
    await this.db.insert(topics).values(topicRowValues(topic));
  }

  async insertMany(batch: readonly Topic[]): Promise<void> {
    if (batch.length === 0) return;
    // better-sqlite3 transactions are synchronous, so every statement is written
    // without awaiting inside the callback: an `await` there would commit before
    // the rest of the batch had run, which is the partial write this exists to
    // prevent rather than a transaction at all.
    this.db.transaction((tx) => {
      for (const topic of batch) {
        tx.insert(topics).values(topicRowValues(topic)).run();
        topic.sourceIds.forEach((sourceId, position) => {
          tx.insert(topicSources).values({ topicId: topic.id, sourceId, position }).run();
        });
      }
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

  async addSource(topicId: TopicId, sourceId: SourceId): Promise<void> {
    await this.db.transaction((tx) => {
      // One statement that either links the Source or changes nothing, so two
      // submissions racing on the same Topic cannot both pass a "does it already
      // have it" check and then one of them fail on the unique index.
      tx.insert(topicSources)
        .values({ topicId, sourceId, position: this.nextPosition(tx, topicId) })
        .onConflictDoNothing()
        .run();
    });
  }

  /** The position one past the last Source this Topic follows. */
  private nextPosition(tx: Db, topicId: TopicId): number {
    const rows = tx
      .select({ top: max(topicSources.position) })
      .from(topicSources)
      .where(eq(topicSources.topicId, topicId))
      .all() as { top: number | null }[];
    return (rows[0]?.top ?? -1) + 1;
  }

  async removeSource(topicId: TopicId, sourceId: SourceId): Promise<void> {
    await this.db.transaction((tx) => {
      tx.delete(topicSources)
        .where(and(eq(topicSources.topicId, topicId), eq(topicSources.sourceId, sourceId)))
        .run();
      // Renumbered from zero, so position stays the order the User chose rather
      // than an index with holes in it. Read inside the same transaction as the
      // delete, or the renumbering would be computed against the rows that are
      // still there.
      const remaining = tx
        .select({ sourceId: topicSources.sourceId })
        .from(topicSources)
        .where(eq(topicSources.topicId, topicId))
        .orderBy(asc(topicSources.position))
        .all();
      remaining.forEach((row, index) => {
        tx.update(topicSources)
          .set({ position: index })
          .where(
            and(eq(topicSources.topicId, topicId), eq(topicSources.sourceId, row.sourceId)),
          )
          .run();
      });
    });
  }

  async remove(id: TopicId, removedAt: Date): Promise<void> {
    await this.db
      .update(topics)
      .set({ removedAt })
      .where(and(eq(topics.id, id), isNull(topics.removedAt)));
  }

  async removeMany(ids: readonly TopicId[], removedAt: Date): Promise<void> {
    if (ids.length === 0) return;
    await this.db
      .update(topics)
      .set({ removedAt })
      .where(and(inArray(topics.id, [...ids]), isNull(topics.removedAt)));
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

  async setCadence(id: TopicId, cadence: Cadence, day: Weekday | null): Promise<void> {
    await this.db
      .update(topics)
      .set({ cadence, cadenceDay: cadenceDayToStore(cadence, day) })
      .where(eq(topics.id, id));
  }

  async rename(id: TopicId, title: string): Promise<void> {
    await this.db.update(topics).set({ title }).where(eq(topics.id, id));
  }

  async setUnsubscribedAt(id: TopicId, at: Date | null): Promise<void> {
    await this.db.update(topics).set({ unsubscribedAt: at }).where(eq(topics.id, id));
  }
}
