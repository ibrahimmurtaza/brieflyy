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
    unsubscribeToken: row.unsubscribeToken,
    globalUnsubscribeToken: row.globalUnsubscribeToken,
  };
}

export interface EmailDeliveryRepo {
  insert(delivery: EmailDelivery): Promise<void>;
  findBySnapshotId(snapshotId: string): Promise<readonly EmailDelivery[]>;
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
      unsubscribeToken: delivery.unsubscribeToken,
      globalUnsubscribeToken: delivery.globalUnsubscribeToken,
    });
  }

  async findBySnapshotId(snapshotId: string): Promise<readonly EmailDelivery[]> {
    const rows = (await this.db
      .select()
      .from(emailDeliveries)
      .where(eq(emailDeliveries.briefSnapshotId, snapshotId))) as readonly EmailDeliveryRow[];
    return rows.map(rowToEmailDelivery);
  }
}
