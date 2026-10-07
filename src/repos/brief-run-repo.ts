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
    sentAt: row.sentAt === null ? null : new Date(row.sentAt),
    briefSnapshotId: row.briefSnapshotId,
  };
}

/**
 * A DeliverySlot being claimed, which is everything a run is except its send
 * time.
 *
 * A shape of its own rather than a `BriefRun` with a null in it, because there is
 * no send time to pass: a claim is written before the transport has been asked and
 * the moment it went out is exactly what the caller does not know yet. Taking a
 * `BriefRun` here would invite the one field the caller has no answer for.
 */
export interface BriefRunClaim {
  readonly id: string;
  readonly userId: UserId;
  readonly topicId: TopicId;
  readonly scheduledFor: DeliverySlot;
  readonly briefSnapshotId: string;
}

export interface BriefRunRepo {
  /**
   * Take the DeliverySlot, before the transport is asked for anything.
   *
   * The claim, not the receipt: it is written with no send time and settled by
   * `markSent` once the transport has answered, so a pass that dies in between
   * leaves the slot claimed rather than offered to the next pass a second time.
   *
   * Null when the slot is already claimed, which is one answer for the two ways
   * that happens — another pass is inside the send right now, or one died inside
   * it — because the caller cannot act differently on the two and should not be
   * asked to tell them apart. The unique index on (user, topic, scheduled_for)
   * is what decides it, which is why this returns rather than throwing.
   */
  claim(claim: BriefRunClaim): Promise<BriefRun | null>;
  /** Settle a claim the transport took, so the run says when. */
  markSent(id: string, sentAt: Date): Promise<void>;
  /**
   * Give a claimed DeliverySlot back: the transport refused the message, so
   * nothing reached the User and the next pass owes it to them again.
   */
  release(id: string): Promise<void>;
  /**
   * The run that already claimed this Topic's DeliverySlot, or null when the
   * DeliverySlot is still owed. Scoped by all three parts of the key rather than by
   * User alone, because one pass answers one Topic at a DeliverySlot while leaving
   * the User's other Topics owed.
   *
   * A claim is an answer for the purposes of this question, which is why the read
   * rather than the write is what keeps every ordinary pass from planning a brief
   * it is not going to send.
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

  async claim(claim: BriefRunClaim): Promise<BriefRun | null> {
    const rows = (await this.db
      .insert(briefRuns)
      .values({
        id: claim.id,
        userId: claim.userId,
        topicId: claim.topicId,
        scheduledFor: claim.scheduledFor,
        // No send time, because the transport has not been asked yet. A run that
        // claims a moment it does not have is the lie this shape exists to
        // prevent, and it is why `BriefRunClaim` does not carry the field.
        sentAt: null,
        briefSnapshotId: claim.briefSnapshotId,
      })
      .onConflictDoNothing()
      .returning()) as readonly BriefRunRow[];
    const row = rows[0];
    return row ? rowToBriefRun(row) : null;
  }

  async markSent(id: string, sentAt: Date): Promise<void> {
    await this.db
      .update(briefRuns)
      .set({ sentAt })
      .where(eq(briefRuns.id, id));
  }

  async release(id: string): Promise<void> {
    await this.db.delete(briefRuns).where(eq(briefRuns.id, id));
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

