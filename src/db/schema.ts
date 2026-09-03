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

export const sources = sqliteTable(
  'sources',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    homepageUrl: text('homepage_url').notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex('sources_slug_unique').on(t.slug),
  }),
);

export const topicTemplates = sqliteTable(
  'topic_templates',
  {
    id: text('id').primaryKey(),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    blurb: text('blurb').notNull(),
    category: text('category', {
      enum: [
        'news',
        'technology',
        'science',
        'business',
        'policy',
        'unspecified',
      ],
    }).notNull(),
  },
  (t) => ({
    slugUnique: uniqueIndex('topic_templates_slug_unique').on(t.slug),
    categoryIdx: index('topic_templates_category_idx').on(t.category),
  }),
);

export const topicTemplateSources = sqliteTable(
  'topic_template_sources',
  {
    topicTemplateId: text('topic_template_id')
      .notNull()
      .references(() => topicTemplates.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: uniqueIndex('topic_template_sources_pk').on(
      t.topicTemplateId,
      t.sourceId,
    ),
    templateIdx: index('topic_template_sources_template_idx').on(
      t.topicTemplateId,
    ),
  }),
);

export const topics = sqliteTable(
  'topics',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    slug: text('slug').notNull(),
    title: text('title').notNull(),
    blurb: text('blurb').notNull(),
    category: text('category', {
      enum: [
        'news',
        'technology',
        'science',
        'business',
        'policy',
        'unspecified',
      ],
    }).notNull(),
    originKind: text('origin_kind', { enum: ['template', 'freeform'] })
      .notNull(),
    originTemplateId: text('origin_template_id').references(
      () => topicTemplates.id,
      { onDelete: 'set null' },
    ),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userSlugUnique: uniqueIndex('topics_user_slug_unique').on(
      t.userId,
      t.slug,
    ),
    userIdx: index('topics_user_idx').on(t.userId),
  }),
);

export const topicSources = sqliteTable(
  'topic_sources',
  {
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    position: integer('position').notNull(),
  },
  (t) => ({
    pk: uniqueIndex('topic_sources_pk').on(t.topicId, t.sourceId),
    topicIdx: index('topic_sources_topic_idx').on(t.topicId),
  }),
);

export const deliverySettings = sqliteTable(
  'delivery_settings',
  {
    userId: text('user_id')
      .primaryKey()
      .references(() => users.id, { onDelete: 'cascade' }),
    hour: integer('hour').notNull(),
    minute: integer('minute').notNull(),
    timezone: text('timezone').notNull(),
    welcomeSentAt: integer('welcome_sent_at', { mode: 'timestamp_ms' }),
    updatedAt: integer('updated_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
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
export type SourceRow = typeof sources.$inferSelect;
export type NewSourceRow = typeof sources.$inferInsert;
export type TopicTemplateRow = typeof topicTemplates.$inferSelect;
export type NewTopicTemplateRow = typeof topicTemplates.$inferInsert;
export type TopicTemplateSourceRow = typeof topicTemplateSources.$inferSelect;
export type NewTopicTemplateSourceRow = typeof topicTemplateSources.$inferInsert;
export type TopicRow = typeof topics.$inferSelect;
export type NewTopicRow = typeof topics.$inferInsert;
export type TopicSourceRow = typeof topicSources.$inferSelect;
export type NewTopicSourceRow = typeof topicSources.$inferInsert;
export type DeliverySettingsRow = typeof deliverySettings.$inferSelect;
export type NewDeliverySettingsRow = typeof deliverySettings.$inferInsert;