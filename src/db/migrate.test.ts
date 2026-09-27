import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createDatabase, createInMemorySqliteDriver } from './client.js';
import { applySchema, migrateToDatabaseFile } from './migrate.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';

const LEGACY_SCHEMA_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  onboarding_state TEXT NOT NULL DEFAULT 'not_started'
);
CREATE TABLE topics (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  blurb TEXT NOT NULL,
  category TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_template_id TEXT,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`;

/** A database from before clusters, brief snapshots and deliveries existed. */
const PRE_FK_SCHEMA_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  onboarding_state TEXT NOT NULL DEFAULT 'not_started'
);
CREATE TABLE topics (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  blurb TEXT NOT NULL,
  category TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_template_id TEXT,
  cadence TEXT NOT NULL DEFAULT 'daily',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE TABLE clusters (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  bullet_points TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  article_count INTEGER NOT NULL,
  velocity INTEGER NOT NULL,
  source_ids TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX clusters_topic_idx ON clusters (topic_id);
CREATE TABLE brief_plans (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  cluster_ids TEXT NOT NULL DEFAULT ''
);
CREATE INDEX brief_plans_topic_user_idx ON brief_plans (topic_id, user_id, created_at);
CREATE TABLE brief_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  brief_plan_id TEXT NOT NULL REFERENCES brief_plans(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  topic_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  html TEXT NOT NULL,
  unsubscribe_token TEXT NOT NULL,
  global_unsubscribe_token TEXT NOT NULL
);
CREATE TABLE email_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL,
  brief_snapshot_id TEXT NOT NULL REFERENCES brief_snapshots(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL,
  sent_at INTEGER NOT NULL,
  unsubscribe_token TEXT NOT NULL,
  global_unsubscribe_token TEXT NOT NULL
);
CREATE TABLE stories (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX stories_source_fingerprint_idx ON stories (source_id, fingerprint);
CREATE TABLE cluster_stories (
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE
);
CREATE TABLE feedback_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  feedback_type TEXT NOT NULL,
  scope TEXT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
`;

function foreignKeys(
  driver: Database.Database,
  table: string,
): { from: string; table: string }[] {
  return (
    driver
      .prepare(`SELECT "from", "table" FROM pragma_foreign_key_list(?)`)
      .all(table) as { from: string; table: string }[]
  ).map((r) => ({ from: r.from, table: r.table }));
}

function indexIsUnique(driver: Database.Database, name: string): boolean {
  const row = driver
    .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(name) as { sql: string | null } | undefined;
  return /^\s*CREATE UNIQUE INDEX/i.test(row?.sql ?? '');
}

const tempDirs: string[] = [];

function tempDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'brieflyy-migrate-'));
  tempDirs.push(dir);
  return join(dir, 'test.db');
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('applySchema', () => {
  it('adds topics.cadence to a database created before the column existed', async () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(LEGACY_SCHEMA_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('topic-1', 'user-1', 'ai', 'AI', 'AI news', 'technology', 'freeform', 1);

    applySchema(driver);

    const db = createDatabase({ driver });
    const repo = new DrizzleTopicRepo(db);
    const topics = await repo.listByUser('user-1');
    expect(topics).toHaveLength(1);
    expect(topics[0]?.cadence).toBe('daily');
  });

  it('leaves an already-migrated topics table alone', () => {
    const driver = createInMemorySqliteDriver();
    applySchema(driver);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, cadence, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'topic-1',
        'user-1',
        'ai',
        'AI',
        'AI news',
        'technology',
        'freeform',
        'weekly',
        1,
      );

    expect(() => applySchema(driver)).not.toThrow();

    const row = driver
      .prepare(`SELECT cadence FROM topics WHERE id = ?`)
      .get('topic-1') as { cadence: string } | undefined;
    expect(row?.cadence).toBe('weekly');
  });

  it('rebuilds clusters, brief snapshots and email deliveries to gain their foreign keys', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_FK_SCHEMA_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('topic-1', 'user-1', 'ai', 'AI', 'AI news', 'technology', 'freeform', 1);
    driver
      .prepare(
        `INSERT INTO clusters (id, topic_id, title, summary, bullet_points, created_at, last_seen_at, article_count, velocity, source_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('cluster-1', 'topic-1', 'C', 'S', '[]', 1, 1, 1, 1, '');

    applySchema(driver);

    expect(foreignKeys(driver, 'clusters')).toContainEqual({
      from: 'topic_id',
      table: 'topics',
    });
    expect(foreignKeys(driver, 'brief_snapshots')).toEqual(
      expect.arrayContaining([
        { from: 'user_id', table: 'users' },
        { from: 'topic_id', table: 'topics' },
      ]),
    );
    expect(foreignKeys(driver, 'email_deliveries')).toEqual(
      expect.arrayContaining([
        { from: 'user_id', table: 'users' },
        { from: 'topic_id', table: 'topics' },
      ]),
    );
  });

  it('keeps the rows of a table it rebuilds', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_FK_SCHEMA_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('topic-1', 'user-1', 'ai', 'AI', 'AI news', 'technology', 'freeform', 1);
    driver
      .prepare(
        `INSERT INTO clusters (id, topic_id, title, summary, bullet_points, created_at, last_seen_at, article_count, velocity, source_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('cluster-1', 'topic-1', 'Kept', 'S', '[]', 1, 1, 1, 1, '');

    applySchema(driver);

    const row = driver
      .prepare(`SELECT title FROM clusters WHERE id = ?`)
      .get('cluster-1') as { title: string } | undefined;
    expect(row?.title).toBe('Kept');
    const clustersTopicIdx = driver
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'clusters_topic_idx'`)
      .get();
    expect(clustersTopicIdx).toBeDefined();
  });

  it('leaves dependent tables pointing at a rebuilt table', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_FK_SCHEMA_SQL);

    applySchema(driver);

    expect(foreignKeys(driver, 'cluster_stories')).toContainEqual({
      from: 'cluster_id',
      table: 'clusters',
    });
    expect(foreignKeys(driver, 'feedback_events')).toContainEqual({
      from: 'cluster_id',
      table: 'clusters',
    });
  });

  it('upgrades an index the schema declares unique but an older build created non-unique', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_FK_SCHEMA_SQL);
    expect(indexIsUnique(driver, 'brief_plans_topic_user_idx')).toBe(false);

    applySchema(driver);

    expect(indexIsUnique(driver, 'brief_plans_topic_user_idx')).toBe(true);
  });

  it('leaves the story fingerprint index non-unique, so a fingerprint can recur in a later window', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_FK_SCHEMA_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    applySchema(driver);
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url) VALUES (?, ?, ?, ?)`,
      )
      .run('src-1', 'outlet', 'Outlet', 'https://example.com');
    driver
      .prepare(
        `INSERT INTO stories (id, source_id, fingerprint, first_seen_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?)`,
      )
      .run('story-1', 'src-1', 'same-fingerprint', 1, 1);
    expect(() =>
      driver
        .prepare(
          `INSERT INTO stories (id, source_id, fingerprint, first_seen_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .run('story-2', 'src-1', 'same-fingerprint', 2, 2),
    ).not.toThrow();
  });

  it('is a no-op when run twice', () => {
    const driver = createInMemorySqliteDriver();
    applySchema(driver);
    const before = (
      driver
        .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
        .all() as unknown[]
    ).length;

    expect(() => applySchema(driver)).not.toThrow();

    const after = (
      driver
        .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
        .all() as unknown[]
    ).length;
    expect(after).toBe(before);
  });

  it('keeps dependent rows working after the rebuild, with foreign keys enforced', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_FK_SCHEMA_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('topic-1', 'user-1', 'ai', 'AI', 'AI news', 'technology', 'freeform', 1);
    applySchema(driver);

    driver.pragma('foreign_keys = ON');
    expect(() =>
      driver
        .prepare(
          `INSERT INTO clusters (id, topic_id, title, summary, bullet_points, created_at, last_seen_at, article_count, velocity, source_ids)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('cluster-1', 'no-such-topic', 'C', 'S', '[]', 1, 1, 1, 1, ''),
    ).toThrow(/FOREIGN KEY constraint failed/);
  });
});

describe('migrateToDatabaseFile', () => {
  it('applies the DDL to an empty database file', () => {
    const file = tempDbPath();
    expect(existsSync(file)).toBe(false);

    migrateToDatabaseFile(file);

    expect(existsSync(file)).toBe(true);
    const driver = new Database(file, { readonly: true });
    const tables = (
      driver
        .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
        .all() as { name: string }[]
    ).map((r) => r.name);
    driver.close();

    expect(tables).toEqual(
      expect.arrayContaining([
        'users',
        'accounts',
        'topics',
        'sources',
        'articles',
        'stories',
        'clusters',
        'brief_plans',
        'brief_snapshots',
        'email_deliveries',
        'feedback_events',
      ]),
    );
  });

  it('is a no-op on an already-migrated database file', () => {
    const file = tempDbPath();
    migrateToDatabaseFile(file);
    const first = new Database(file, { readonly: true });
    const before = first
      .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
      .all();
    first.close();

    migrateToDatabaseFile(file);

    const second = new Database(file, { readonly: true });
    const after = second
      .prepare(`SELECT type, name, sql FROM sqlite_master ORDER BY type, name`)
      .all();
    second.close();
    expect(after).toEqual(before);
  });
});
