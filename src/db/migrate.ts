import Database from 'better-sqlite3';

import type { SqliteDriver } from './client.js';
import { extractSignature } from '../domain/extract.js';
import {
  encodeSignature,
  normalizeSignature,
} from '../domain/story-signature.js';
import { readRequiredString } from '../env.js';
import { pathToFileURL } from 'node:url';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  onboarding_state TEXT NOT NULL DEFAULT 'not_started',
  tier TEXT NOT NULL DEFAULT 'free'
);
CREATE INDEX IF NOT EXISTS users_onboarding_idx ON users (onboarding_state);
CREATE INDEX IF NOT EXISTS users_tier_idx ON users (tier);

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  email_verified_at INTEGER,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS accounts_email_unique ON accounts (email);
CREATE INDEX IF NOT EXISTS accounts_user_idx ON accounts (user_id);

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL,
  revoked_at INTEGER
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS magic_links_token_hash_unique ON magic_links (token_hash);
CREATE INDEX IF NOT EXISTS magic_links_account_idx ON magic_links (account_id);
CREATE INDEX IF NOT EXISTS magic_links_email_idx ON magic_links (email);

CREATE TABLE IF NOT EXISTS oauth_states (
  id TEXT PRIMARY KEY NOT NULL,
  state_hash TEXT NOT NULL,
  code_verifier_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_states_state_hash_unique ON oauth_states (state_hash);
CREATE INDEX IF NOT EXISTS oauth_states_expires_idx ON oauth_states (expires_at);

CREATE TABLE IF NOT EXISTS oauth_accounts (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL,
  provider_subject TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE UNIQUE INDEX IF NOT EXISTS oauth_accounts_provider_subject_unique ON oauth_accounts (provider, provider_subject);
CREATE INDEX IF NOT EXISTS oauth_accounts_account_idx ON oauth_accounts (account_id);

CREATE TABLE IF NOT EXISTS sources (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  name TEXT NOT NULL,
  homepage_url TEXT NOT NULL,
  feed_url TEXT,
  last_polled_at INTEGER,
  last_success_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS sources_slug_unique ON sources (slug);

CREATE TABLE IF NOT EXISTS topic_templates (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  blurb TEXT NOT NULL,
  category TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS topic_templates_slug_unique ON topic_templates (slug);
CREATE INDEX IF NOT EXISTS topic_templates_category_idx ON topic_templates (category);

CREATE TABLE IF NOT EXISTS topic_template_sources (
  topic_template_id TEXT NOT NULL REFERENCES topic_templates(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS topic_template_sources_pk ON topic_template_sources (topic_template_id, source_id);
CREATE INDEX IF NOT EXISTS topic_template_sources_template_idx ON topic_template_sources (topic_template_id);

CREATE TABLE IF NOT EXISTS topics (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  slug TEXT NOT NULL,
  title TEXT NOT NULL,
  blurb TEXT NOT NULL,
  category TEXT NOT NULL,
  origin_kind TEXT NOT NULL,
  origin_template_id TEXT REFERENCES topic_templates(id) ON DELETE SET NULL,
  cadence TEXT NOT NULL DEFAULT 'daily',
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  removed_at INTEGER,
  cluster_window_days INTEGER NOT NULL DEFAULT 7
);
CREATE UNIQUE INDEX IF NOT EXISTS topics_user_slug_unique ON topics (user_id, slug);
CREATE INDEX IF NOT EXISTS topics_user_idx ON topics (user_id);

CREATE TABLE IF NOT EXISTS topic_sources (
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS topic_sources_pk ON topic_sources (topic_id, source_id);
CREATE INDEX IF NOT EXISTS topic_sources_topic_idx ON topic_sources (topic_id);

CREATE TABLE IF NOT EXISTS delivery_settings (
  user_id TEXT PRIMARY KEY NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hour INTEGER NOT NULL,
  minute INTEGER NOT NULL,
  timezone TEXT NOT NULL,
  welcome_sent_at INTEGER,
  updated_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);

CREATE TABLE IF NOT EXISTS entities (
  id TEXT PRIMARY KEY NOT NULL,
  canonical_name TEXT NOT NULL,
  kind TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS entities_canonical_name_unique ON entities (canonical_name);

CREATE TABLE IF NOT EXISTS articles (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  external_id TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  ingested_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  signature TEXT NOT NULL DEFAULT '{}',
  story_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_source_external_unique ON articles (source_id, external_id);
CREATE INDEX IF NOT EXISTS articles_source_idx ON articles (source_id);
CREATE INDEX IF NOT EXISTS articles_story_idx ON articles (story_id);
CREATE INDEX IF NOT EXISTS articles_published_idx ON articles (published_at);

CREATE TABLE IF NOT EXISTS article_entities (
  article_id TEXT NOT NULL REFERENCES articles(id) ON DELETE CASCADE,
  entity_id TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS article_entities_pk ON article_entities (article_id, entity_id);
CREATE INDEX IF NOT EXISTS article_entities_entity_idx ON article_entities (entity_id);

CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY NOT NULL,
  source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  signature TEXT NOT NULL DEFAULT '{}',
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  first_published_at INTEGER NOT NULL DEFAULT 0,
  last_published_at INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS stories_source_idx ON stories (source_id);
CREATE INDEX IF NOT EXISTS stories_published_idx ON stories (last_published_at);

CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  bullet_points TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  article_count INTEGER NOT NULL,
  velocity REAL NOT NULL,
  source_ids TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
);
CREATE INDEX IF NOT EXISTS clusters_topic_idx ON clusters (topic_id);

CREATE TABLE IF NOT EXISTS cluster_stories (
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  story_id TEXT NOT NULL REFERENCES stories(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS cluster_stories_pk ON cluster_stories (cluster_id, story_id);

CREATE TABLE IF NOT EXISTS feedback_events (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cluster_id TEXT NOT NULL REFERENCES clusters(id) ON DELETE CASCADE,
  feedback_type TEXT NOT NULL,
  scope TEXT,
  timestamp INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
);
CREATE INDEX IF NOT EXISTS feedback_events_user_cluster_type_idx ON feedback_events (user_id, cluster_id, feedback_type);
CREATE INDEX IF NOT EXISTS feedback_events_user_cluster_idx ON feedback_events (user_id, cluster_id);

CREATE TABLE IF NOT EXISTS brief_plans (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  cluster_ids TEXT NOT NULL DEFAULT ''
);
CREATE UNIQUE INDEX IF NOT EXISTS brief_plans_topic_user_idx ON brief_plans (topic_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS brief_plans_user_idx ON brief_plans (user_id);

CREATE TABLE IF NOT EXISTS brief_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  brief_plan_id TEXT NOT NULL REFERENCES brief_plans(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  html TEXT NOT NULL,
  unsubscribe_token TEXT NOT NULL,
  global_unsubscribe_token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS brief_snapshots_user_topic_idx ON brief_snapshots (user_id, topic_id);

CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brief_snapshot_id TEXT NOT NULL REFERENCES brief_snapshots(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  sent_at INTEGER NOT NULL,
  unsubscribe_token TEXT NOT NULL,
  global_unsubscribe_token TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS email_deliveries_user_snapshot_idx ON email_deliveries (user_id, brief_snapshot_id);
`;

/**
 * Tables whose shape changed after they were first shipped. SQLite cannot add
 * a foreign key to an existing table, so a database created by an older build
 * is rebuilt: create the current shape under a temp name, copy the columns both
 * shapes share, drop the old table, rename. A no-op once the table already has
 * every foreign key named in `foreignKeys`, so a migrated database stays put.
 */
interface TableRebuild {
  readonly table: string;
  readonly createSql: string;
  readonly columns: readonly string[];
  readonly foreignKeys: readonly { readonly column: string; readonly table: string }[];
  /**
   * Columns the current shape requires to be `NOT NULL`. SQLite cannot relax a
   * constraint on an existing table, so a table that has one of these columns
   * nullable is rebuilt even when its foreign keys are already right.
   */
  readonly notNull?: readonly string[];
  /**
   * Declared SQL type per column, for the columns whose type changed after the
   * table shipped. SQLite cannot alter a column's type in place either, so a
   * table that has one of these as the wrong type is rebuilt even when its
   * foreign keys are already right. `clusters.velocity` is the case that
   * needed it: velocity became a Stories-per-day rate, and an INTEGER column
   * silently truncates every fraction of one.
   */
  readonly types?: Readonly<Record<string, string>>;
  /**
   * SQL for a column the old table does not have, written against the old table
   * and its aliases. Needed when a new required column can only be worked out
   * from the rows already stored.
   */
  readonly backfill?: Readonly<Record<string, string>>;
}

/** Whether a table exists in this database. */
function tableExists(driver: SqliteDriver, table: string): boolean {
  return (
    driver
      .prepare(
        `SELECT 1 AS found FROM sqlite_master WHERE type = 'table' AND name = ?`,
      )
      .get(table) !== undefined
  );
}

function columnNames(driver: SqliteDriver, table: string): Set<string> {
  const rows = driver
    .prepare(`SELECT name FROM pragma_table_info(?)`)
    .all(table) as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

/** Columns of a table that are declared `NOT NULL`. */
function notNullColumns(driver: SqliteDriver, table: string): Set<string> {
  const rows = driver
    .prepare(`SELECT name, "notnull" AS is_not_null FROM pragma_table_info(?)`)
    .all(table) as { name: string; is_not_null: number }[];
  return new Set(rows.filter((r) => r.is_not_null === 1).map((r) => r.name));
}

function foreignKeyPairs(
  driver: SqliteDriver,
  table: string,
): Set<string> {
  const rows = driver
    .prepare(`SELECT "from", "table" AS target FROM pragma_foreign_key_list(?)`)
    .all(table) as { from: string; target: string }[];
  return new Set(rows.map((r) => `${r.from}->${r.target}`));
}

/** The declared SQL type of every column of a table. */
function columnTypes(driver: SqliteDriver, table: string): Map<string, string> {
  const rows = driver
    .prepare(`SELECT name, type FROM pragma_table_info(?)`)
    .all(table) as { name: string; type: string }[];
  return new Map(rows.map((r) => [r.name, r.type]));
}

function rebuildTable(driver: SqliteDriver, rebuild: TableRebuild): void {
  if (!tableExists(driver, rebuild.table)) return;
  const present = foreignKeyPairs(driver, rebuild.table);
  const missingForeignKey = rebuild.foreignKeys.some(
    (fk) => !present.has(`${fk.column}->${fk.table}`),
  );
  const presentNotNull = notNullColumns(driver, rebuild.table);
  const missingNotNull = (rebuild.notNull ?? []).some(
    (column) => !presentNotNull.has(column),
  );
  // SQLite reports the declared type uppercased, and a column the old table does
  // not have at all is left to `createSql` failing rather than compared here.
  const presentTypes = columnTypes(driver, rebuild.table);
  const wrongType = Object.entries(rebuild.types ?? {}).some(
    ([column, type]) =>
      presentTypes.has(column) && presentTypes.get(column) !== type,
  );
  if (!missingForeignKey && !missingNotNull && !wrongType) return;

  const temp = `${rebuild.table}__rebuild`;
  const existing = columnNames(driver, rebuild.table);
  // `legacy_alter_table` keeps the rename from rewriting the REFERENCES clauses
  // of other tables that point at this one; they should keep naming it.
  const fkWere = driver.pragma('foreign_keys', { simple: true });
  const legacyWere = driver.pragma('legacy_alter_table', { simple: true });
  driver.pragma('foreign_keys = OFF');
  driver.pragma('legacy_alter_table = ON');
  try {
    driver.transaction(() => {
      driver.exec(
        rebuild.createSql.replace(
          /\bCREATE TABLE (?:IF NOT EXISTS )?(\w+)/,
          `CREATE TABLE ${temp}`,
        ),
      );
      const shared = rebuild.columns.filter(
        (c) => existing.has(c) || rebuild.backfill?.[c] !== undefined,
      );
      const columnList = shared.join(', ');
      const selectList = shared
        .map((c) => rebuild.backfill?.[c] ?? c)
        .join(', ');
      driver.exec(
        `INSERT INTO ${temp} (${columnList}) SELECT ${selectList} FROM ${rebuild.table}`,
      );
      driver.exec(`DROP TABLE ${rebuild.table}`);
      driver.exec(`ALTER TABLE ${temp} RENAME TO ${rebuild.table}`);
    })();
  } finally {
    driver.pragma(`legacy_alter_table = ${legacyWere ? 'ON' : 'OFF'}`);
    driver.pragma(`foreign_keys = ${fkWere ? 'ON' : 'OFF'}`);
  }
}

/** Drop a same-named index that is not unique, so the unique form can be made. */
function rebuildNonUniqueIndexes(driver: SqliteDriver): void {
  for (const statement of schemaStatements()) {
    const m = /^CREATE UNIQUE INDEX IF NOT EXISTS (\w+)/.exec(statement);
    if (!m) continue;
    const name = m[1] as string;
    const existing = driver
      .prepare(`SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?`)
      .get(name) as { sql: string | null } | undefined;
    if (existing?.sql && !/^\s*CREATE UNIQUE INDEX/i.test(existing.sql)) {
      driver.exec(`DROP INDEX ${name}`);
    }
  }
}

const TABLE_REBUILDS: readonly TableRebuild[] = [
  {
    table: 'clusters',
    foreignKeys: [{ column: 'topic_id', table: 'topics' }],
    types: { velocity: 'REAL' },
    columns: [
      'id',
      'topic_id',
      'title',
      'summary',
      'bullet_points',
      'created_at',
      'last_seen_at',
      'article_count',
      'velocity',
      'source_ids',
      'state',
    ],
    createSql: `CREATE TABLE IF NOT EXISTS clusters (
  id TEXT PRIMARY KEY NOT NULL,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  summary TEXT NOT NULL,
  bullet_points TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  article_count INTEGER NOT NULL,
  velocity REAL NOT NULL,
  source_ids TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'active'
)`,
  },
  {
    table: 'brief_snapshots',
    foreignKeys: [
      { column: 'user_id', table: 'users' },
      { column: 'topic_id', table: 'topics' },
    ],
    columns: [
      'id',
      'brief_plan_id',
      'user_id',
      'topic_id',
      'created_at',
      'html',
      'unsubscribe_token',
      'global_unsubscribe_token',
    ],
    createSql: `CREATE TABLE IF NOT EXISTS brief_snapshots (
  id TEXT PRIMARY KEY NOT NULL,
  brief_plan_id TEXT NOT NULL REFERENCES brief_plans(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  html TEXT NOT NULL,
  unsubscribe_token TEXT NOT NULL,
  global_unsubscribe_token TEXT NOT NULL
)`,
  },
  {
    table: 'email_deliveries',
    foreignKeys: [
      { column: 'user_id', table: 'users' },
      { column: 'topic_id', table: 'topics' },
    ],
    columns: [
      'id',
      'user_id',
      'brief_snapshot_id',
      'topic_id',
      'sent_at',
      'unsubscribe_token',
      'global_unsubscribe_token',
    ],
    createSql: `CREATE TABLE IF NOT EXISTS email_deliveries (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  brief_snapshot_id TEXT NOT NULL REFERENCES brief_snapshots(id) ON DELETE CASCADE,
  topic_id TEXT NOT NULL REFERENCES topics(id) ON DELETE CASCADE,
  sent_at INTEGER NOT NULL,
  unsubscribe_token TEXT NOT NULL,
  global_unsubscribe_token TEXT NOT NULL
)`,
  },
  {
    // Magic links used to name an Account, which meant a User and an Account had
    // to exist before the link was verified. They now carry the address and are
    // pointed at the account on verification, so account_id has to become
    // nullable and the address needs a column of its own.
    table: 'magic_links',
    foreignKeys: [{ column: 'account_id', table: 'accounts' }],
    notNull: ['id', 'email', 'token_hash', 'created_at', 'expires_at'],
    backfill: {
      email: "COALESCE((SELECT a.email FROM accounts a WHERE a.id = magic_links.account_id), '')",
    },
    columns: [
      'id',
      'account_id',
      'email',
      'token_hash',
      'created_at',
      'expires_at',
      'consumed_at',
    ],
    createSql: `CREATE TABLE IF NOT EXISTS magic_links (
  id TEXT PRIMARY KEY NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
)`,
  },
];

interface ColumnMigration {
  readonly table: string;
  readonly column: string;
  readonly ddl: string;
}

/**
 * Columns added to an existing table after it shipped. `CREATE TABLE IF NOT
 * EXISTS` cannot change a table that already exists, so a new column needs an
 * entry here as well as a line in SCHEMA_SQL. A no-op once the column is there,
 * which is what makes re-running the migration safe.
 */
const COLUMN_MIGRATIONS: readonly ColumnMigration[] = [
  {
    table: 'topics',
    column: 'cadence',
    ddl: `ALTER TABLE topics ADD COLUMN cadence TEXT NOT NULL DEFAULT 'daily'`,
  },
  {
    table: 'topics',
    column: 'removed_at',
    ddl: `ALTER TABLE topics ADD COLUMN removed_at INTEGER`,
  },
  {
    // How far back this Topic looks when it forms Clusters. The glossary makes
    // the 7d window a per-Topic tunable, so it is a column rather than a
    // constant, and the default puts every existing Topic on the window the
    // glossary names.
    table: 'topics',
    column: 'cluster_window_days',
    ddl: `ALTER TABLE topics ADD COLUMN cluster_window_days INTEGER NOT NULL DEFAULT 7`,
  },
  {
    // Tier was a literal passed into service functions. Making it a fact about a
    // User means the paywalls read the same value the glossary describes, and
    // the default keeps every existing row on the free tier they always had.
    table: 'users',
    column: 'tier',
    ddl: `ALTER TABLE users ADD COLUMN tier TEXT NOT NULL DEFAULT 'free'`,
  },
  {
    // An Article's Story signature, stored rather than hashed, so that matching
    // an Article against a Story is a comparison of the two rather than a test
    // for equality. Rows written before this column existed read back as an
    // empty signature, which matches nothing, and the next poll of that feed
    // re-derives it.
    table: 'articles',
    column: 'signature',
    ddl: `ALTER TABLE articles ADD COLUMN signature TEXT NOT NULL DEFAULT '{}'`,
  },
  {
    table: 'stories',
    column: 'signature',
    ddl: `ALTER TABLE stories ADD COLUMN signature TEXT NOT NULL DEFAULT '{}'`,
  },
  {
    // The Story's published range, which is what the dedup window is measured
    // against. A Story created before this column existed has an empty range
    // and is therefore never a candidate again, rather than being compared
    // against a range of zeros and so matching everything.
    table: 'stories',
    column: 'first_published_at',
    ddl: `ALTER TABLE stories ADD COLUMN first_published_at INTEGER NOT NULL DEFAULT 0`,
  },
  {
    table: 'stories',
    column: 'last_published_at',
    ddl: `ALTER TABLE stories ADD COLUMN last_published_at INTEGER NOT NULL DEFAULT 0`,
  },
];

/**
 * Columns a table used to carry and no longer declares. SQLite can drop a
 * column, but only once nothing indexes it, so the index goes first. A no-op
 * once the column is gone, and a no-op on a database that never had it.
 *
 * The retired `fingerprint` columns are the reason this exists. They held a hash
 * of the Article's key phrases and were the sole test for whether two Articles
 * were one Story, so leaving them on an existing database would leave a column
 * nothing reads and that a later reader could reasonably take for the identity of
 * a Story.
 */
const RETIRED_COLUMNS: readonly {
  readonly table: string;
  readonly column: string;
  readonly indexes: readonly string[];
}[] = [
  { table: 'articles', column: 'fingerprint', indexes: ['articles_fingerprint_idx'] },
  {
    table: 'stories',
    column: 'fingerprint',
    indexes: ['stories_source_fingerprint_idx'],
  },
];

function applyRetiredColumns(driver: SqliteDriver): void {
  for (const retired of RETIRED_COLUMNS) {
    if (!tableExists(driver, retired.table)) continue;
    if (!hasColumn(driver, retired.table, retired.column)) continue;
    for (const index of retired.indexes) {
      driver.exec(`DROP INDEX IF EXISTS ${index}`);
    }
    driver.exec(`ALTER TABLE ${retired.table} DROP COLUMN ${retired.column}`);
  }
}

function hasColumn(
  driver: SqliteDriver,
  table: string,
  column: string,
): boolean {
  const row = driver
    .prepare(
      `SELECT 1 AS found FROM pragma_table_info(?) WHERE name = ?`,
    )
    .get(table, column) as { found: number } | undefined;
  return row !== undefined;
}

function applyColumnMigrations(driver: SqliteDriver): void {
  for (const migration of COLUMN_MIGRATIONS) {
    if (!tableExists(driver, migration.table)) continue;
    if (!hasColumn(driver, migration.table, migration.column)) {
      driver.exec(migration.ddl);
    }
  }
}

function applyTableRebuilds(driver: SqliteDriver): void {
  for (const rebuild of TABLE_REBUILDS) {
    rebuildTable(driver, rebuild);
  }
}

/**
 * Give Stories that predate the signature columns the two things a Story needs
 * to be matched again: a signature to compare an incoming Article against, and
 * the publication range the dedup window is measured over.
 *
 * Without this, every Story written by an older build reads back with an empty
 * signature and a zero range, matches nothing, and is never a candidate again —
 * so the next poll of every feed re-formed all of its Stories from scratch and
 * the Story table doubled. The Articles are right there in the same database, so
 * both values are derived from them: the signature from the oldest Article's text
 * and the range from the oldest and newest Article in the Story.
 *
 * A Story with no Articles has neither, and there is nothing to derive from, so
 * it is left alone: it was already a Story that nothing could be added to.
 */
function backfillStorySignatures(driver: SqliteDriver): void {
  if (!tableExists(driver, 'stories') || !tableExists(driver, 'articles')) {
    return;
  }
  const stories = driver
    .prepare(
      `SELECT s.id AS id,
              MIN(a.published_at) AS first_published_at,
              MAX(a.published_at) AS last_published_at
       FROM stories s
       JOIN articles a ON a.story_id = s.id
       WHERE s.signature = '{}'
       GROUP BY s.id`,
    )
    .all() as {
    id: string;
    first_published_at: number;
    last_published_at: number;
  }[];
  const update = driver.prepare(
    `UPDATE stories SET signature = ?, first_published_at = ?, last_published_at = ? WHERE id = ?`,
  );
  const oldestBody = driver.prepare(
    `SELECT body FROM articles
     WHERE story_id = ? AND published_at = ?
     ORDER BY id
     LIMIT 1`,
  );
  for (const story of stories) {
    const row = oldestBody.get(story.id, story.first_published_at) as
      | { body: string }
      | undefined;
    if (!row) continue;
    const signature = normalizeSignature(extractSignature(row.body));
    update.run(
      encodeSignature(signature),
      story.first_published_at,
      story.last_published_at,
      story.id,
    );
  }
}

/**
 * Give Articles that predate the signature column the key phrases that used to
 * exist only in memory for the duration of one ingest.
 *
 * The Article's signature is what a later read returns, so an Article written by
 * an older build reads back empty: half the matching mechanism, the words and
 * phrases, simply is not there for anything written before the column. The body
 * is right there in the same row, so the signature is derived from it.
 *
 * Only rows the column migration left empty are touched. A signature a newer
 * build wrote is left exactly as it is, since that build derived it from the
 * same body but may not have done it the way this one would.
 */
function backfillArticleSignatures(driver: SqliteDriver): void {
  if (!tableExists(driver, 'articles') || !hasColumn(driver, 'articles', 'signature')) {
    return;
  }
  const unsigned = driver
    .prepare(`SELECT id, body FROM articles WHERE signature = '{}'`)
    .all() as { id: string; body: string }[];
  if (unsigned.length === 0) return;
  const update = driver.prepare(`UPDATE articles SET signature = ? WHERE id = ?`);
  for (const article of unsigned) {
    // An Article with no text to take a signature from has none, and an empty
    // signature says exactly that. Writing one for a body that was never read
    // would be inventing a claim about it.
    update.run(encodeSignature(normalizeSignature(extractSignature(article.body))), article.id);
  }
}

export function applySchema(driver: SqliteDriver): void {
  // Tables and columns that changed shape are brought up to date first, so the
  // DDL below already matches what they became: an index on a column an older
  // table does not have would otherwise fail against the table as it stands.
  applyTableRebuilds(driver);
  applyColumnMigrations(driver);
  applyRetiredColumns(driver);
  driver.exec(SCHEMA_SQL);
  rebuildNonUniqueIndexes(driver);
  // Recreate any index the rebuilds dropped with their tables.
  driver.exec(SCHEMA_SQL);
  // Run last because they read the tables in their current shape, and only
  // touch rows the new columns left empty.
  backfillStorySignatures(driver);
  backfillArticleSignatures(driver);
}

function schemaStatements(): string[] {
  return SCHEMA_SQL.split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Apply the schema to the database named by `DATABASE_URL`. Exported so the
 * migration command and the boot path are the same code, and so a test can run
 * it against a temporary file.
 */
export function migrateToDatabaseFile(filename: string): void {
  const driver = new Database(filename);
  try {
    applySchema(driver);
  } finally {
    driver.close();
  }
}

function databaseFileFromEnv(): string {
  return readRequiredString(process.env, 'DATABASE_URL').replace(/^file:/, '');
}

function runCli(): void {
  const file = databaseFileFromEnv();
  migrateToDatabaseFile(file);
  const driver = new Database(file, { readonly: true });
  const tables = (
    driver
      .prepare(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`)
      .all() as { name: string }[]
  ).map((r) => r.name);
  driver.close();
  console.log(`Migrated ${file}`);
  console.log(`Tables: ${tables.join(', ')}`);
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    runCli();
  } catch (err) {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  }
}
