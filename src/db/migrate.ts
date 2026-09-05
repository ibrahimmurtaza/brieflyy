import type { SqliteDriver } from './client.js';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  onboarding_state TEXT NOT NULL DEFAULT 'not_started'
);
CREATE INDEX IF NOT EXISTS users_onboarding_idx ON users (onboarding_state);

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
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000),
  expires_at INTEGER NOT NULL,
  consumed_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS magic_links_token_hash_unique ON magic_links (token_hash);
CREATE INDEX IF NOT EXISTS magic_links_account_idx ON magic_links (account_id);

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
  created_at INTEGER NOT NULL DEFAULT (unixepoch() * 1000)
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
  fingerprint TEXT NOT NULL,
  story_id TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS articles_source_external_unique ON articles (source_id, external_id);
CREATE INDEX IF NOT EXISTS articles_source_idx ON articles (source_id);
CREATE INDEX IF NOT EXISTS articles_fingerprint_idx ON articles (fingerprint);
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
  fingerprint TEXT NOT NULL,
  first_seen_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS stories_source_fingerprint_idx ON stories (source_id, fingerprint);
CREATE INDEX IF NOT EXISTS stories_source_idx ON stories (source_id);
`;

export function applySchema(driver: SqliteDriver): void {
  driver.exec(SCHEMA_SQL);
}