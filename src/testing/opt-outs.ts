import type { SqliteDriver } from '../db/client.js';

/**
 * The opt-out a row carries, read as a plain `Date | null`.
 *
 * Both tests that check an unsubscribe reached the database want the same two
 * reads, and the interesting part of each is the assertion rather than the
 * column plucking. A null column means "still receiving", which is the state
 * almost every row is in — and the one a test that forgot to opt anybody out
 * would get, so a missing row and a null column both read as null.
 */
function readOptOut(
  driver: SqliteDriver,
  table: 'users' | 'topics',
  id: string,
): Date | null {
  const row = driver
    .prepare(`SELECT unsubscribed_at FROM ${table} WHERE id = ?`)
    .get(id) as { unsubscribed_at: number | null } | undefined;
  return row?.unsubscribed_at === null || row?.unsubscribed_at === undefined
    ? null
    : new Date(row.unsubscribed_at);
}

export function userOptOutAt(driver: SqliteDriver, userId: string): Date | null {
  return readOptOut(driver, 'users', userId);
}

export function topicOptOutAt(
  driver: SqliteDriver,
  topicId: string,
): Date | null {
  return readOptOut(driver, 'topics', topicId);
}
