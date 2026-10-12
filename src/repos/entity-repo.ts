import { eq, like } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { entities, type EntityRow } from '../db/schema.js';
import {
  isFullerNameFor,
  isPartialName,
  theOnlyFullerName,
  type ExtractedEntity,
} from '../domain/entity-extraction.js';
import type { Entity, EntityId } from '../domain/types.js';

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id as EntityId,
    canonicalName: row.canonicalName,
    kind: row.kind,
  };
}

export interface EntityRepo {
  /**
   * The Entity a name refers to, creating it if this is the first Article to
   * name it.
   *
   * The lookup is on the extracted Entity's key rather than on its name, because
   * the name is one outlet's spelling of it: "ACME CORP", "Acme Corp" and "Acme
   * Corporation" are one Entity, and three rows for one company are three
   * Entities that never overlap with anything.
   *
   * A key that is not there resolves to the Entity whose key it is the end of, by
   * a whole word and in either direction. "Pike" is the same person as "Christa
   * Pike", and two Articles — one naming the surname and one naming the whole of
   * it — share nothing to be grouped on unless the short one reaches the long
   * one. A name is only matched on its last word, and only on a word that could
   * name a thing at all, so "Northern Bridge" and "Severn Bridge" stay two and a
   * bare "Bridge" stays nothing.
   *
   * The kind is the one the first Article to name it read it as, and a later
   * Article that reads it differently does not overwrite it. An Entity's kind is a
   * fact about the Entity, so the reading that named it stands until something
   * better than a rule reads it again.
   */
  upsertByKey(input: {
    readonly entity: ExtractedEntity;
    readonly id: EntityId;
  }): Promise<Entity>;
  getById(id: EntityId): Promise<Entity | null>;
}

export class DrizzleEntityRepo implements EntityRepo {
  constructor(private readonly db: Db) {}

  async upsertByKey({
    entity,
    id,
  }: {
    readonly entity: ExtractedEntity;
    readonly id: EntityId;
  }): Promise<Entity> {
    const exact = await this.findByKey(entity.key);
    if (exact) return exact;

    // A fuller name takes over the row a partial one already made, and a partial
    // name resolves to the fuller one already stored. Both directions are here
    // because the corpus could hold either order: a resolution that only worked
    // one way round would leave the database holding two shapes for one person,
    // and which of them a User was shown would depend on which outlet was polled
    // first.
    const partial = await this.findPartialNameOf(entity.key);
    if (partial) return this.takeOver(partial, entity.key);
    const fuller = await this.findFullerNameFor(entity.key);
    if (fuller) return fuller;

    await this.db
      .insert(entities)
      .values({
        id,
        canonicalName: entity.name,
        canonicalKey: entity.key,
        kind: entity.kind,
      })
      .onConflictDoNothing();
    const resolved = await this.findByKey(entity.key);
    if (!resolved) {
      throw new Error(`EntityRepo: failed to upsert entity "${entity.name}"`);
    }
    return resolved;
  }

  /**
   * The row a name is the end of: the partial name already stored under the last
   * word of this one.
   *
   * Only ever a person's full name, and only for the partial to take over rather
   * than sit beside it: an Article that says "Christa Pike" is the same person as
   * one that says "Pike", and the two have to be one row or they are two Entities
   * that never overlap. The partial's own row is keyed after the takeover rather
   * than given a row of its own, so there is nothing to reconcile on the next
   * boot.
   */
  private async findPartialNameOf(key: string): Promise<EntityRow | null> {
    const last = key.split(' ').pop() ?? '';
    if (last === key || !isPartialName(last)) return null;
    if (!isFullerNameFor(key, last)) return null;
    return (await this.rowsKeyedOn(last))[0] ?? null;
  }

  /**
   * The row a name is the beginning of: the fuller name already stored under some
   * key this one ends with.
   */
  private async findFullerNameFor(key: string): Promise<Entity | null> {
    if (!isPartialName(key)) return null;
    const rows = await this.rowsEndingOn(key);
    const fuller = theOnlyFullerName(
      rows.map((row) => row.canonicalKey),
      key,
    );
    return fuller === undefined ? null : rowToEntity(rows.find((row) => row.canonicalKey === fuller)!);
  }

  private async rowsKeyedOn(key: string): Promise<readonly EntityRow[]> {
    return (await this.db
      .select()
      .from(entities)
      .where(eq(entities.canonicalKey, key))) as readonly EntityRow[];
  }

  /**
   * The rows keyed by a name that ends with this one on a word boundary.
   *
   * `LIKE` cannot anchor on a word boundary, so what it brings back is confirmed
   * in {@link isFullerNameFor} rather than trusted: "Pike" must not reach "Pike
   * Hinson" by matching the tail of it.
   */
  private async rowsEndingOn(key: string): Promise<readonly EntityRow[]> {
    const rows = (await this.db
      .select()
      .from(entities)
      .where(like(entities.canonicalKey, `% ${key}`))) as readonly EntityRow[];
    return rows.filter((row) => row.canonicalKey.endsWith(` ${key}`));
  }

  private async findByKey(key: string): Promise<Entity | null> {
    const row = (await this.rowsKeyedOn(key))[0];
    return row ? rowToEntity(row) : null;
  }

  /**
   * Re-key a row to the name it has just been shown to be the end of, and hand
   * it back.
   *
   * The row keeps its name: the first spelling an outlet used is the one a User
   * reads, and replacing it with the longer spelling would rewrite what that
   * Article said for the sake of a comparison.
   */
  private async takeOver(row: EntityRow, key: string): Promise<Entity> {
    await this.db
      .update(entities)
      .set({ canonicalKey: key })
      .where(eq(entities.id, row.id));
    return rowToEntity(row);
  }

  async getById(id: EntityId): Promise<Entity | null> {
    const rows = (await this.db
      .select()
      .from(entities)
      .where(eq(entities.id, id))) as readonly EntityRow[];
    const row = rows[0];
    return row ? rowToEntity(row) : null;
  }
}
