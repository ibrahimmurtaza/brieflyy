import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { deliverySettings } from '../db/schema.js';
import { createTestDb } from '../testing/test-db.js';
import { DrizzleDeliverySettingsRepo } from './delivery-settings-repo.js';
import { DrizzleUserRepo } from './user-repo.js';

async function makeHarness() {
  const { db } = createTestDb();
  const userRepo = new DrizzleUserRepo(db);
  const repo = new DrizzleDeliverySettingsRepo(db);
  const userId = 'user-test';
  await userRepo.insert({
    id: userId,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    onboardingState: 'topics_picked',
  });
  return { db, repo, userId, userRepo };
}

describe('DrizzleDeliverySettingsRepo', () => {
  beforeEach(() => {
    // fresh in-memory db per test
  });

  it('returns null for a user with no settings row', async () => {
    const { repo, userId } = await makeHarness();
    expect(await repo.getByUserId(userId)).toBeNull();
  });

  it('upserts and reads back a settings row', async () => {
    const { db, repo, userId } = await makeHarness();
    const updated = new Date('2026-02-02T03:04:05Z');
    await repo.upsert({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
      welcomeSentAt: null,
      updatedAt: updated,
    });
    const got = await repo.getByUserId(userId);
    expect(got).toEqual({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
      welcomeSentAt: null,
      updatedAt: updated,
    });
    const rows = await db.select().from(deliverySettings).where(eq(deliverySettings.userId, userId));
    expect(rows).toHaveLength(1);
  });

  it('replaces the existing row on a second upsert (single row per user)', async () => {
    const { db, repo, userId } = await makeHarness();
    await repo.upsert({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
      welcomeSentAt: null,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });
    await repo.upsert({
      userId,
      hour: 9,
      minute: 30,
      timezone: 'Asia/Tokyo',
      welcomeSentAt: null,
      updatedAt: new Date('2026-01-02T00:00:00Z'),
    });
    const rows = await db.select().from(deliverySettings).where(eq(deliverySettings.userId, userId));
    expect(rows).toHaveLength(1);
    const got = await repo.getByUserId(userId);
    expect(got?.hour).toBe(9);
    expect(got?.minute).toBe(30);
    expect(got?.timezone).toBe('Asia/Tokyo');
  });

  it('records a welcomeSentAt timestamp when set', async () => {
    const { repo, userId } = await makeHarness();
    const sent = new Date('2026-02-02T03:04:05Z');
    await repo.upsert({
      userId,
      hour: 8,
      minute: 0,
      timezone: 'UTC',
      welcomeSentAt: sent,
      updatedAt: sent,
    });
    const got = await repo.getByUserId(userId);
    expect(got?.welcomeSentAt).toEqual(sent);
  });
});
