import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleEntityRepo } from './entity-repo.js';

describe('DrizzleEntityRepo', () => {
  it('upserts a new entity by canonical name', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    const e = await repo.upsertByName({
      canonicalName: 'Acme Corp',
      id: 'ent-acme',
    });
    expect(e.canonicalName).toBe('Acme Corp');
    expect(e.id).toBe('ent-acme');
  });

  it('returns the existing row on a duplicate canonical name', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    const first = await repo.upsertByName({
      canonicalName: 'Acme Corp',
      id: 'ent-acme',
    });
    const second = await repo.upsertByName({
      canonicalName: 'Acme Corp',
      id: 'ent-acme-other',
    });
    expect(second.id).toBe(first.id);
  });

  it('looks up by id', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    await repo.upsertByName({ canonicalName: 'Jane Doe', id: 'ent-jane' });
    const got = await repo.getById('ent-jane');
    expect(got?.canonicalName).toBe('Jane Doe');
  });

  it('returns null for an unknown id', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    expect(await repo.getById('missing')).toBeNull();
  });
});