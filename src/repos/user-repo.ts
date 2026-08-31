import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { users, type UserRow } from '../db/schema.js';
import type { OnboardingState, User, UserId } from '../domain/types.js';

function rowToUser(row: UserRow): User {
  return {
    id: row.id,
    createdAt: row.createdAt,
    onboardingState: row.onboardingState as OnboardingState,
  };
}

export interface UserRepo {
  insert(user: User): Promise<void>;
  getById(id: UserId): Promise<User | null>;
  setOnboardingState(id: UserId, state: OnboardingState): Promise<void>;
}

export class DrizzleUserRepo implements UserRepo {
  constructor(private readonly db: Db) {}

  async insert(user: User): Promise<void> {
    await this.db.insert(users).values({
      id: user.id,
      createdAt: user.createdAt,
      onboardingState: user.onboardingState,
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
}