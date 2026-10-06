import { describe, expect, it } from 'vitest';

import { DrizzleTopicReductionRepo } from './topic-reduction-repo.js';
import { DrizzleUserRepo } from './user-repo.js';
import type { TopicReduction } from '../domain/types.js';
import { createTestDb } from '../testing/test-db.js';
import { makeUser } from '../testing/fixtures.js';

const ANSWERED = new Date('2026-04-02T09:00:00Z');

const IRIS: TopicReduction = {
  id: 'red-1',
  userId: 'user-iris',
  cap: 3,
  held: 9,
  keptTopicIds: ['topic-6', 'topic-7', 'topic-8'],
  stoppedTopicIds: ['topic-0', 'topic-1', 'topic-2', 'topic-3', 'topic-4', 'topic-5'],
  answeredAt: ANSWERED,
};

describe('a recorded topic reduction', () => {
  it('reads back what was answered, ids and counts alike', async () => {
    const { db } = createTestDb();
    await new DrizzleUserRepo(db).insert(makeUser({ id: 'user-iris' }));
    const repo = new DrizzleTopicReductionRepo(db);

    await repo.insert(IRIS);

    // Round-tripped through the column rather than compared with the object that
    // went in: the ids are stored as JSON text, so this is the only check that what
    // comes back is nine of them and not one string of nine.
    expect(await repo.findForUser('user-iris')).toEqual([IRIS]);
  });

  it('keeps two answers apart, because a User who pays again answers again', async () => {
    const { db } = createTestDb();
    await new DrizzleUserRepo(db).insert(makeUser({ id: 'user-iris' }));
    const repo = new DrizzleTopicReductionRepo(db);

    await repo.insert(IRIS);
    await repo.insert({ ...IRIS, id: 'red-2', answeredAt: new Date('2026-09-02T09:00:00Z') });

    const all = await repo.findForUser('user-iris');
    expect(all.map((r) => r.id)).toEqual(['red-1', 'red-2']);
  });

  it('reads an answer back for the User who gave it and nobody else', async () => {
    const { db } = createTestDb();
    const users = new DrizzleUserRepo(db);
    await users.insert(makeUser({ id: 'user-iris' }));
    await users.insert(makeUser({ id: 'user-sam' }));
    const repo = new DrizzleTopicReductionRepo(db);
    await repo.insert(IRIS);

    expect(await repo.findForUser('user-sam')).toEqual([]);
  });
});
