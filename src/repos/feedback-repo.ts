import { and, desc, eq, inArray } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { feedbackEvents, type FeedbackEventRow } from '../db/schema.js';
import type {
  ClusterId,
  FeedbackEvent,
  FeedbackType,
  UserId,
} from '../domain/types.js';

export interface FeedbackRepo {
  insert(event: FeedbackEvent): Promise<void>;
  listByUserAndCluster(userId: UserId, clusterId: ClusterId): Promise<readonly FeedbackEvent[]>;
  listLatestByUserAndCluster(userId: UserId, clusterId: ClusterId): Promise<readonly FeedbackEvent[]>;
  listByUser(userId: UserId): Promise<readonly FeedbackEvent[]>;
}

function rowToFeedbackEvent(row: FeedbackEventRow): FeedbackEvent {
  return {
    id: row.id,
    userId: row.userId as UserId,
    clusterId: row.clusterId as ClusterId,
    feedbackType: row.feedbackType as FeedbackType,
    scope: row.scope ? (row.scope as 'this_topic' | 'global') : null,
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
      .orderBy(desc(feedbackEvents.timestamp))) as readonly FeedbackEventRow[];
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
      .orderBy(desc(feedbackEvents.timestamp))) as readonly FeedbackEventRow[];
    return rows.map(rowToFeedbackEvent);
  }

  async listByUser(userId: UserId): Promise<readonly FeedbackEvent[]> {
    const rows = (await this.db
      .select()
      .from(feedbackEvents)
      .where(eq(feedbackEvents.userId, userId))
      .orderBy(desc(feedbackEvents.timestamp))) as readonly FeedbackEventRow[];
    return rows.map(rowToFeedbackEvent);
  }
}
