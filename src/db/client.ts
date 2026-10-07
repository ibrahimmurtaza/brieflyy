import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import * as schema from './schema.js';

export type Db = BetterSQLite3Database<typeof schema>;

export type SqliteDriver = Database.Database;

export interface CreateDatabaseOptions {
  driver: SqliteDriver;
}

export function createDatabase({ driver }: CreateDatabaseOptions): Db {
  driver.pragma('journal_mode = WAL');
  driver.pragma('foreign_keys = ON');
  return drizzle(driver, { schema });
}

export function createInMemorySqliteDriver(): SqliteDriver {
  return new Database(':memory:');
}

/**
 * Whether this database has a table of that name.
 *
 * Asked rather than assumed, because the migration runs against databases of every
 * age and a statement naming a table an older build did not have is an error rather
 * than a no-op.
 */
export function tableExists(driver: SqliteDriver, table: string): boolean {
  return (
    driver
      .prepare(
        `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(table) !== undefined
  );
}