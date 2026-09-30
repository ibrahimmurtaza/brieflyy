import { eq, and } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  briefSnapshots,
  type BriefSnapshotRow,
} from '../db/schema.js';
import type {
  BriefSnapshot,
  UserId,
  TopicId,
} from '../domain/types.js';

function rowToBriefSnapshot(row: BriefSnapshotRow): BriefSnapshot {
  return {
    id: row.id,
    briefPlanId: row.briefPlanId,
    userId: row.userId as UserId,
    topicId: row.topicId as TopicId,
    createdAt: new Date(row.createdAt),
    html: row.html,
    text: row.text,
    unsubscribeToken: row.unsubscribeToken,
    globalUnsubscribeToken: row.globalUnsubscribeToken,
  };
}

export interface BriefSnapshotRepo {
  insert(snapshot: BriefSnapshot): Promise<void>;
  /**
   * One snapshot, or null when there is none or it is not this User's. The
   * ownership condition is part of the lookup rather than a check the caller
   * remembers to make, because the id arrives in a URL and a `findById` at the
   * call site is one forgotten comparison away from showing a User another
   * User's brief.
   */
  findByIdForUser(userId: string, id: string): Promise<BriefSnapshot | null>;
  listByTopicAndUser(userId: string, topicId: string): Promise<readonly BriefSnapshot[]>;
}

export class DrizzleBriefSnapshotRepo implements BriefSnapshotRepo {
  constructor(private readonly db: Db) {}

  async insert(snapshot: BriefSnapshot): Promise<void> {
    await this.db.insert(briefSnapshots).values({
      id: snapshot.id,
      briefPlanId: snapshot.briefPlanId,
      userId: snapshot.userId,
      topicId: snapshot.topicId,
      createdAt: snapshot.createdAt,
      html: snapshot.html,
      text: snapshot.text,
      unsubscribeToken: snapshot.unsubscribeToken,
      globalUnsubscribeToken: snapshot.globalUnsubscribeToken,
    });
  }

  async findByIdForUser(userId: string, id: string): Promise<BriefSnapshot | null> {
    const rows = (await this.db
      .select()
      .from(briefSnapshots)
      .where(
        and(
          eq(briefSnapshots.id, id),
          eq(briefSnapshots.userId, userId),
        ),
      )) as readonly BriefSnapshotRow[];
    const row = rows[0];
    return row ? rowToBriefSnapshot(row) : null;
  }

  async listByTopicAndUser(
    userId: string,
    topicId: string,
  ): Promise<readonly BriefSnapshot[]> {
    const rows = (await this.db
      .select()
      .from(briefSnapshots)
      .where(
        and(
          eq(briefSnapshots.userId, userId),
          eq(briefSnapshots.topicId, topicId),
        ),
      )
      .orderBy(briefSnapshots.createdAt)) as readonly BriefSnapshotRow[];
    return rows.map(rowToBriefSnapshot);
  }
}
