import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleSourceRepo } from './source-repo.js';
import type { Source } from '../domain/types.js';
import { NO_BACKOFF } from '../domain/types.js';

const sample: Source = {
  id: 'src-reuters',
  slug: 'reuters',
  name: 'Reuters',
  homepageUrl: 'https://www.reuters.com',
  feedUrl: 'https://www.reuters.com/rss/topNews',
  lastPolledAt: null,
  lastSuccessAt: null,
  backoff: NO_BACKOFF,
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

  it('keeps the failure backoff on the Source, so a restart reads it back', async () => {
    // The point of storing it: whatever a new process reads for this Source has
    // to be the streak the last cycle left behind, not an empty one.
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    await repo.insert(sample);

    await repo.recordBackoff('src-reuters', {
      consecutiveFailures: 3,
      lastError: 'upstream 503',
      nextAttemptAt: new Date('2026-05-01T12:30:00Z'),
    });

    // A second repo over the same database is what a restarted process holds.
    const afterRestart = new DrizzleSourceRepo(db);
    expect((await afterRestart.getById('src-reuters'))?.backoff).toEqual({
      consecutiveFailures: 3,
      lastError: 'upstream 503',
      nextAttemptAt: new Date('2026-05-01T12:30:00Z'),
    });
  });

  it('drops the streak and the error on a recovery, and puts the next attempt on the cadence', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    await repo.insert(sample);
    await repo.recordBackoff('src-reuters', {
      consecutiveFailures: 4,
      lastError: 'boom',
      nextAttemptAt: new Date('2026-05-01T12:30:00Z'),
    });

    const nextAttemptAt = new Date('2026-05-01T13:00:00Z');
    await repo.recordRecovered('src-reuters', nextAttemptAt);

    // A zero streak and no error, with the cadence as the next attempt rather
    // than nothing: clearing that too would leave a healthy Source with nothing
    // scheduling its next poll at all, and the loop wakes early for whichever
    // Source is serving a short backoff.
    expect((await repo.getById('src-reuters'))?.backoff).toEqual({
      consecutiveFailures: 0,
      lastError: null,
      nextAttemptAt,
    });
  });

  it('recovers one Source and leaves the other Sources holding their backoffs', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    await repo.insert(sample);
    await repo.insert({ ...sample, id: 'src-ap', slug: 'ap', name: 'AP' });
    const broken = {
      consecutiveFailures: 2,
      lastError: 'boom',
      nextAttemptAt: new Date('2026-05-01T12:30:00Z'),
    };
    await repo.recordBackoff('src-reuters', broken);
    await repo.recordBackoff('src-ap', broken);

    await repo.recordRecovered('src-reuters', new Date('2026-05-01T13:00:00Z'));

    expect((await repo.getById('src-reuters'))?.backoff.consecutiveFailures).toBe(0);
    expect((await repo.getById('src-ap'))?.backoff).toEqual(broken);
  });

  it('records a poll and a success without disturbing a backoff already being served', async () => {
    // Polling is how a backoff gets served, so writing the poll timestamps must
    // not be a way of clearing the streak it was left at.
    const { db } = createTestDb();
    const repo = new DrizzleSourceRepo(db);
    await repo.insert(sample);
    const backoff = {
      consecutiveFailures: 2,
      lastError: 'boom',
      nextAttemptAt: new Date('2026-05-01T12:30:00Z'),
    };
    await repo.recordBackoff('src-reuters', backoff);

    await repo.recordPoll('src-reuters', new Date('2026-05-01T12:20:00Z'));
    await repo.recordSuccess('src-reuters', new Date('2026-05-01T12:20:00Z'));

    const got = await repo.getById('src-reuters');
    expect(got?.backoff).toEqual(backoff);
    expect(got?.lastPolledAt).toEqual(new Date('2026-05-01T12:20:00Z'));
  });
});