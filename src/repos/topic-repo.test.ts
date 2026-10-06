import { beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { topics, topicSources } from '../db/schema.js';
import { createTestDb } from '../testing/test-db.js';
import { countRows } from '../testing/db.js';
import { makeSource, makeTopic, makeUser } from '../testing/fixtures.js';
import { DrizzleSourceRepo } from './source-repo.js';
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

    await userRepo.insert(makeUser({ id: 'user-1', onboardingState: 'completed' }));
    await userRepo.insert(makeUser({ id: 'user-2', onboardingState: 'completed' }));
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

  it('removes a group of Topics at once, leaving the ones not named', async () => {
    await topicRepo.removeMany(['topic-1', 'topic-2'], new Date('2026-02-01T00:00:00Z'));

    expect(await topicRepo.listByUser('user-1')).toEqual([]);
    expect((await topicRepo.listByUser('user-2')).map((t) => t.id)).toEqual(['topic-3']);
  });

  it('keeps every row of a group removal, and stamps them all with the same moment', async () => {
    // The same soft delete as the single one, so a batch cannot quietly become the
    // hard delete six removals would otherwise be.
    const removedAt = new Date('2026-02-01T00:00:00Z');
    await topicRepo.removeMany(['topic-1', 'topic-2'], removedAt);

    expect(await rawRemovedAt('topic-1')).toEqual(removedAt);
    expect(await rawRemovedAt('topic-2')).toEqual(removedAt);
  });

  it('removes nothing when asked to remove nothing', async () => {
    await topicRepo.removeMany([], new Date('2026-02-01T00:00:00Z'));

    expect(await rawRemovedAt('topic-1')).toBeNull();
  });

  it('does not move the removal time of one already removed', async () => {
    const first = new Date('2026-02-01T00:00:00Z');
    await topicRepo.remove('topic-1', first);
    await topicRepo.removeMany(['topic-1', 'topic-2'], new Date('2026-03-01T00:00:00Z'));

    expect(await rawRemovedAt('topic-1')).toEqual(first);
    expect(await rawRemovedAt('topic-2')).toEqual(new Date('2026-03-01T00:00:00Z'));
  });
});

describe('DrizzleTopicRepo a Topic that is created as a batch', () => {
  let db: Db;
  let driver: ReturnType<typeof createTestDb>['driver'];
  let topicRepo: DrizzleTopicRepo;

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    driver = created.driver;
    topicRepo = new DrizzleTopicRepo(db);
    await new DrizzleUserRepo(db).insert(makeUser({ id: 'user-1' }));
    for (const id of ['src-a', 'src-b']) {
      await new DrizzleSourceRepo(db).insert(makeSource({ id }));
    }
  });

  it('creates every Topic in the batch, with their Sources', async () => {
    await topicRepo.insertMany([
      makeTopic({ id: 'topic-1', userId: 'user-1', sourceIds: ['src-a', 'src-b'] }),
      makeTopic({ id: 'topic-2', userId: 'user-1', sourceIds: ['src-b'] }),
    ]);

    expect((await topicRepo.listByUser('user-1')).map((t) => t.id)).toEqual([
      'topic-1',
      'topic-2',
    ]);
    expect((await topicRepo.getById('topic-1'))?.sourceIds).toEqual(['src-a', 'src-b']);
  });

  it('leaves no Topic behind when one of the batch fails', async () => {
    // The second Topic's slug collides with the first's, so the unique index on
    // (user, slug) refuses it part-way through the batch. A User left with the
    // first Topic and no onboarding state saying they picked three is exactly
    // what onboarding has to be able to avoid, so the write is all or nothing.
    await expect(
      topicRepo.insertMany([
        makeTopic({ id: 'topic-1', userId: 'user-1', sourceIds: ['src-a'] }),
        makeTopic({ id: 'topic-2', userId: 'user-1', slug: 'topic-1' }),
      ]),
    ).rejects.toThrow();

    expect(await topicRepo.listByUser('user-1')).toEqual([]);
    // The Source links went with it: a rolled-back Topic that still had Sources
    // attached would be a Cluster-forming Topic with outlets the User never chose.
    expect(countRows(driver, 'topic_sources')).toBe(0);
  });
});

