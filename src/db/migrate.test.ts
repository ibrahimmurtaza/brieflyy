import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';

import { createDatabase, createInMemorySqliteDriver } from './client.js';
import { applySchema, migrateToDatabaseFile } from './migrate.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { decodeSignature, encodeSignature } from '../domain/story-signature.js';
import { signatureOf, WIRE_COPIES } from '../testing/story-fixtures.js';

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

/**
 * A database from before Stories and Articles were matched by comparison: both
 * carried a `fingerprint` hash, each with an index on it, and neither had a
 * stored signature or a publication range.
 */
const PRE_SIGNATURE_SQL = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  feed_url TEXT,
  last_polled_at INTEGER,
  last_success_at INTEGER
);
CREATE UNIQUE INDEX sources_slug_unique ON sources (slug);
CREATE TABLE articles (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  fingerprint TEXT NOT NULL,
  story_id TEXT
);
CREATE UNIQUE INDEX articles_source_external_unique ON articles (source_id, external_id);
CREATE INDEX articles_fingerprint_idx ON articles (fingerprint);
CREATE TABLE stories (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  fingerprint TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX stories_source_fingerprint_idx ON stories (source_id, fingerprint);
`;

/**
 * A database from after clusters gained their foreign key, but before velocity
 * became a Stories-per-day rate and before the per-Topic window existed. The
 * clusters table is already correct as far as foreign keys go, so only a
 * column-type change can be what rebuilds it.
 */
const PRE_VELOCITY_REAL_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  onboarding_state TEXT NOT NULL DEFAULT 'not_started',
  tier TEXT NOT NULL DEFAULT 'free'
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
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  removed_at INTEGER
);
CREATE TABLE clusters (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
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
CREATE TABLE cluster_stories (
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE
);
CREATE TABLE stories (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
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

/**
 * A database from before an Entity carried the key its identity is decided on,
 * with two rows for the one company: the older build matched Entities by name,
 * and "Acme Corp" and "Acme" were two names to it.
 */
const PRE_ENTITY_KEY_SQL = `
CREATE TABLE sources (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  feed_url TEXT,
  last_polled_at INTEGER,
  last_success_at INTEGER
);
CREATE UNIQUE INDEX sources_slug_unique ON sources (slug);
CREATE TABLE articles (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL,
  signature TEXT NOT NULL DEFAULT '{}',
  story_id TEXT
);
CREATE TABLE entities (
  id TEXT PRIMARY KEY NOT NULL,
  canonical_name TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE UNIQUE INDEX entities_canonical_name_unique ON entities (canonical_name);
CREATE TABLE article_entities (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX article_entities_pk ON article_entities (article_id, entity_id);
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

/** The declared SQL type of a column, as SQLite reports it. */
function columnType(
  driver: Database.Database,
  table: string,
  column: string,
): string | undefined {
  const row = driver
    .prepare(`SELECT type FROM pragma_table_info(?) WHERE name = ?`)
    .get(table, column) as { type: string } | undefined;
  return row?.type;
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

/** A database from before magic links carried the address instead of an account. */
const PRE_MAGIC_LINK_EMAIL_SQL = `
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  onboarding_state TEXT NOT NULL DEFAULT 'not_started'
);
CREATE TABLE accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE TABLE magic_links (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE UNIQUE INDEX magic_links_token_hash_unique ON magic_links (token_hash);
CREATE INDEX magic_links_account_idx ON magic_links (account_id);
`;

/** A database from before a BriefSnapshot carried a plain-text alternative. */
const NO_SNAPSHOT_TEXT_SCHEMA_SQL = `
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
CREATE TABLE brief_plans (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  cluster_ids TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX brief_plans_topic_user_idx ON brief_plans (topic_id, user_id, created_at);
CREATE TABLE brief_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  brief_plan_id TEXT NOT NULL REFERENCES brief_plans(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  html TEXT NOT NULL,
  unsubscribe_token TEXT NOT NULL,
  global_unsubscribe_token TEXT NOT NULL
);
`;

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

  it('adds topics.removed_at to a database created before soft delete existed', async () => {
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

    // An upgraded topic is still active, and soft delete works on it.
    const before = await repo.listByUser('user-1');
    expect(before).toHaveLength(1);
    expect(before[0]?.removedAt).toBeNull();

    await repo.remove('topic-1', new Date('2026-02-01T00:00:00Z'));
    expect(await repo.listByUser('user-1')).toHaveLength(0);
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

  it('adds brief_snapshots.text to a database created before the column existed', () => {
    // `EmailMessage.text` is required, so a snapshot that stored only HTML could
    // not be sent at all. The column arrives empty on the snapshots written
    // before it, which is the truth about them: they have no text alternative.
    const driver = createInMemorySqliteDriver();
    driver.exec(NO_SNAPSHOT_TEXT_SCHEMA_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('topic-1', 'user-1', 'ai', 'AI', 'AI news', 'technology', 'freeform', 1);
    driver
      .prepare(
        `INSERT INTO brief_plans (id, topic_id, user_id, created_at, cluster_ids) VALUES (?, ?, ?, ?, ?)`,
      )
      .run('plan-1', 'topic-1', 'user-1', 1, 'cluster-1');
    driver
      .prepare(
        `INSERT INTO brief_snapshots (id, brief_plan_id, user_id, topic_id, created_at, html, unsubscribe_token, global_unsubscribe_token)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('snap-1', 'plan-1', 'user-1', 'topic-1', 1, '<p>sent</p>', 'u1', 'g1');

    applySchema(driver);

    const row = driver
      .prepare(`SELECT html, text FROM brief_snapshots WHERE id = ?`)
      .get('snap-1') as { html: string; text: string } | undefined;
    // The brief that was sent is still there, and it says it has no text part.
    expect(row?.html).toBe('<p>sent</p>');
    expect(row?.text).toBe('');
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

  it('lets two Stories share a signature, because a signature recurs in a later window', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_FK_SCHEMA_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    applySchema(driver);
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url) VALUES (?, ?, ?, ?)`,
      )
      .run('src-1', 'outlet', 'Outlet', 'https://example.com');
    const insertStory = (id: string, at: number): void => {
      driver
        .prepare(
          `INSERT INTO stories (id, source_id, signature, first_seen_at, last_seen_at, first_published_at, last_published_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, 'src-1', '{"words":["acme"],"phrases":["acme launched"]}', at, at, at, at);
    };
    insertStory('story-1', 1);
    expect(() => insertStory('story-2', 2)).not.toThrow();
  });

  it('replaces the retired fingerprint columns with the signature they stood in for', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_FK_SCHEMA_SQL);
    applySchema(driver);

    for (const table of ['articles', 'stories']) {
      const columns = (
        driver
          .prepare(`SELECT name FROM pragma_table_info(?)`)
          .all(table) as { name: string }[]
      ).map((c) => c.name);
      // Nothing reads the hash of a signature any more, and a column left
      // behind reads like a Story's identity to whoever comes next.
      expect(columns, table).not.toContain('fingerprint');
      expect(columns, table).toContain('signature');
    }
    const storyColumns = (
      driver.prepare(`SELECT name FROM pragma_table_info(?)`).all('stories') as {
        name: string;
      }[]
    ).map((c) => c.name);
    expect(storyColumns).toEqual(
      expect.arrayContaining(['first_published_at', 'last_published_at']),
    );
    expect(
      driver
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('articles_fingerprint_idx', 'stories_source_fingerprint_idx')`,
        )
        .all(),
    ).toEqual([]);
  });

  it('drops the fingerprint columns from a database that had them, indexes and all', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_SIGNATURE_SQL);
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url) VALUES (?, ?, ?, ?)`,
      )
      .run('src-1', 'outlet', 'Outlet', 'https://example.com');
    driver
      .prepare(
        `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, fingerprint, story_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'a-1',
        'src-1',
        'ext-1',
        'https://example.com/1',
        'A headline',
        'Acme Corp launched Foo on Tuesday, an AI assistant for enterprise customers.',
        1000,
        1000,
        'old-hash',
        'story-1',
      );

    applySchema(driver);

    for (const table of ['articles', 'stories']) {
      const columns = (
        driver
          .prepare(`SELECT name FROM pragma_table_info(?)`)
          .all(table) as { name: string }[]
      ).map((c) => c.name);
      expect(columns, table).not.toContain('fingerprint');
    }
    const indexes = (
      driver
        .prepare(
          `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name IN ('articles', 'stories')`,
        )
        .all() as { name: string }[]
    ).map((r) => r.name);
    expect(indexes).not.toContain('articles_fingerprint_idx');
    expect(indexes).not.toContain('stories_source_fingerprint_idx');
    // And the Article that was there is still there, with its Story.
    expect(
      (
        driver
          .prepare(`SELECT story_id FROM articles WHERE id = ?`)
          .get('a-1') as { story_id: string }
      ).story_id,
    ).toBe('story-1');
  });

  it('derives a signature and a published range for a Story written before the columns existed', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_SIGNATURE_SQL);
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
      .run('story-1', 'src-1', 'old-hash', 1, 1);
    const insertArticle = (id: string, publishedAt: number, body: string): void => {
      driver
        .prepare(
          `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, fingerprint, story_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, 'src-1', `ext-${id}`, 'https://example.com/x', 'Headline', body, publishedAt, 1, 'old-hash', 'story-1');
    };
    insertArticle(
      'a-1',
      1000,
      WIRE_COPIES[0]!.body,
    );
    insertArticle(
      'a-2',
      2000,
      WIRE_COPIES[1]!.body,
    );

    applySchema(driver);

    const row = driver
      .prepare(
        `SELECT signature, first_published_at, last_published_at FROM stories WHERE id = ?`,
      )
      .get('story-1') as {
      signature: string;
      first_published_at: number;
      last_published_at: number;
    };
    // Left empty, this Story would match nothing and the next poll of the feed
    // would re-form it from scratch alongside the original.
    expect(decodeSignature(row.signature)).toEqual(
      signatureOf(WIRE_COPIES[0]!.body),
    );
    expect(row.first_published_at).toBe(1000);
    expect(row.last_published_at).toBe(2000);
  });

  it('leaves a Story with no Articles to derive from, rather than inventing a range', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_SIGNATURE_SQL);
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
      .run('empty-story', 'src-1', 'old-hash', 1, 1);

    applySchema(driver);

    const row = driver
      .prepare(
        `SELECT signature, first_published_at FROM stories WHERE id = ?`,
      )
      .get('empty-story') as { signature: string; first_published_at: number };
    expect(row.signature).toBe('{}');
    expect(row.first_published_at).toBe(0);
  });

  it('derives a signature for an Article written before the column existed', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_SIGNATURE_SQL);
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url) VALUES (?, ?, ?, ?)`,
      )
      .run('src-1', 'outlet', 'Outlet', 'https://example.com');
    driver
      .prepare(
        `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'a-1',
        'src-1',
        'ext-1',
        'https://example.com/1',
        'A headline',
        WIRE_COPIES[0]!.body,
        1000,
        1000,
        'old-hash',
      );

    applySchema(driver);

    // Left empty, the Article reads back with no key phrases at all, which is
    // the half of the mechanism that was only ever in memory.
    const row = driver
      .prepare(`SELECT signature FROM articles WHERE id = ?`)
      .get('a-1') as { signature: string };
    expect(decodeSignature(row.signature)).toEqual(
      signatureOf(WIRE_COPIES[0]!.body),
    );
  });

  it('leaves a signature a newer build already wrote alone', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_SIGNATURE_SQL);
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url) VALUES (?, ?, ?, ?)`,
      )
      .run('src-1', 'outlet', 'Outlet', 'https://example.com');
    driver
      .prepare(
        `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'a-1',
        'src-1',
        'ext-1',
        'https://example.com/1',
        'A headline',
        'A body that is not the one the signature was taken from.',
        1000,
        1000,
        'old-hash',
      );
    // A second boot, after a build that already knows how to sign Articles has
    // signed this one. Its signature came from this same body, and the backfill
    // must not overwrite it with a value derived a different way.
    applySchema(driver);
    driver
      .prepare(`UPDATE articles SET signature = ? WHERE id = ?`)
      .run(encodeSignature({ words: ['kept'], phrases: [] }), 'a-1');

    applySchema(driver);

    const row = driver
      .prepare(`SELECT signature FROM articles WHERE id = ?`)
      .get('a-1') as { signature: string };
    expect(decodeSignature(row.signature)).toEqual({
      words: ['kept'],
      phrases: [],
    });
  });

  it('records an Article it had no text to sign, rather than leaving it unsigned', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_SIGNATURE_SQL);
    driver
      .prepare(
        `INSERT INTO sources (id, slug, name, homepage_url) VALUES (?, ?, ?, ?)`,
      )
      .run('src-1', 'outlet', 'Outlet', 'https://example.com');
    driver
      .prepare(
        `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, fingerprint)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('a-1', 'src-1', 'ext-1', 'https://example.com/1', 'A headline', '', 1000, 1000, 'old-hash');

    applySchema(driver);

    const row = driver
      .prepare(`SELECT signature FROM articles WHERE id = ?`)
      .get('a-1') as { signature: string };
    // A signed Article with nothing in its signature is a different claim from
    // an Article that was never signed at all, and only the first is true here:
    // the body was read, and it had no words. The default '{}' is kept for rows
    // the backfill cannot reach, so it stays the "not signed" marker.
    expect(row.signature).not.toBe('{}');
    expect(decodeSignature(row.signature)).toEqual({ words: [], phrases: [] });
  });

  it('lets a magic link exist before the account it will create', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_MAGIC_LINK_EMAIL_SQL);
    applySchema(driver);

    const columns = (
      driver.prepare(`SELECT name, "notnull" AS not_null FROM pragma_table_info(?)`).all('magic_links') as {
        name: string;
        not_null: number;
      }[]
    );
    const byName = new Map(columns.map((c) => [c.name, c.not_null === 1]));
    expect(byName.get('email')).toBe(true);
    expect(byName.get('account_id')).toBe(false);
    expect(foreignKeys(driver, 'magic_links')).toEqual([
      { from: 'account_id', table: 'accounts' },
    ]);

    expect(() =>
      driver
        .prepare(
          `INSERT INTO magic_links (id, account_id, email, token_hash, created_at, expires_at, consumed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('link-1', null, 'iris@example.com', 'hash-1', 1, 2, null),
    ).not.toThrow();
  });

  it('keeps the rows of a magic link it rebuilds, and stops demanding an account', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_MAGIC_LINK_EMAIL_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO accounts (id, user_id, email, created_at) VALUES (?, ?, ?, ?)`,
      )
      .run('account-1', 'user-1', 'iris@example.com', 1);
    driver
      .prepare(
        `INSERT INTO magic_links (id, account_id, token_hash, created_at, expires_at, consumed_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('link-1', 'account-1', 'hash-1', 1, 2, 3);

    applySchema(driver);

    const kept = driver
      .prepare(`SELECT id, account_id, email, token_hash, consumed_at FROM magic_links WHERE id = ?`)
      .get('link-1') as
      | { id: string; account_id: string; email: string; token_hash: string; consumed_at: number }
      | undefined;
    expect(kept).toEqual({
      id: 'link-1',
      account_id: 'account-1',
      email: 'iris@example.com',
      token_hash: 'hash-1',
      consumed_at: 3,
    });
  });

  it('keys a row whose name folds to nothing by its own id, so the index can still be made', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_ENTITY_KEY_SQL);
    driver
      .prepare(`INSERT INTO entities (id, canonical_name, kind) VALUES (?, ?, ?)`)
      .run('ent-1', '...', 'concept');
    driver
      .prepare(`INSERT INTO entities (id, canonical_name, kind) VALUES (?, ?, ?)`)
      .run('ent-2', '&', 'concept');

    // Two rows with no name to fold is exactly the case the unique index has no
    // answer for, so the migration has to give each of them something of its own.
    expect(() => applySchema(driver)).not.toThrow();

    const rows = driver
      .prepare(`SELECT id, canonical_key FROM entities ORDER BY id`)
      .all() as { id: string; canonical_key: string }[];
    expect(rows).toEqual([
      { id: 'ent-1', canonical_key: 'ent-1' },
      { id: 'ent-2', canonical_key: 'ent-2' },
    ]);
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

  it('gives every existing Topic the default Cluster window', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_VELOCITY_REAL_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('topic-1', 'user-1', 'ai', 'AI', 'AI news', 'technology', 'freeform', 1);

    applySchema(driver);

    const row = driver
      .prepare(`SELECT cluster_window_days FROM topics WHERE id = ?`)
      .get('topic-1') as { cluster_window_days: number } | undefined;
    expect(row?.cluster_window_days).toBe(7);
  });

  it('keys the Entities a database already held, from the names it already has', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_ENTITY_KEY_SQL);
    driver
      .prepare(`INSERT INTO sources (id, slug, name, homepage_url) VALUES (?, ?, ?, ?)`)
      .run('src-1', 'outlet', 'Outlet', 'https://example.com');
    driver
      .prepare(
        `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        'a-1',
        'src-1',
        'ext-1',
        'https://example.com/1',
        'Acme Corp launches Foo',
        WIRE_COPIES[0]!.body,
        1000,
        1000,
      );
    driver
      .prepare(`INSERT INTO entities (id, canonical_name, kind) VALUES (?, ?, ?)`)
      .run('ent-1', 'Acme Corp', 'concept');
    driver
      .prepare(`INSERT INTO article_entities (article_id, entity_id) VALUES (?, ?)`)
      .run('a-1', 'ent-1');

    applySchema(driver);

    const row = driver
      .prepare(`SELECT canonical_name, canonical_key FROM entities WHERE id = ?`)
      .get('ent-1') as { canonical_name: string; canonical_key: string };
    // The name is unchanged, so nothing that reads it stops working, and the key
    // is there for the next Article that writes the same company another way.
    expect(row.canonical_name).toBe('Acme Corp');
    expect(row.canonical_key).toBe('acme');
  });

  it('merges the two rows an older build wrote for one Entity, so the unique key can exist', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_ENTITY_KEY_SQL);
    driver
      .prepare(`INSERT INTO sources (id, slug, name, homepage_url) VALUES (?, ?, ?, ?)`)
      .run('src-1', 'outlet', 'Outlet', 'https://example.com');
    const insertArticle = (id: string, externalId: string): void => {
      driver
        .prepare(
          `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(id, 'src-1', externalId, 'https://example.com/x', 'Headline', WIRE_COPIES[0]!.body, 1000, 1000);
    };
    insertArticle('a-1', 'ext-1');
    insertArticle('a-2', 'ext-2');
    driver
      .prepare(`INSERT INTO entities (id, canonical_name, kind) VALUES (?, ?, ?)`)
      .run('ent-1', 'Acme Corp', 'concept');
    driver
      .prepare(`INSERT INTO entities (id, canonical_name, kind) VALUES (?, ?, ?)`)
      .run('ent-2', 'Acme', 'concept');
    driver
      .prepare(`INSERT INTO article_entities (article_id, entity_id) VALUES (?, ?)`)
      .run('a-1', 'ent-1');
    driver
      .prepare(`INSERT INTO article_entities (article_id, entity_id) VALUES (?, ?)`)
      .run('a-2', 'ent-2');

    // Two rows for one name is what the unique index on the key cannot be made
    // against, so the migration is where the two have to become one.
    expect(() => applySchema(driver)).not.toThrow();

    const rows = driver
      .prepare(`SELECT id, canonical_key FROM entities ORDER BY id`)
      .all() as { id: string; canonical_key: string }[];
    expect(rows).toEqual([{ id: 'ent-1', canonical_key: 'acme' }]);
    // And both Articles still reach it, so neither is left pointing at nothing.
    const linked = driver
      .prepare(
        `SELECT article_id, entity_id FROM article_entities ORDER BY article_id`,
      )
      .all() as { article_id: string; entity_id: string }[];
    expect(linked).toEqual([
      { article_id: 'a-1', entity_id: 'ent-1' },
      { article_id: 'a-2', entity_id: 'ent-1' },
    ]);
  });

  it('widens velocity to a real number so a fractional rate survives', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_VELOCITY_REAL_SQL);
    driver.prepare(`INSERT INTO users (id) VALUES (?)`).run('user-1');
    driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run('topic-1', 'user-1', 'ai', 'AI', 'AI news', 'technology', 'freeform', 1);
    expect(columnType(driver, 'clusters', 'velocity')).toBe('INTEGER');

    applySchema(driver);

    expect(columnType(driver, 'clusters', 'velocity')).toBe('REAL');
  });

  it('keeps a Cluster a fractional velocity is written into', () => {
    const driver = createInMemorySqliteDriver();
    driver.exec(PRE_VELOCITY_REAL_SQL);
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

    driver
      .prepare(`UPDATE clusters SET velocity = ? WHERE id = ?`)
      .run(0.142857, 'cluster-1');
    const row = driver
      .prepare(`SELECT velocity, title FROM clusters WHERE id = ?`)
      .get('cluster-1') as { velocity: number; title: string } | undefined;
    expect(row?.title).toBe('Kept');
    expect(row?.velocity).toBeCloseTo(0.142857, 6);
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
