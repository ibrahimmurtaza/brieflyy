import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { entities, type EntityRow } from '../db/schema.js';
import { type ExtractedEntity } from '../domain/entity-extraction.js';
import { resolveIdentity } from '../domain/entity-identity.js';
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
    const keys = await this.allKeys();
    const resolution = resolveIdentity(entity.key, keys);

    switch (resolution.kind) {
      case 'exact': {
        const resolved = await this.findByKey(resolution.key);
        if (!resolved) {
          throw new Error(`EntityRepo: exact entity "${resolution.key}" not found`);
        }
        return resolved;
      }
      case 'takeover': {
        const row = await this.findByKey(resolution.partialKey);
        if (!row) {
          throw new Error(
            `EntityRepo: partial entity "${resolution.partialKey}" not found`,
          );
        }
        return this.takeOver(row, resolution.key);
      }
      case 'fuller': {
        const resolved = await this.findByKey(resolution.key);
        if (!resolved) {
          throw new Error(`EntityRepo: fuller entity "${resolution.key}" not found`);
        }
        return resolved;
      }
      case 'new': {
        await this.db
          .insert(entities)
          .values({
            id,
            canonicalName: entity.name,
            canonicalKey: resolution.key,
            kind: entity.kind,
          })
          .onConflictDoNothing();
        const resolved = await this.findByKey(resolution.key);
        if (!resolved) {
          throw new Error(`EntityRepo: failed to upsert entity "${entity.name}"`);
        }
        return resolved;
      }
    }
  }

  private async allKeys(): Promise<readonly string[]> {
    const rows = await this.db
      .select({ canonicalKey: entities.canonicalKey })
      .from(entities);
    return rows.map((row) => row.canonicalKey);
  }

  private async rowsKeyedOn(key: string): Promise<readonly EntityRow[]> {
    return (await this.db
      .select()
      .from(entities)
      .where(eq(entities.canonicalKey, key))) as readonly EntityRow[];
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
  private async takeOver(entity: Entity, key: string): Promise<Entity> {
    await this.db
      .update(entities)
      .set({ canonicalKey: key })
      .where(eq(entities.id, entity.id));
    return entity;
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
