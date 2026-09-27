import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { magicLinks, type MagicLinkRow } from '../db/schema.js';
import type { AccountId, MagicLink, MagicLinkId } from '../domain/types.js';

function rowToMagicLink(row: MagicLinkRow): MagicLink {
  return {
    id: row.id,
    accountId: row.accountId,
    email: row.email,
    tokenHash: row.tokenHash,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
    consumedAt: row.consumedAt,
  };
}

export interface MagicLinkRepo {
  insert(link: MagicLink): Promise<void>;
  getByTokenHash(tokenHash: string): Promise<MagicLink | null>;
  /** Point a link at the account it turned into, once one exists. */
  attachAccount(id: MagicLinkId, accountId: AccountId): Promise<void>;
  markConsumed(id: MagicLinkId, at: Date): Promise<void>;
}

export class DrizzleMagicLinkRepo implements MagicLinkRepo {
  constructor(private readonly db: Db) {}

  async insert(link: MagicLink): Promise<void> {
    await this.db.insert(magicLinks).values({
      id: link.id,
      accountId: link.accountId,
      email: link.email,
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

  async attachAccount(id: MagicLinkId, accountId: AccountId): Promise<void> {
    await this.db
      .update(magicLinks)
      .set({ accountId })
      .where(eq(magicLinks.id, id));
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
