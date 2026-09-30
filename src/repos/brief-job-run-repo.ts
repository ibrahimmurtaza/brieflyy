import { desc, lt } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { briefJobRuns, type BriefJobRunRow } from '../db/schema.js';
import type { BriefJobRun } from '../domain/types.js';

function rowToBriefJobRun(row: BriefJobRunRow): BriefJobRun {
  return {
    id: row.id,
    startedAt: new Date(row.startedAt),
    finishedAt: new Date(row.finishedAt),
    sentCount: row.sentCount,
    failureCount: row.failureCount,
    generation: {
      writtenClusters: row.writtenClusters,
      calls: row.generationCalls,
      discardedBullets: row.discardedBullets,
    },
  };
}

/** How many passes the status view lists. Enough to see a day of ticks. */
export const RECENT_JOB_RUNS = 20;

/**
 * How many passes are kept. The job runs every minute, so a table that only ever
 * grows is half a million rows a year of passes nobody will read; the view reads
 * the newest twenty, and everything older than this is a pass from a window nobody
 * can scroll back to.
 */
export const RETAINED_JOB_RUNS = 500;

export interface BriefJobRunRepo {
  insert(run: BriefJobRun): Promise<void>;
  /**
   * The most recent passes, newest first.
   *
   * Read in this order because the question the status view answers is "what
   * happened last", and a run is a fact that never changes once written, so the
   * newest one is always first rather than needing a tie-break on equal times.
   */
  listRecent(limit?: number): Promise<readonly BriefJobRun[]>;
  /**
   * Discard every pass older than the newest `keep`.
   *
   * Called after a pass rather than on a schedule of its own, so the bound holds
   * whenever the job is running and needs nothing to be remembered about when it
   * last ran.
   */
  pruneToNewest(keep: number): Promise<void>;
}

export class DrizzleBriefJobRunRepo implements BriefJobRunRepo {
  constructor(private readonly db: Db) {}

  async insert(run: BriefJobRun): Promise<void> {
    await this.db.insert(briefJobRuns).values({
      id: run.id,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      sentCount: run.sentCount,
      failureCount: run.failureCount,
      writtenClusters: run.generation.writtenClusters,
      generationCalls: run.generation.calls,
      discardedBullets: run.generation.discardedBullets,
    });
  }

  async listRecent(limit: number = RECENT_JOB_RUNS): Promise<readonly BriefJobRun[]> {
    const rows = (await this.db
      .select()
      .from(briefJobRuns)
      .orderBy(desc(briefJobRuns.startedAt))
      .limit(limit)) as readonly BriefJobRunRow[];
    return rows.map(rowToBriefJobRun);
  }

  async pruneToNewest(keep: number): Promise<void> {
    const oldestKept = (await this.listRecent(keep)).at(-1);
    if (oldestKept === undefined) return;
    await this.db
      .delete(briefJobRuns)
      .where(lt(briefJobRuns.startedAt, oldestKept.startedAt));
  }
}