describe('DrizzleTopicRepo a Topics cadence', () => {
  let db: Db;
  let topicRepo: DrizzleTopicRepo;

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    topicRepo = new DrizzleTopicRepo(db);
    await new DrizzleUserRepo(db).insert(makeUser({ id: 'user-1' }));
    await topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'user-1' }));
  });

  it('stores the Cadence and the day it briefs on', async () => {
    await topicRepo.setCadence('topic-1', 'weekly', 'thursday');

    const topic = await topicRepo.getById('topic-1');
    expect(topic?.cadence).toBe('weekly');
    expect(topic?.cadenceDay).toBe('thursday');
  });

  it('gives a weekly Topic a day when the User chose only the frequency', async () => {
    // "Every week" has no answer on its own, so the row is never stored as one
    // the scheduler would have to guess at.
    await topicRepo.setCadence('topic-1', 'weekly', null);

    expect((await topicRepo.getById('topic-1'))?.cadenceDay).toBe('monday');
  });

  it('drops the day when the Cadence stops being weekly', async () => {
    await topicRepo.setCadence('topic-1', 'weekly', 'thursday');
    await topicRepo.setCadence('topic-1', 'never', null);

    const topic = await topicRepo.getById('topic-1');
    expect(topic?.cadence).toBe('never');
    // The column means "the day this briefs on when it is weekly", so a Topic
    // that is not weekly carries none rather than a stale Thursday.
    expect(topic?.cadenceDay).toBeNull();
  });
});

describe('DrizzleTopicRepo a Topics Sources', () => {
  let db: Db;
  let topicRepo: DrizzleTopicRepo;

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    topicRepo = new DrizzleTopicRepo(db);
    await new DrizzleUserRepo(db).insert(makeUser({ id: 'user-1' }));
    const sourceRepo = new DrizzleSourceRepo(db);
    for (const id of ['src-a', 'src-b', 'src-c']) {
      await sourceRepo.insert(makeSource({ id }));
    }
    await topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'user-1' }));
    await topicRepo.addSource('topic-1', 'src-a');
    await topicRepo.addSource('topic-1', 'src-b');
  });

  it('appends an added Source after the ones already on the Topic', async () => {
    await topicRepo.addSource('topic-1', 'src-c');

    expect((await topicRepo.getById('topic-1'))?.sourceIds).toEqual([
      'src-a',
      'src-b',
      'src-c',
    ]);
  });

  it('ignores a Source the Topic already has, rather than failing on the index', async () => {
    await topicRepo.addSource('topic-1', 'src-a');

    expect((await topicRepo.getById('topic-1'))?.sourceIds).toEqual(['src-a', 'src-b']);
  });

  it('removes a Source and closes the gap it left', async () => {
    await topicRepo.addSource('topic-1', 'src-c');
    await topicRepo.removeSource('topic-1', 'src-b');

    // Position is the order the User chose, so it stays a dense rank: a removed
    // Source must not leave a hole that the next add has to reason around.
    expect((await topicRepo.getById('topic-1'))?.sourceIds).toEqual(['src-a', 'src-c']);
    const positions = db
      .select()
      .from(topicSources)
      .all()
      .map((row) => (row as { position: number }).position);
    expect(positions).toEqual([0, 1]);
  });

  it('leaves the other Users Topics alone when removing a Source', async () => {
    await new DrizzleUserRepo(db).insert(makeUser({ id: 'user-2' }));
    await topicRepo.insert(makeTopic({ id: 'topic-2', userId: 'user-2' }));
    await topicRepo.addSource('topic-2', 'src-a');

    await topicRepo.removeSource('topic-1', 'src-a');

    expect((await topicRepo.getById('topic-2'))?.sourceIds).toEqual(['src-a']);
  });
});

describe('DrizzleTopicRepo renaming a Topic', () => {
  let db: Db;
  let topicRepo: DrizzleTopicRepo;

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    topicRepo = new DrizzleTopicRepo(db);
    await new DrizzleUserRepo(db).insert(makeUser({ id: 'user-1' }));
    await topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'user-1', title: 'World news' }));
  });

  it('stores the new title', async () => {
    await topicRepo.rename('topic-1', 'World news, carefully');

    expect((await topicRepo.getById('topic-1'))?.title).toBe('World news, carefully');
  });

  it('leaves the slug alone, so the address the User shared still works', async () => {
    await topicRepo.rename('topic-1', 'World news, carefully');

    expect((await topicRepo.findBySlug('user-1', 'topic-1'))?.title).toBe(
      'World news, carefully',
    );
  });
});
