import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { users, type UserRow } from '../db/schema.js';
import { DEFAULT_TIER, isTier } from '../domain/tier.js';
import type { OnboardingState, Tier, User, UserId } from '../domain/types.js';

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    createdAt: row.createdAt,
    onboardingState: row.onboardingState as OnboardingState,
    // A row that predates the column, or one written outside the application,
    // has no tier in it. Reading that as the free tier keeps the paywalls
    // closed rather than open by accident.
    tier: isTier(row.tier) ? row.tier : DEFAULT_TIER,
  };
}

export interface UserRepo {
  insert(user: User): Promise<void>;
  getById(id: UserId): Promise<User | null>;
  setOnboardingState(id: UserId, state: OnboardingState): Promise<void>;
  setTier(id: UserId, tier: Tier): Promise<void>;
  /** Remove a User whose Account could not be created, so none is left stranded. */
  delete(id: UserId): Promise<void>;
}

export class DrizzleUserRepo implements UserRepo {
  constructor(private readonly db: Db) {}

  async insert(user: User): Promise<void> {
    await this.db.insert(users).values({
      id: user.id,
      createdAt: user.createdAt,
      onboardingState: user.onboardingState,
      tier: user.tier,
    });
  }

  async getById(id: UserId): Promise<User | null> {
    const rows = await this.db.select().from(users).where(eq(users.id, id));
    const row = rows[0];
    return row ? rowToUser(row) : null;
  }

  async setOnboardingState(
    id: UserId,
    state: OnboardingState,
  ): Promise<void> {
    await this.db
      .update(users)
      .set({ onboardingState: state })
      .where(eq(users.id, id));
  }

  async setTier(id: UserId, tier: Tier): Promise<void> {
    await this.db.update(users).set({ tier }).where(eq(users.id, id));
  }

  async delete(id: UserId): Promise<void> {
    await this.db.delete(users).where(eq(users.id, id));
  }
}