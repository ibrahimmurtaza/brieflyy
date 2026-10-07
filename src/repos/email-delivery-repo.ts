import { eq, and } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  emailDeliveries,
  type EmailDeliveryRow,
} from '../db/schema.js';
import type {
  EmailDelivery,
  UserId,
  TopicId,
} from '../domain/types.js';

function rowToEmailDelivery(row: EmailDeliveryRow): EmailDelivery {
  return {
    id: row.id,
    userId: row.userId as UserId,
    briefSnapshotId: row.briefSnapshotId,
    topicId: row.topicId as TopicId,
    sentAt: new Date(row.sentAt),
    outcome: row.outcome,
    unsubscribeToken: row.unsubscribeToken,
    globalUnsubscribeToken: row.globalUnsubscribeToken,
    generation: {
      writtenClusters: row.writtenClusters,
      calls: row.generationCalls,
      discardedBullets: row.discardedBullets,
    },
  };
}

export interface EmailDeliveryRepo {
  /**
   * Record one send attempt, whether or not the transport took the message. A
   * refusal is a row with `outcome: 'refused'` rather than no row at all, so an
   * attempt that was turned down can be told from a brief nobody asked for.
   */
  insert(delivery: EmailDelivery): Promise<void>;
  findBySnapshotId(snapshotId: string): Promise<readonly EmailDelivery[]>;
  /**
   * The delivery a per-Topic unsubscribe token was minted for, or null.
   *
   * The token is the whole authorisation, so the lookup is by value and returns
   * the User and Topic the unsubscribe applies to rather than taking them from
   * the caller: a URL that carried its own idea of whose subscription to change
   * would be a URL a forwarded brief could aim anywhere.
   */
  findByUnsubscribeToken(token: string): Promise<EmailDelivery | null>;
  /** The same, for the token that stops every brief for the User. */
  findByGlobalUnsubscribeToken(token: string): Promise<EmailDelivery | null>;
}

export class DrizzleEmailDeliveryRepo implements EmailDeliveryRepo {
  constructor(private readonly db: Db) {}

  async insert(delivery: EmailDelivery): Promise<void> {
    await this.db.insert(emailDeliveries).values({
      id: delivery.id,
      userId: delivery.userId,
      briefSnapshotId: delivery.briefSnapshotId,
      topicId: delivery.topicId,
      sentAt: delivery.sentAt,
      outcome: delivery.outcome,
      unsubscribeToken: delivery.unsubscribeToken,
      globalUnsubscribeToken: delivery.globalUnsubscribeToken,
      writtenClusters: delivery.generation.writtenClusters,
      generationCalls: delivery.generation.calls,
      discardedBullets: delivery.generation.discardedBullets,
    });
  }

  async findBySnapshotId(snapshotId: string): Promise<readonly EmailDelivery[]> {
    const rows = (await this.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.briefSnapshotId, snapshotId))) as readonly EmailDeliveryRow[];
    return rows.map(rowToEmailDelivery);
  }

  async findByUnsubscribeToken(token: string): Promise<EmailDelivery | null> {
    const row = (await this.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.unsubscribeToken, token))) as readonly EmailDeliveryRow[];
    return row[0] ? rowToEmailDelivery(row[0]) : null;
  }

  async findByGlobalUnsubscribeToken(token: string): Promise<EmailDelivery | null> {
    const row = (await this.db
      .select()
      .from(emailDeliveries)
      .where(
        eq(emailDeliveries.globalUnsubscribeToken, token),
      )) as readonly EmailDeliveryRow[];
    return row[0] ? rowToEmailDelivery(row[0]) : null;
  }
}
