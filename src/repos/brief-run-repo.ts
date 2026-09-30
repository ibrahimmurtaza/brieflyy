import { and, desc, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { briefRuns, type BriefRunRow } from '../db/schema.js';
import type { DeliverySlot } from '../domain/delivery-slot.js';
import type { BriefRun, TopicId, UserId } from '../domain/types.js';

function rowToBriefRun(row: BriefRunRow): BriefRun {
  return {
    id: row.id,
    userId: row.userId as UserId,
    topicId: row.topicId as TopicId,
    scheduledFor: new Date(row.scheduledFor),
    sentAt: new Date(row.sentAt),
    briefSnapshotId: row.briefSnapshotId,
  };
}

export interface BriefRunRepo {
  insert(run: BriefRun): Promise<void>;
/**
   * The run that already answered this Topic's DeliverySlot, or null when the
   * DeliverySlot is still owed. Scoped by all three parts of the key rather than by
   * User alone, because one pass answers one Topic at a DeliverySlot while leaving
   * the User's other Topics owed.
   */
  findBySlot(
    userId: UserId,
    topicId: TopicId,
    slot: DeliverySlot,
  ): Promise<BriefRun | null>;
  /**
   * Every DeliverySlot this User's Topics have been answered for, most recent
   * first — the order a reader of their own brief history wants them in, and the
   * same order the job's own passes come back in.
   */
  listByUser(userId: UserId): Promise<readonly BriefRun[]>;
}

export class DrizzleBriefRunRepo implements BriefRunRepo {
  constructor(private readonly db: Db) {}

  async insert(run: BriefRun): Promise<void> {
    await this.db.insert(briefRuns).values({
      id: run.id,
      userId: run.userId,
      topicId: run.topicId,
      scheduledFor: run.scheduledFor,
      sentAt: run.sentAt,
      briefSnapshotId: run.briefSnapshotId,
    });
  }

  async findBySlot(
    userId: UserId,
    topicId: TopicId,
    slot: DeliverySlot,
  ): Promise<BriefRun | null> {
    const rows = (await this.db
      .select()
      .from(briefRuns)
      .where(
        and(
          eq(briefRuns.userId, userId),
          eq(briefRuns.topicId, topicId),
          eq(briefRuns.scheduledFor, slot),
        ),
      )) as readonly BriefRunRow[];
    const row = rows[0];
    return row ? rowToBriefRun(row) : null;
  }

  async listByUser(userId: UserId): Promise<readonly BriefRun[]> {
    const rows = (await this.db
      .select()
      .from(briefRuns)
      .where(eq(briefRuns.userId, userId))
      .orderBy(desc(briefRuns.scheduledFor))) as readonly BriefRunRow[];
    return rows.map(rowToBriefRun);
  }
}

