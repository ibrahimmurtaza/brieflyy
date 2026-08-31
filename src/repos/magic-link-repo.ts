import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { magicLinks, type MagicLinkRow } from '../db/schema.js';
import type { MagicLink, MagicLinkId } from '../domain/types.js';

function rowToMagicLink(row: MagicLinkRow): MagicLink {
  return {
    id: row.id,
    accountId: row.accountId,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

export interface MagicLinkRepo {
  insert(link: MagicLink): Promise<void>;
  getByTokenHash(tokenHash: string): Promise<MagicLink | null>;
  markConsumed(id: MagicLinkId, at: Date): Promise<void>;
}

export class DrizzleMagicLinkRepo implements MagicLinkRepo {
  constructor(private readonly db: Db) {}

  async insert(link: MagicLink): Promise<void> {
    await this.db.insert(magicLinks).values({
      id: link.id,
      accountId: link.accountId,
      tokenHash: link.tokenHash,
      createdAt: link.createdAt,
      expiresAt: link.expiresAt,
      consumedAt: link.consumedAt,
    });
  }

  async getByTokenHash(tokenHash: string): Promise<MagicLink | null> {
    const rows = await this.db
      .select()
      .from(magicLinks)
      .where(eq(magicLinks.tokenHash, tokenHash));
    const row = rows[0];
    return row ? rowToMagicLink(row) : null;
  }

  async markConsumed(id: MagicLinkId, at: Date): Promise<void> {
    await this.db
      .update(magicLinks)
      .set({ consumedAt: at })
      .where(eq(magicLinks.id, id));
  }
}

export function isMagicLinkUsable(
  link: MagicLink,
  now: Date,
): boolean {
  return link.consumedAt === null && link.expiresAt.getTime() > now.getTime();
}