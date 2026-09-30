import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { unsubscribes, type UnsubscribeRow } from '../db/schema.js';
import type {
  TopicId,
  Unsubscribe,
  UnsubscribeScope,
  UserId,
} from '../domain/types.js';

function rowToUnsubscribe(row: UnsubscribeRow): Unsubscribe {
  return {
    id: row.id,
    userId: row.userId as UserId,
    topicId: (row.topicId ?? null) as TopicId | null,
    scope: row.scope as UnsubscribeScope,
    emailDeliveryId: row.emailDeliveryId,
    token: row.token,
    createdAt: row.createdAt,
  };
}

export interface UnsubscribeRepo {
  /**
   * Record a spent token. Throws when the token has already been spent, because
   * the unique index on `token` is the single-use property — the service treats
   * that failure as `already_used` rather than re-deriving it from a read.
   */
  insert(unsubscribe: Unsubscribe): Promise<void>;
  /** The row a token was spent against, or null when it has never been used. */
  findByToken(token: string): Promise<Unsubscribe | null>;
}

export class DrizzleUnsubscribeRepo implements UnsubscribeRepo {
  constructor(private readonly db: Db) {}

  async insert(unsubscribe: Unsubscribe): Promise<void> {
    await this.db.insert(unsubscribes).values({
      id: unsubscribe.id,
      userId: unsubscribe.userId,
      topicId: unsubscribe.topicId,
      emailDeliveryId: unsubscribe.emailDeliveryId,
      scope: unsubscribe.scope,
      token: unsubscribe.token,
      createdAt: unsubscribe.createdAt,
    });
  }

  async findByToken(token: string): Promise<Unsubscribe | null> {
    const rows = (await this.db
      .select()
      .from(unsubscribes)
      .where(eq(unsubscribes.token, token))) as readonly UnsubscribeRow[];
    return rows[0] ? rowToUnsubscribe(rows[0]) : null;
  }
}
