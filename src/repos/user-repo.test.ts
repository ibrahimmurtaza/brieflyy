import { describe, expect, it } from 'vitest';

import { users } from '../db/schema.js';
import { createTestDb } from '../testing/test-db.js';
import { makeUser } from '../testing/fixtures.js';
import { DrizzleUserRepo } from './user-repo.js';

function makeHarness() {
  const { db, driver } = createTestDb();
  return { db, driver, repo: new DrizzleUserRepo(db) };
}

describe('DrizzleUserRepo', () => {
  it('reads back a User it inserted, with the tier it was given', async () => {
    const { repo } = makeHarness();
    await repo.insert(makeUser({ id: 'user-paid', tier: 'paid' }));
    expect(await repo.getById('user-paid')).toMatchObject({ tier: 'paid' });
  });

  it('moves a User between tiers and reads the new tier back', async () => {
    const { repo } = makeHarness();
    await repo.insert(makeUser({ id: 'user-switch', tier: 'free' }));

    await repo.setTier('user-switch', 'paid');
    expect((await repo.getById('user-switch'))?.tier).toBe('paid');

    await repo.setTier('user-switch', 'free');
    expect((await repo.getById('user-switch'))?.tier).toBe('free');
  });

  it('leaves the rest of the User alone when the tier changes', async () => {
    const { repo } = makeHarness();
    await repo.insert(
      makeUser({ id: 'user-keep', onboardingState: 'delivery_set', tier: 'free' }),
    );
    await repo.setTier('user-keep', 'paid');
    expect(await repo.getById('user-keep')).toMatchObject({
      onboardingState: 'delivery_set',
      tier: 'paid',
    });
  });

  it('defaults the column to the free tier for a row written without one', async () => {
    const { driver } = makeHarness();
    driver
      .prepare(
        `INSERT INTO users (id, created_at) VALUES ('user-legacy', 1767225600000)`,
      )
      .run();
    const row = driver
      .prepare(`SELECT tier FROM users WHERE id = 'user-legacy'`)
      .get() as { tier: string };
    expect(row.tier).toBe('free');
  });

  it('returns null for a User that does not exist', async () => {
    const { repo } = makeHarness();
    expect(await repo.getById('nobody')).toBeNull();
  });

  it('deletes a User', async () => {
    const { db, repo } = makeHarness();
    await repo.insert(makeUser({ id: 'user-gone' }));
    await repo.delete('user-gone');
    expect(await repo.getById('user-gone')).toBeNull();
    const remaining = await db.select().from(users);
    expect(remaining).toEqual([]);
  });
});
