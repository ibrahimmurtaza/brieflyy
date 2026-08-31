import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { accounts, type AccountRow } from '../db/schema.js';
import type { Account, AccountId, UserId } from '../domain/types.js';

function rowToAccount(row: AccountRow): Account {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    emailVerifiedAt: row.emailVerifiedAt,
    createdAt: row.createdAt,
  };
}

export interface AccountRepo {
  insert(account: Account): Promise<void>;
  getById(id: AccountId): Promise<Account | null>;
  getByEmail(email: string): Promise<Account | null>;
  getByUserId(userId: UserId): Promise<Account | null>;
  markEmailVerified(id: AccountId, at: Date): Promise<void>;
}

export class DrizzleAccountRepo implements AccountRepo {
  constructor(private readonly db: Db) {}

  async insert(account: Account): Promise<void> {
    await this.db.insert(accounts).values({
      id: account.id,
      userId: account.userId,
      email: account.email,
      emailVerifiedAt: account.emailVerifiedAt,
      createdAt: account.createdAt,
    });
  }

  async getById(id: AccountId): Promise<Account | null> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.id, id));
    const row = rows[0];
    return row ? rowToAccount(row) : null;
  }

  async getByEmail(email: string): Promise<Account | null> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.email, email));
    const row = rows[0];
    return row ? rowToAccount(row) : null;
  }

  async getByUserId(userId: UserId): Promise<Account | null> {
    const rows = await this.db
      .select()
      .from(accounts)
      .where(eq(accounts.userId, userId));
    const row = rows[0];
    return row ? rowToAccount(row) : null;
  }

  async markEmailVerified(id: AccountId, at: Date): Promise<void> {
    await this.db
      .update(accounts)
      .set({ emailVerifiedAt: at })
      .where(eq(accounts.id, id));
  }
}