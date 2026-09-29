import { describe, expect, it } from 'vitest';

import {
  canonicalEntityKey,
  extractEntities,
  type ExtractedEntity,
} from '../domain/entity-extraction.js';
import { createTestDb } from '../testing/test-db.js';
import { DrizzleEntityRepo } from './entity-repo.js';

/** What extraction would have said about a name, in a sentence of its own. */
function extracted(text: string, name: string): ExtractedEntity {
  const found = extractEntities(text).find((e) => e.name === name);
  if (!found) throw new Error(`extraction did not find ${name} in: ${text}`);
  return found;
}

describe('DrizzleEntityRepo', () => {
  it('upserts a new entity, keeping the name an outlet wrote and the kind it read', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    const entity = await repo.upsertByKey({
      entity: extracted('Acme Corp launched Foo.', 'Acme Corp'),
      id: 'ent-acme',
    });
    expect(entity.canonicalName).toBe('Acme Corp');
    expect(entity.id).toBe('ent-acme');
    expect(entity.kind).toBe('org');
  });

  it('resolves a second spelling of one name to the row the first one made', async () => {
    const { db, driver } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    const first = await repo.upsertByKey({
      entity: extracted('Acme Corp launched Foo.', 'Acme Corp'),
      id: 'ent-acme',
    });
    const second = await repo.upsertByKey({
      entity: extracted('ACME CORPORATION launched Foo.', 'ACME CORPORATION'),
      id: 'ent-acme-other',
    });

    // One row, not two: two rows for one company are two Entities that never
    // overlap with anything, which is the whole mechanism clustering rests on.
    expect(second.id).toBe(first.id);
    expect(
      driver.prepare(`SELECT canonical_name, canonical_key FROM entities`).all(),
    ).toEqual([{ canonical_name: 'Acme Corp', canonical_key: 'acme' }]);
  });

  it('keeps the reading that named the Entity when a later one differs', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    await repo.upsertByKey({
      entity: extracted('Acme Corp launched Foo.', 'Foo'),
      id: 'ent-foo',
    });
    const again = await repo.upsertByKey({
      // The same name, written in a sentence that reads it as something else.
      entity: {
        name: 'foo',
        key: canonicalEntityKey('foo'),
        kind: 'concept',
      },
      id: 'ent-foo-other',
    });
    expect(again.kind).toBe('product');
  });

  it('keeps genuinely different names apart', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    const acme = await repo.upsertByKey({
      entity: extracted('Acme Corp launched Foo.', 'Acme Corp'),
      id: 'ent-acme',
    });
    const tinyco = await repo.upsertByKey({
      entity: extracted('Acme Corp said it had bought TinyCo.', 'TinyCo'),
      id: 'ent-tinyco',
    });
    expect(tinyco.id).not.toBe(acme.id);
  });

  it('looks up by id', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    await repo.upsertByKey({
      entity: extracted('Acme Corp named Priya Sandhu as chief executive.', 'Priya Sandhu'),
      id: 'ent-priya',
    });
    const got = await repo.getById('ent-priya');
    expect(got?.canonicalName).toBe('Priya Sandhu');
    expect(got?.kind).toBe('person');
  });

  it('returns null for an unknown id', async () => {
    const { db } = createTestDb();
    const repo = new DrizzleEntityRepo(db);
    expect(await repo.getById('missing')).toBeNull();
  });
});
