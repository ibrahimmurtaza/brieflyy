import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  uniqueIndex,
  index,
} from 'drizzle-orm/sqlite-core';

export const users = sqliteTable(
  'users',
  {
    id: text('id').primaryKey(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    onboardingState: text('onboarding_state', {
      enum: ['not_started', 'topics_picked', 'delivery_set', 'completed'],
    })
      .notNull()
      .default('not_started'),
  },
  (t) => ({
    onboardingIdx: index('users_onboarding_idx').on(t.onboardingState),
  }),
);

export const accounts = sqliteTable(
  'accounts',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    emailVerifiedAt: integer('email_verified_at', { mode: 'timestamp_ms' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    emailUnique: uniqueIndex('accounts_email_unique').on(t.email),
    userIdx: index('accounts_user_idx').on(t.userId),
  }),
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    revokedAt: integer('revoked_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    userIdx: index('sessions_user_idx').on(t.userId),
    expiresIdx: index('sessions_expires_idx').on(t.expiresAt),
  }),
);

export const magicLinks = sqliteTable(
  'magic_links',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    tokenHashUnique: uniqueIndex('magic_links_token_hash_unique').on(t.tokenHash),
    accountIdx: index('magic_links_account_idx').on(t.accountId),
  }),
);

export const oauthStates = sqliteTable(
  'oauth_states',
  {
    id: text('id').primaryKey(),
    stateHash: text('state_hash').notNull(),
    codeVerifierHash: text('code_verifier_hash').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    expiresAt: integer('expires_at', { mode: 'timestamp_ms' }).notNull(),
    consumedAt: integer('consumed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    stateHashUnique: uniqueIndex('oauth_states_state_hash_unique').on(t.stateHash),
    expiresIdx: index('oauth_states_expires_idx').on(t.expiresAt),
  }),
);

export const oauthAccounts = sqliteTable(
  'oauth_accounts',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider', { enum: ['google'] }).notNull(),
    providerSubject: text('provider_subject').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    providerSubjectUnique: uniqueIndex('oauth_accounts_provider_subject_unique').on(
      t.provider,
      t.providerSubject,
    ),
    accountIdx: index('oauth_accounts_account_idx').on(t.accountId),
  }),
);

export type UserRow = typeof users.$inferSelect;
export type NewUserRow = typeof users.$inferInsert;
export type AccountRow = typeof accounts.$inferSelect;
export type NewAccountRow = typeof accounts.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type MagicLinkRow = typeof magicLinks.$inferSelect;
export type NewMagicLinkRow = typeof magicLinks.$inferInsert;
export type OAuthStateRow = typeof oauthStates.$inferSelect;
export type NewOAuthStateRow = typeof oauthStates.$inferInsert;
export type OAuthAccountRow = typeof oauthAccounts.$inferSelect;
export type NewOAuthAccountRow = typeof oauthAccounts.$inferInsert;