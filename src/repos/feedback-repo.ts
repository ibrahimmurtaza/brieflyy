import { and, desc, eq, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { feedbackEvents, type FeedbackEventRow } from '../db/schema.js';
import type {
  ClusterId,
  FeedbackEvent,
  FeedbackType,
  SourceId,
  UserId,
} from '../domain/types.js';

export interface FeedbackRepo {
  insert(event: FeedbackEvent): Promise<void>;
  listByUserAndCluster(userId: UserId, clusterId: ClusterId): Promise<readonly FeedbackEvent[]>;
  /**
   * The latest event per `(userId, clusterId, feedbackType)`, which is the
   * audit trail read as ADR 0004 means it: every event is kept, and this is the
   * one in force for each type.
   */
  listLatestByUserAndCluster(userId: UserId, clusterId: ClusterId): Promise<readonly FeedbackEvent[]>;
  /**
   * Every event a User has given, newest first.
   *
   * Ordered, because the read side reduces it by "latest wins" — a signal that
   * has been replaced and an Article's propagated weight are both decided by
   * walking this in order, and a caller that got the rows in insertion order
   * would reach the opposite answer.
   */
  listByUser(userId: UserId): Promise<readonly FeedbackEvent[]>;
}

function rowToFeedbackEvent(row: FeedbackEventRow): FeedbackEvent {
  return {
    id: row.id,
    userId: row.userId as UserId,
    clusterId: row.clusterId as ClusterId,
    feedbackType: row.feedbackType as FeedbackType,
    scope: row.scope ? (row.scope as 'this_topic' | 'global') : null,
    sourceId: (row.sourceId ?? null) as SourceId | null,
    timestamp: row.timestamp,
  };
}

export class DrizzleFeedbackRepo implements FeedbackRepo {
  constructor(private readonly db: Db) {}

  async insert(event: FeedbackEvent): Promise<void> {
    await this.db.insert(feedbackEvents).values({
      id: event.id,
      userId: event.userId,
      clusterId: event.clusterId,
      feedbackType: event.feedbackType,
      scope: event.scope,
      sourceId: event.sourceId,
      timestamp: event.timestamp,
    });
  }

  async listByUserAndCluster(userId: UserId, clusterId: ClusterId): Promise<readonly FeedbackEvent[]> {
    const rows = (await this.db
      .select()
      .from(feedbackEvents)
      .where(
        and(
          eq(feedbackEvents.userId, userId),
          eq(feedbackEvents.clusterId, clusterId),
        ),
      )
      .orderBy(desc(feedbackEvents.timestamp), desc(sql`rowid`))) as readonly FeedbackEventRow[];
    return rows.map(rowToFeedbackEvent);
  }

  async listLatestByUserAndCluster(userId: UserId, clusterId: ClusterId): Promise<readonly FeedbackEvent[]> {
    const rows = (await this.db
      .select()
      .from(feedbackEvents)
      .where(
        and(
          eq(feedbackEvents.userId, userId),
          eq(feedbackEvents.clusterId, clusterId),
        ),
      )
      .orderBy(desc(feedbackEvents.timestamp), desc(sql`rowid`))) as readonly FeedbackEventRow[];
    // Latest event per feedback type (latest wins per spec / ADR 0004)
    const latestByType = new Map<string, FeedbackEvent>();
    for (const row of rows) {
      if (!latestByType.has(row.feedbackType)) {
        latestByType.set(row.feedbackType, rowToFeedbackEvent(row));
      }
    }
    return Array.from(latestByType.values());
  }

  async listByUser(userId: UserId): Promise<readonly FeedbackEvent[]> {
    const rows = (await this.db
      .select()
      .from(feedbackEvents)
      .where(eq(feedbackEvents.userId, userId))
      // Rowid breaks ties on the timestamp. Two signals given within the same
      // millisecond would otherwise come back in whatever order SQLite chose, and
      // "the latest event wins" would then be whichever of the two happened to be
      // written second as far as the query was concerned — so a User pressing one
      // button and then the other could be shown the first press as the current
      // signal. Rowid is insertion order, which is the order the User pressed them.
      .orderBy(desc(feedbackEvents.timestamp), desc(sql`rowid`))) as readonly FeedbackEventRow[];
    return rows.map(rowToFeedbackEvent);
  }
}
