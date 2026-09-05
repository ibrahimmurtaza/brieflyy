import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { sources, type SourceRow } from '../db/schema.js';
import type { Source, SourceId } from '../domain/types.js';

function rowToSource(row: SourceRow): Source {
  return {
    id: row.id as SourceId,
    slug: row.slug,
    name: row.name,
    homepageUrl: row.homepageUrl,
    feedUrl: row.feedUrl,
    lastPolledAt: row.lastPolledAt,
    lastSuccessAt: row.lastSuccessAt,
  };
}

export interface SourceRepo {
  insert(source: Source): Promise<void>;
  getById(id: SourceId): Promise<Source | null>;
  getBySlug(slug: string): Promise<Source | null>;
  list(): Promise<readonly Source[]>;
  recordPoll(id: SourceId, at: Date): Promise<void>;
  recordSuccess(id: SourceId, at: Date): Promise<void>;
}

export class DrizzleSourceRepo implements SourceRepo {
  constructor(private readonly db: Db) {}

  async insert(source: Source): Promise<void> {
    await this.db
      .insert(sources)
      .values({
        id: source.id,
        slug: source.slug,
        name: source.name,
        homepageUrl: source.homepageUrl,
        feedUrl: source.feedUrl,
        lastPolledAt: source.lastPolledAt,
        lastSuccessAt: source.lastSuccessAt,
      })
      .onConflictDoNothing();
  }

  async getById(id: SourceId): Promise<Source | null> {
    const rows = (await this.db
      .select()
      .from(sources)
      .where(eq(sources.id, id))) as readonly SourceRow[];
    const row = rows[0];
    return row ? rowToSource(row) : null;
  }

  async getBySlug(slug: string): Promise<Source | null> {
    const rows = (await this.db
      .select()
      .from(sources)
      .where(eq(sources.slug, slug))) as readonly SourceRow[];
    const row = rows[0];
    return row ? rowToSource(row) : null;
  }

  async list(): Promise<readonly Source[]> {
    const rows = (await this.db.select().from(sources)) as readonly SourceRow[];
    return rows.map(rowToSource);
  }

  async recordPoll(id: SourceId, at: Date): Promise<void> {
    await this.db
      .update(sources)
      .set({ lastPolledAt: at })
      .where(eq(sources.id, id));
  }

  async recordSuccess(id: SourceId, at: Date): Promise<void> {
    await this.db
      .update(sources)
      .set({ lastSuccessAt: at })
      .where(eq(sources.id, id));
  }
}