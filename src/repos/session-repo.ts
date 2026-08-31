import { eq, lt } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { sessions, type SessionRow } from '../db/schema.js';
import type { Session, SessionId } from '../domain/types.js';

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    userId: row.userId,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    revokedAt: row.revokedAt,
  };
}

export interface SessionRepo {
  insert(session: Session): Promise<void>;
  getById(id: SessionId): Promise<Session | null>;
  revoke(id: SessionId, at: Date): Promise<void>;
  deleteExpired(now: Date): Promise<number>;
}

export class DrizzleSessionRepo implements SessionRepo {
  constructor(private readonly db: Db) {}

  async insert(session: Session): Promise<void> {
    await this.db.insert(sessions).values({
      id: session.id,
      userId: session.userId,
      createdAt: session.createdAt,
      expiresAt: session.expiresAt,
      revokedAt: session.revokedAt,
    });
  }

  async getById(id: SessionId): Promise<Session | null> {
    const rows = await this.db
      .select()
      .from(sessions)
      .where(eq(sessions.id, id));
    const row = rows[0];
    return row ? rowToSession(row) : null;
  }

  async revoke(id: SessionId, at: Date): Promise<void> {
    await this.db
      .update(sessions)
      .set({ revokedAt: at })
      .where(eq(sessions.id, id));
  }

  async deleteExpired(now: Date): Promise<number> {
    const result = await this.db
      .delete(sessions)
      .where(lt(sessions.expiresAt, now))
      .returning();
    return result.length;
  }
}