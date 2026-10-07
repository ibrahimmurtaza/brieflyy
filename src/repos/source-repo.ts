import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { sources, type SourceRow } from '../db/schema.js';
import type { Source, SourceBackoff, SourceId } from '../domain/types.js';

function rowToBackoff(row: SourceRow): SourceBackoff {
  return {
    consecutiveFailures: row.consecutiveFailures,
    lastError: row.lastError,
    nextAttemptAt: row.nextAttemptAt,
  };
}

function rowToSource(row: SourceRow): Source {
  return {
    id: row.id as SourceId,
    slug: row.slug,
    name: row.name,
    homepageUrl: row.homepageUrl,
    feedUrl: row.feedUrl,
    lastPolledAt: row.lastPolledAt,
    lastSuccessAt: row.lastSuccessAt,
    backoff: rowToBackoff(row),
  };
}

export interface SourceRepo {
  insert(source: Source): Promise<void>;
  getById(id: SourceId): Promise<Source | null>;
  getBySlug(slug: string): Promise<Source | null>;
  list(): Promise<readonly Source[]>;
  recordPoll(id: SourceId, at: Date): Promise<void>;
  recordSuccess(id: SourceId, at: Date): Promise<void>;
  /** Store the backoff a failed poll left this Source serving out. */
  recordBackoff(id: SourceId, backoff: SourceBackoff): Promise<void>;
  /**
   * Record that a poll succeeded: the streak and the error are dropped, and the
   * next attempt is put on the normal cadence.
   *
   * The two halves are written together rather than as a separate clear because
   * they are one decision, and a Source carrying a cleared streak with no next
   * attempt is a Source the scheduler would reach out to on every cycle from then
   * on — including every cycle it wakes early for somebody else's backoff.
   */
  recordRecovered(id: SourceId, nextAttemptAt: Date): Promise<void>;
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
        consecutiveFailures: source.backoff.consecutiveFailures,
        nextAttemptAt: source.backoff.nextAttemptAt,
        lastError: source.backoff.lastError,
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

  async recordBackoff(id: SourceId, backoff: SourceBackoff): Promise<void> {
    await this.db
      .update(sources)
      .set({
        consecutiveFailures: backoff.consecutiveFailures,
        nextAttemptAt: backoff.nextAttemptAt,
        lastError: backoff.lastError,
      })
      .where(eq(sources.id, id));
  }

  async recordRecovered(id: SourceId, nextAttemptAt: Date): Promise<void> {
    await this.db
      .update(sources)
      .set({ consecutiveFailures: 0, nextAttemptAt, lastError: null })
      .where(eq(sources.id, id));
  }
}
