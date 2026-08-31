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