import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { entities, type EntityRow } from '../db/schema.js';
import type { Entity, EntityId } from '../domain/types.js';

function rowToEntity(row: EntityRow): Entity {
  return {
    id: row.id as EntityId,
    canonicalName: row.canonicalName,
    kind: row.kind,
  };
}

export interface EntityRepo {
  upsertByName(input: { readonly canonicalName: string; readonly id: EntityId }): Promise<Entity>;
  getById(id: EntityId): Promise<Entity | null>;
}

export class DrizzleEntityRepo implements EntityRepo {
  constructor(private readonly db: Db) {}

  async upsertByName({
    canonicalName,
    id,
  }: {
    readonly canonicalName: string;
    readonly id: EntityId;
  }): Promise<Entity> {
    const existing = (await this.db
      .select()
      .from(entities)
      .where(eq(entities.canonicalName, canonicalName))) as readonly EntityRow[];
    const row = existing[0];
    if (row) return rowToEntity(row);
    await this.db
      .insert(entities)
      .values({
        id,
        canonicalName,
        kind: 'concept',
      })
      .onConflictDoNothing();
    const after = (await this.db
      .select()
      .from(entities)
      .where(eq(entities.canonicalName, canonicalName))) as readonly EntityRow[];
    const resolved = after[0];
    if (!resolved) {
      throw new Error(`EntityRepo: failed to upsert entity "${canonicalName}"`);
    }
    return rowToEntity(resolved);
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