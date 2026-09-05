import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleSourceRepo } from './source-repo.js';
import type { Source } from '../domain/types.js';

const sample: Source = {
  id: 'src-reuters',
  slug: 'reuters',
  name: 'Reuters',
  homepageUrl: 'https://www.reuters.com',
  feedUrl: 'https://www.reuters.com/rss/topNews',
  lastPolledAt: null,
  lastSuccessAt: null,
};

describe('DrizzleSourceRepo', () => {
  it('inserts and reads back a source with all fields', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    await repo.insert(sample);
    const got = await repo.getById('src-reuters');
    expect(got).toEqual(sample);
  });

  it('looks up by slug', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    await repo.insert(sample);
    const got = await repo.getBySlug('reuters');
    expect(got?.id).toBe('src-reuters');
  });

  it('returns null when not found', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    expect(await repo.getById('missing')).toBeNull();
    expect(await repo.getBySlug('missing')).toBeNull();
  });

  it('lists all sources', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    await repo.insert(sample);
    await repo.insert({ ...sample, id: 'src-ap', slug: 'ap', name: 'AP' });
    const list = await repo.list();
    expect(list).toHaveLength(2);
  });

  it('records poll and success timestamps', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    await repo.insert(sample);
    const polled = new Date('2026-05-01T12:00:00Z');
    const success = new Date('2026-05-01T12:00:05Z');
    await repo.recordPoll('src-reuters', polled);
    await repo.recordSuccess('src-reuters', success);
    const got = await repo.getById('src-reuters');
    expect(got?.lastPolledAt).toEqual(polled);
    expect(got?.lastSuccessAt).toEqual(success);
  });
});