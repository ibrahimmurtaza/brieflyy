import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { entities, type EntityRow } from '../db/schema.js';
import type { ExtractedEntity } from '../domain/entity-extraction.js';
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
    const existing = await this.findByKey(entity.key);
    if (existing) return existing;
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

  private async findByKey(key: string): Promise<Entity | null> {
    const rows = (await this.db
      .select()
      .from(entities)
      .where(eq(entities.canonicalKey, key))) as readonly EntityRow[];
    const row = rows[0];
    return row ? rowToEntity(row) : null;
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
