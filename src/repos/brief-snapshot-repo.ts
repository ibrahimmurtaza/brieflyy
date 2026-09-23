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
    unsubscribeToken: row.unsubscribeToken,
    globalUnsubscribeToken: row.globalUnsubscribeToken,
  };
}

export interface BriefSnapshotRepo {
  insert(snapshot: BriefSnapshot): Promise<void>;
  findById(id: string): Promise<BriefSnapshot | null>;
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
      unsubscribeToken: snapshot.unsubscribeToken,
      globalUnsubscribeToken: snapshot.globalUnsubscribeToken,
    });
  }

  async findById(id: string): Promise<BriefSnapshot | null> {
    const rows = (await this.db
      .select()
      .from(briefSnapshots)
      .where(eq(briefSnapshots.id, id))) as readonly BriefSnapshotRow[];
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
