import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { topics } from '../db/schema.js';
import { createTestDb } from '../testing/test-db.js';
import { makeTopic } from '../testing/fixtures.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleUserRepo } from './user-repo.js';

describe('DrizzleTopicRepo soft delete', () => {
  let db: Db;
  let topicRepo: DrizzleTopicRepo;

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    const userRepo = new DrizzleUserRepo(db);
    topicRepo = new DrizzleTopicRepo(db);

    await userRepo.insert({
      id: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      onboardingState: 'completed',
      tier: 'free',
    });
    await userRepo.insert({
      id: 'user-2',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      onboardingState: 'completed',
      tier: 'free',
    });
    await topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'user-1' }));
    await topicRepo.insert(makeTopic({ id: 'topic-2', userId: 'user-1' }));
    await topicRepo.insert(makeTopic({ id: 'topic-3', userId: 'user-2' }));
  });

  /** The row is deliberately unreachable through the public interface. */
  async function rawRemovedAt(id: string): Promise<Date | null> {
    const rows = await db.select().from(topics).where(eq(topics.id, id));
    return rows[0]?.removedAt ?? null;
  }

  it('hides a removed topic from listByUser', async () => {
    await topicRepo.remove('topic-1', new Date('2026-02-01T00:00:00Z'));

    const mine = await topicRepo.listByUser('user-1');
    expect(mine.map((t) => t.id)).toEqual(['topic-2']);
  });

  it('hides a removed topic from listAll, which drives the ingest pipeline', async () => {
    await topicRepo.remove('topic-3', new Date('2026-02-01T00:00:00Z'));

    const all = await topicRepo.listAll();
    expect(all.map((t) => t.id)).toEqual(['topic-1', 'topic-2']);
  });

  it('stops a removed topic resolving by id, which drives clustering', async () => {
    await topicRepo.remove('topic-1', new Date('2026-02-01T00:00:00Z'));

    expect(await topicRepo.getById('topic-1')).toBeNull();
  });

  it("leaves other users' topics alone", async () => {
    await topicRepo.remove('topic-1', new Date('2026-02-01T00:00:00Z'));

    expect(await topicRepo.listByUser('user-2')).toHaveLength(1);
  });

  it('lists the slugs of removed topics too, so re-adding cannot collide', async () => {
    await topicRepo.remove('topic-1', new Date('2026-02-01T00:00:00Z'));

    const slugs = await topicRepo.listSlugsByUser('user-1');
    expect([...slugs].sort()).toEqual(['topic-1', 'topic-2']);
  });

  it('keeps the row so its brief history survives', async () => {
    const removedAt = new Date('2026-02-01T00:00:00Z');
    await topicRepo.remove('topic-1', removedAt);

    // Soft, not hard: the row is still there, stamped rather than deleted.
    expect(await rawRemovedAt('topic-1')).toEqual(removedAt);
  });

  it('does not move the removal time on a second remove', async () => {
    const first = new Date('2026-02-01T00:00:00Z');
    await topicRepo.remove('topic-1', first);
    await topicRepo.remove('topic-1', new Date('2026-03-01T00:00:00Z'));

    expect(await rawRemovedAt('topic-1')).toEqual(first);
  });
});
