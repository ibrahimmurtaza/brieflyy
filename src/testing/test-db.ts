import Database from 'better-sqlite3';

import {
  createDatabase,
  createInMemorySqliteDriver,
  type Db,
  type SqliteDriver,
} from '../db/client.js';
import { applySchema } from '../db/migrate.js';

export interface TestDbHandle {
  readonly driver: SqliteDriver;
  readonly db: Db;
}

export function createTestDb(): TestDbHandle {
  const driver = createInMemorySqliteDriver();
  applySchema(driver);
  const db = createDatabase({ driver });
  return { driver, db };
}

export function createFileDb(filename: string): TestDbHandle {
  const driver = new Database(filename);
  applySchema(driver);
  const db = createDatabase({ driver });
  return { driver, db };
}