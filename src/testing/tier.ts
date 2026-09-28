import { resolveTier } from '../domain/tier.js';
import type { Tier, User } from '../domain/types.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { makeUser } from './fixtures.js';
import { createTestDb } from './test-db.js';

/**
 * A User persisted at a given tier and read back out of the database.
 *
 * The paywall behaviours are the one place where a test has to put a User on a
 * tier to see anything happen, so this goes through the same write and read the
 * application does. A literal would let a test pass while the column, the repo
 * and the resolver disagreed.
 */
export async function persistedUserAtTier(tier: Tier): Promise<User> {
  const { db } = createTestDb();
  const repo = new DrizzleUserRepo(db);
  const id = `user-${tier}`;
  await repo.insert(makeUser({ id, tier }));
  const read = await repo.getById(id);
  if (!read) throw new Error(`user ${id} vanished straight after being written`);
  return read;
}

/** The tier of a persisted User, as the application resolves it. */
export async function tierOfPersistedUser(tier: Tier): Promise<Tier> {
  return resolveTier(await persistedUserAtTier(tier));
}
