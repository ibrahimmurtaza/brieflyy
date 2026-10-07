import { tableExists, type SqliteDriver } from './client.js';

/**
 * Whether one of the Clusters holding a Story is Active, as SQL over `stories`.
 *
 * The rule, written once: a Story is Retired exactly when none of its Clusters is
 * Active, which is why this is an `EXISTS` over the Cluster's own state rather than
 * a number counted somewhere else. A Story spanning Sources is held by more than
 * one Cluster of the same Topic (ADR 0010), so "the last Cluster" would be an answer
 * that depended on which row was written last.
 *
 * A shared constant rather than something each caller spells, because the two
 * callers are a bulk `UPDATE` in the pass and a migration over an existing database,
 * and the whole point of storing the answer was that they cannot come to hold
 * different views of which Stories are Retired. What reads it back is the Archive's
 * index, which asks the other half of the rule — `s.state = 'archive'`.
 *
 * Correlated on `stories.id`, so it only reads as a state for the Story the
 * statement around it is about.
 */
export const STORY_IS_ACTIVE = `EXISTS (
      SELECT 1 FROM cluster_stories cs
      JOIN clusters c ON c.id = cs.cluster_id
      WHERE cs.story_id = stories.id AND c.state = 'active'
    )`;

/**
 * The state of every Story a database already holds, from the Clusters it already
 * holds them in.
 *
 * A one-time fill, because a column added to a table of existing rows defaults
 * every one of those rows to the same value and a User's Archive is mostly rows
 * written before the column existed. Left on `active`, the Archive's index would
 * read as empty: every Story that had stopped being covered would drop out of it,
 * which is a User losing their own history to answer a question about a new
 * column. Derived here from the Clusters rather than guessed, because that is the
 * only thing in the database that knows.
 *
 * Both directions, so the fill lands the same answer whether the Clusters say a
 * Story is still moving or has stopped. Each statement only touches rows whose
 * stored state disagrees, so it is a no-op on a database this has already been
 * run against — which matters because `stories` has a trigger that rewrites the
 * Archive's row for every Story it writes, and rewriting the lot on every boot
 * would be the difference between a search and a rebuild.
 */
export function backfillStoryStates(driver: SqliteDriver): void {
  if (!tableExists(driver, 'stories')) return;
  if (!tableExists(driver, 'cluster_stories')) return;
  driver.exec(`UPDATE stories SET state = 'archive' WHERE state <> 'archive' AND NOT ${STORY_IS_ACTIVE}`);
  driver.exec(`UPDATE stories SET state = 'active' WHERE state <> 'active' AND ${STORY_IS_ACTIVE}`);
}