import { sql } from 'drizzle-orm';
import {
  sqliteTable,
  text,
  integer,
  real,
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
    // What the User pays for, and therefore what they get. Not a billing
    // integration: it is the fact every paywall reads, so it has to be persisted
    // rather than passed around as a literal.
    tier: text('tier', { enum: ['free', 'paid'] }).notNull().default('free'),
    // The opt-out a one-click unsubscribe in a brief sets. Nullable because
    // "still receiving" is the state almost every User is in, and a sentinel
    // would make the daily job's every-pass check a comparison against a made-up
    // value rather than against nothing.
    unsubscribedAt: integer('unsubscribed_at', { mode: 'timestamp_ms' }),
  },
  (t) => ({
    onboardingIdx: index('users_onboarding_idx').on(t.onboardingState),
    tierIdx: index('users_tier_idx').on(t.tier),
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
    // Null until the link is verified: the account it belongs to does not exist
    // until someone proves they can read the address' mail.
    accountId: text('account_id').references(() => accounts.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
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
    emailIdx: index('magic_links_email_idx').on(t.email),
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
    feedUrl: text('feed_url'),
    lastPolledAt: integer('last_polled_at', { mode: 'timestamp_ms' }),
    lastSuccessAt: integer('last_success_at', { mode: 'timestamp_ms' }),
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
    cadence: text('cadence', { enum: ['daily', 'weekly', 'never'] })
      .notNull()
      .default('daily'),
    /**
     * How far back this Topic looks when it forms Clusters, in days. A column
     * rather than a constant because the glossary makes the 7d window a
     * per-Topic tunable, and a constant would be the one number a User could not
     * change.
     */
    clusterWindowDays: integer('cluster_window_days').notNull().default(7),
    createdAt: integer('created_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    // Soft delete. A removed topic stops counting toward the free-tier cap and
    // disappears from listings, but its brief history stays intact.
    removedAt: integer('removed_at', { mode: 'timestamp_ms' }),
    // The opt-out a one-click unsubscribe from *this* Topic sets. Distinct from
    // `removedAt` on purpose: the Topic is still there and still readable, it
    // just stops being emailed, and clearing this column is how it starts again.
    unsubscribedAt: integer('unsubscribed_at', { mode: 'timestamp_ms' }),
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

export const entities = sqliteTable(
  'entities',
  {
    id: text('id').primaryKey(),
    canonicalName: text('canonical_name').notNull(),
    /**
     * What the Entity's identity is decided on: the name with its capitalisation,
     * punctuation and legal form folded away. Two outlets write one name several
     * ways, and the spelling a User reads is not what decides whether they are
     * talking about the same thing. A row whose name folds to nothing at all
     * carries its own id here — see `backfillEntityKeys` in `migrate.ts`.
     */
    canonicalKey: text('canonical_key').notNull(),
    kind: text('kind', {
      enum: ['person', 'org', 'place', 'product', 'concept'],
    }).notNull(),
  },
  (t) => ({
    nameUnique: uniqueIndex('entities_canonical_name_unique').on(t.canonicalName),
    keyUnique: uniqueIndex('entities_canonical_key_unique').on(t.canonicalKey),
  }),
);

export const articles = sqliteTable(
  'articles',
  {
    id: text('id').primaryKey(),
    sourceId: text('source_id')
      .notNull()
      .references(() => sources.id, { onDelete: 'cascade' }),
    externalId: text('external_id').notNull(),
    url: text('url').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    publishedAt: integer('published_at', { mode: 'timestamp_ms' }).notNull(),
    ingestedAt: integer('ingested_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
    /**
     * The Article's Story signature, stored rather than hashed. Matching an
     * Article against the Stories near it is a comparison, not an equality, so
     * a hash of the signature would throw away the part that makes it useful.
     */
    signature: text('signature').notNull().default('{}'),
    storyId: text('story_id'),
  },
  (t) => ({
    sourceExternalUnique: uniqueIndex('articles_source_external_unique').on(
      t.sourceId,
      t.externalId,
    ),
    sourceIdx: index('articles_source_idx').on(t.sourceId),
    storyIdx: index('articles_story_idx').on(t.storyId),
    publishedIdx: index('articles_published_idx').on(t.publishedAt),
  }),
);

export const articleEntities = sqliteTable(
  'article_entities',
  {
    articleId: text('article_id')
      .notNull()
      .references(() => articles.id, { onDelete: 'cascade' }),
    entityId: text('entity_id')
      .notNull()
      .references(() => entities.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: uniqueIndex('article_entities_pk').on(t.articleId, t.entityId),
    entityIdx: index('article_entities_entity_idx').on(t.entityId),
  }),
);

export const stories = sqliteTable(
  'stories',
  {
    id: text('id').primaryKey(),
    /**
     * The signature this Story was formed from. It is set once, by the Article
     * that created the Story, and does not grow as copies arrive: a Story whose
     * identity shifted every time another syndication copy landed would be a
     * different Story each time, and the copies that were the point of it would
     * not match.
     */
    signature: text('signature').notNull().default('{}'),
    firstSeenAt: integer('first_seen_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    /**
     * When this Story's oldest and newest Articles were published. The dedup
     * window is measured against these rather than against when a poll happened
     * to bring them in, so an Article republished from the archive today is
     * compared with the Stories its own date puts it near.
     */
    firstPublishedAt: integer('first_published_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`0`),
    lastPublishedAt: integer('last_published_at', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`0`),
  },
  (t) => ({
    publishedIdx: index('stories_published_idx').on(t.lastPublishedAt),
  }),
);

export const clusters = sqliteTable(
  'clusters',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    bulletPoints: text('bullet_points').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    lastSeenAt: integer('last_seen_at', { mode: 'timestamp_ms' }).notNull(),
    articleCount: integer('article_count').notNull(),
    // Stories per unit time, so a real number rather than a count. An INTEGER
    // column here would truncate every rate below one Story per unit, which is
    // most of them.
    velocity: real('velocity').notNull(),
    sourceIds: text('source_ids').notNull(),
    state: text('state', { enum: ['active', 'archive'] }).notNull().default('active'),
  },
  (t) => ({
    topicIdx: index('clusters_topic_idx').on(t.topicId),
  }),
);

export const clusterStories = sqliteTable(
  'cluster_stories',
  {
    clusterId: text('cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    storyId: text('story_id')
      .notNull()
      .references(() => stories.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    pk: uniqueIndex('cluster_stories_pk').on(t.clusterId, t.storyId),
  }),
);

export type EntityRow = typeof entities.$inferSelect;
export type NewEntityRow = typeof entities.$inferInsert;
export type ArticleRow = typeof articles.$inferSelect;
export type NewArticleRow = typeof articles.$inferInsert;
export type ArticleEntityRow = typeof articleEntities.$inferSelect;
export type NewArticleEntityRow = typeof articleEntities.$inferInsert;
export type StoryRow = typeof stories.$inferSelect;
export type NewStoryRow = typeof stories.$inferInsert;
export type ClusterRow = typeof clusters.$inferSelect;
export type ClusterStoryRow = typeof clusterStories.$inferSelect;

/**
 * One Topic's trends, materialised.
 *
 * The measurement behind this — every Article every Entity was named in across a
 * thirty-day baseline — is far too much work to do while somebody is waiting for a
 * page, so it is done on an hourly cadence and this row is what every request
 * reads. Without it the trends view would either be slow or be computed again per
 * request, and the two are the same mistake.
 *
 * The series are JSON rather than one row per day because they are always read
 * whole, never queried by day, and the annotations carry a list of Cluster ids
 * that a row-per-day table would then need a second table for.
 *
 * Unique on the Topic because there is one current trend per Topic: the job
 * replaces the row rather than accumulating a history of them, and nothing reads
 * an older one.
 */
export const topicTrends = sqliteTable(
  'topic_trends',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    computedAt: integer('computed_at', { mode: 'timestamp_ms' }).notNull(),
    // The window stored with the row, so the page can say which days it is
    // looking at without asking the clock a question whose answer has moved on.
    observationStart: integer('observation_start', { mode: 'timestamp_ms' }).notNull(),
    observationEnd: integer('observation_end', { mode: 'timestamp_ms' }).notNull(),
    baselineStart: integer('baseline_start', { mode: 'timestamp_ms' }).notNull(),
    baselineEnd: integer('baseline_end', { mode: 'timestamp_ms' }).notNull(),
    volume: text('volume').notNull().default('[]'),
    spikes: text('spikes').notNull().default('[]'),
    entities: text('entities').notNull().default('[]'),
  },
  (t) => ({
    topicUnique: uniqueIndex('topic_trends_topic_unique').on(t.topicId),
  }),
);

export type TopicTrendRow = typeof topicTrends.$inferSelect;
export type NewTopicTrendRow = typeof topicTrends.$inferInsert;

export const feedbackEvents = sqliteTable(
  'feedback_events',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    clusterId: text('cluster_id')
      .notNull()
      .references(() => clusters.id, { onDelete: 'cascade' }),
    feedbackType: text('feedback_type', {
      enum: [
        'thumbs_up',
        'thumbs_down',
        'hide_source',
        'more_like_this',
        'less_like_this',
      ],
    }).notNull(),
    scope: text('scope', { enum: ['this_topic', 'global'] }),
    /**
     * The Source a `hide_source` signal is about, and null for the other four.
     *
     * It has to be on the row rather than inferred from the Cluster, because a
     * Cluster can carry reporting from several Sources and the User asked to stop
     * seeing one outlet — not to stop seeing the story, and not to lose every
     * other outlet's account of it. A row without one names no Source at all,
     * which is why it is nullable and the write path refuses it.
     */
    sourceId: text('source_id').references(() => sources.id, { onDelete: 'cascade' }),
    timestamp: integer('timestamp', { mode: 'timestamp_ms' })
      .notNull()
      .default(sql`(unixepoch() * 1000)`),
  },
  (t) => ({
    userClusterTypeIdx: index('feedback_events_user_cluster_type_idx').on(
      t.userId,
      t.clusterId,
      t.feedbackType,
    ),
    userClusterIdx: index('feedback_events_user_cluster_idx').on(
      t.userId,
      t.clusterId,
    ),
    // Hide-source is read per User and per Source, and the Source is the whole
    // signal: without this, every lookup of what a User has hidden scans every
    // signal they have ever given on every Cluster.
    userSourceIdx: index('feedback_events_user_source_idx').on(t.userId, t.sourceId),
  }),
);

export type FeedbackEventRow = typeof feedbackEvents.$inferSelect;
export type NewFeedbackEventRow = typeof feedbackEvents.$inferInsert;

export const briefPlans = sqliteTable(
  'brief_plans',
  {
    id: text('id').primaryKey(),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    clusterIds: text('cluster_ids').notNull().default(''),
  },
  (t) => ({
    topicUserIdx: uniqueIndex('brief_plans_topic_user_idx').on(
      t.topicId,
      t.userId,
      t.createdAt,
    ),
    userIdx: index('brief_plans_user_idx').on(t.userId),
  }),
);

export const briefSnapshots = sqliteTable(
  'brief_snapshots',
  {
    id: text('id').primaryKey(),
    briefPlanId: text('brief_plan_id')
      .notNull()
      .references(() => briefPlans.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
    html: text('html').notNull(),
    /**
     * The plain-text alternative to `html`, stored rather than derived. A
     * snapshot is what was sent, so both halves of the message are kept: a
     * client that was shown the text half is not served a different brief later
     * because the Clusters moved on.
     */
    text: text('text').notNull().default(''),
    unsubscribeToken: text('unsubscribe_token').notNull(),
    globalUnsubscribeToken: text('global_unsubscribe_token').notNull(),
  },
  (t) => ({
    userTopicIdx: index('brief_snapshots_user_topic_idx').on(
      t.userId,
      t.topicId,
    ),
  }),
);

export const emailDeliveries = sqliteTable(
  'email_deliveries',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    briefSnapshotId: text('brief_snapshot_id')
      .notNull()
      .references(() => briefSnapshots.id, { onDelete: 'cascade' }),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull(),
    // The two tokens in the brief that carries this delivery. Unique because
    // they are looked up by value: a token that resolved to two deliveries would
    // be one that unsubscribes the wrong person half the time.
    unsubscribeToken: text('unsubscribe_token').notNull(),
    globalUnsubscribeToken: text('global_unsubscribe_token').notNull(),
    // What writing this brief cost. Per brief rather than per pass of the daily
    // job, because a brief is also sent by hand from the Topic page, and a counter
    // only the job kept would have nothing to say about those.
    writtenClusters: integer('written_clusters').notNull().default(0),
    generationCalls: integer('generation_calls').notNull().default(0),
    discardedBullets: integer('discarded_bullets').notNull().default(0),
  },
  (t) => ({
    userSnapshotIdx: index('email_deliveries_user_snapshot_idx').on(
      t.userId,
      t.briefSnapshotId,
    ),
    unsubscribeTokenIdx: uniqueIndex('email_deliveries_unsubscribe_token_unique').on(
      t.unsubscribeToken,
    ),
    globalUnsubscribeTokenIdx: uniqueIndex('email_deliveries_global_unsubscribe_token_unique').on(
      t.globalUnsubscribeToken,
    ),
  }),
);

/**
 * A spent unsubscribe token.
 *
 * One row per unsubscribe link that was actually used. The `token` column is
 * unique, and that is the whole single-use property: the constraint is on the
 * database rather than in the service, so a second visit to the same link is
 * refused by the write itself rather than by a check somebody has to remember to
 * run first.
 *
 * `email_delivery_id` is not optional because a token only exists because a
 * brief was sent, so a row without one would be a claim about an email nobody
 * received.
 */
export const unsubscribes = sqliteTable(
  'unsubscribes',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The Topic stopped, or null when the whole User was opted out. */
    topicId: text('topic_id').references(() => topics.id, {
      onDelete: 'cascade',
    }),
    emailDeliveryId: text('email_delivery_id')
      .notNull()
      .references(() => emailDeliveries.id, { onDelete: 'cascade' }),
    scope: text('scope', { enum: ['this_topic', 'global'] }).notNull(),
    token: text('token').notNull(),
    createdAt: integer('created_at', { mode: 'timestamp_ms' }).notNull(),
  },
  (t) => ({
    tokenUnique: uniqueIndex('unsubscribes_token_unique').on(t.token),
    userIdx: index('unsubscribes_user_idx').on(t.userId),
  }),
);

/**
* One Topic of one User, answered for one DeliverySlot.
 *
 * The unique index on (user, topic, scheduled_for) is the whole reason the daily
 * job can run as often as it likes: a DeliverySlot can only be answered once, so a
 * second pass over the same one — whether it is the next tick, a restart, or two
 * processes — cannot send the same period's brief twice.
 */
export const briefRuns = sqliteTable(
  'brief_runs',
  {
    id: text('id').primaryKey(),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    topicId: text('topic_id')
      .notNull()
      .references(() => topics.id, { onDelete: 'cascade' }),
    /** The DeliverySlot this brief answers, as a UTC instant. */
    scheduledFor: integer('scheduled_for', { mode: 'timestamp_ms' }).notNull(),
    sentAt: integer('sent_at', { mode: 'timestamp_ms' }).notNull(),
    briefSnapshotId: text('brief_snapshot_id')
      .notNull()
      .references(() => briefSnapshots.id, { onDelete: 'cascade' }),
  },
  (t) => ({
    userTopicSlotIdx: uniqueIndex('brief_runs_user_topic_slot_idx').on(
      t.userId,
      t.topicId,
      t.scheduledFor,
    ),
    userIdx: index('brief_runs_user_idx').on(t.userId),
  }),
);

/**
 * One pass of the daily job. The observable half of the job: a pass that sends
 * nothing and reports nothing is indistinguishable from a job that is not
 * running, and this is what tells the two apart.
 */
export const briefJobRuns = sqliteTable(
  'brief_job_runs',
  {
    id: text('id').primaryKey(),
    startedAt: integer('started_at', { mode: 'timestamp_ms' }).notNull(),
    finishedAt: integer('finished_at', { mode: 'timestamp_ms' }).notNull(),
    sentCount: integer('sent_count').notNull(),
    failureCount: integer('failure_count').notNull(),
    // What writing the pass's briefs cost. Three counters rather than one flag,
    // because "the written path did not run" and "it ran and produced nothing"
    // and "it ran and was billed for it" are three different problems and an
    // operator cannot tell them apart from a sent count.
    writtenClusters: integer('written_clusters').notNull().default(0),
    generationCalls: integer('generation_calls').notNull().default(0),
    discardedBullets: integer('discarded_bullets').notNull().default(0),
  },
  (t) => ({
    startedAtIdx: index('brief_job_runs_started_at_idx').on(t.startedAt),
  }),
);

export type BriefPlanRow = typeof briefPlans.$inferSelect;
export type NewBriefPlanRow = typeof briefPlans.$inferInsert;
export type BriefSnapshotRow = typeof briefSnapshots.$inferSelect;
export type NewBriefSnapshotRow = typeof briefSnapshots.$inferInsert;
export type EmailDeliveryRow = typeof emailDeliveries.$inferSelect;
export type NewEmailDeliveryRow = typeof emailDeliveries.$inferInsert;
export type UnsubscribeRow = typeof unsubscribes.$inferSelect;
export type NewUnsubscribeRow = typeof unsubscribes.$inferInsert;
export type BriefRunRow = typeof briefRuns.$inferSelect;
export type NewBriefRunRow = typeof briefRuns.$inferInsert;
export type BriefJobRunRow = typeof briefJobRuns.$inferSelect;
export type NewBriefJobRunRow = typeof briefJobRuns.$inferInsert;

