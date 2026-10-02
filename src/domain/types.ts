import type { StorySignature } from './story-signature.js';
import type { DeliverySlot } from './delivery-slot.js';

export const TOPIC_CATEGORIES = [
  'news',
  'technology',
  'science',
  'business',
  'policy',
  'unspecified',
] as const;
export type TopicCategory = (typeof TOPIC_CATEGORIES)[number];

export type OnboardingState =
  | 'not_started'
  | 'topics_picked'
  | 'delivery_set'
  | 'completed';

export type UserId = string;
export type AccountId = string;
export type SessionId = string;
export type MagicLinkId = string;

/**
 * What a User pays for. `FreeTier` and `PaidTier` in the glossary; the
 * entitlements each carries live in `domain/tier.ts`.
 */
export const TIERS = ['free', 'paid'] as const;
export type Tier = (typeof TIERS)[number];

export interface User {
  readonly id: UserId;
  readonly createdAt: Date;
  readonly onboardingState: OnboardingState;
  readonly tier: Tier;
  /**
   * When this User asked to stop receiving every brief, and null while they want
   * them. A User-level opt-out rather than a per-Topic one: "stop emailing me"
   * is a decision about the mailbox, and the daily job honours it by skipping the
   * User entirely. Distinct from a Topic's own `unsubscribedAt`, which is a
   * decision about one subject and leaves the rest of the mailbox alone.
   */
  readonly unsubscribedAt: Date | null;
}

export interface Account {
  readonly id: AccountId;
  readonly userId: UserId;
  readonly email: string;
  readonly emailVerifiedAt: Date | null;
  readonly createdAt: Date;
}

export interface Session {
  readonly id: SessionId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly revokedAt: Date | null;
}

/**
 * A sign-in link sent to an address. `accountId` is null until the link is
 * verified, because the account does not exist until then.
 */
export interface MagicLink {
  readonly id: MagicLinkId;
  readonly accountId: AccountId | null;
  readonly email: string;
  readonly tokenHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export type OAuthProvider = 'google';

export interface OAuthState {
  readonly id: string;
  readonly stateHash: string;
  readonly codeVerifierHash: string;
  readonly createdAt: Date;
  readonly expiresAt: Date;
  readonly consumedAt: Date | null;
}

export interface OAuthAccount {
  readonly id: string;
  readonly accountId: AccountId;
  readonly provider: OAuthProvider;
  readonly providerSubject: string;
  readonly createdAt: Date;
}

export type SourceId = string;
export type TopicTemplateId = string;
export type TopicId = string;
export type ArticleId = string;
export type StoryId = string;
export type EntityId = string;

export interface Source {
  readonly id: SourceId;
  readonly slug: string;
  readonly name: string;
  readonly homepageUrl: string;
  readonly feedUrl: string | null;
  readonly lastPolledAt: Date | null;
  readonly lastSuccessAt: Date | null;
}

export interface TopicTemplate {
  readonly id: TopicTemplateId;
  readonly slug: string;
  readonly title: string;
  readonly blurb: string;
  readonly category: Exclude<TopicCategory, 'unspecified'>;
  readonly defaultSourceIds: readonly SourceId[];
}

/**
 * A Directory entry together with what the corpus has seen of the Entities its
 * Sources write about inside the measured window.
 *
 * `TopicTemplate` says which Sources an entry follows, which is not enough to say
 * what it covers: two entries can follow entirely different outlets and still be
 * about the same handful of companies and people. That overlap is half of what a
 * Recommendation is derived from.
 */
export interface DiscoverTemplate extends TopicTemplate {
  readonly entityIds: readonly EntityId[];
}

/**
 * One of a User's own Topics, as the DiscoverTab reads it.
 *
 * `clonedFromTemplateId` is the answer to "which Directory entry is this the same
 * as". The Topic's own `id` is not: it is a randomly generated identifier
 * belonging to a different kind of thing, and matching a Directory entry against
 * it compares two unrelated names — a collision that the seed's `id === slug`
 * makes common enough to look like a working rule.
 */
export interface UserTopicSignal {
  readonly topicId: TopicId;
  readonly title: string;
  readonly clonedFromTemplateId: TopicTemplateId | null;
  readonly sourceIds: readonly SourceId[];
  readonly entityIds: readonly EntityId[];
}

/**
 * How many Articles one Source published inside the measured window.
 *
 * A measurement, not a ranking. What is trending is computed from these; a count
 * handed in already carrying an opinion about which entries are popular is how a
 * "trending" list ends up being whatever the caller decided.
 */
export interface SourceVolume {
  readonly sourceId: SourceId;
  readonly articleCount: number;
}

export type TopicOrigin =
  | { readonly kind: 'template'; readonly templateId: TopicTemplateId }
  | { readonly kind: 'freeform' };

export interface Topic {
  readonly id: TopicId;
  readonly userId: UserId;
  readonly slug: string;
  readonly title: string;
  readonly blurb: string;
  readonly category: TopicCategory;
  readonly origin: TopicOrigin;
  readonly sourceIds: readonly SourceId[];
  readonly cadence: Cadence;
  /**
   * How far back this Topic looks when it forms Clusters, in days. The glossary
   * makes the 7d window a per-Topic tunable; `DEFAULT_CLUSTER_WINDOW_DAYS` is
   * what a Topic starts on.
   */
  readonly clusterWindowDays: number;
  readonly createdAt: Date;
  readonly removedAt: Date | null;
  /**
   * When this User stopped being sent this Topic, and null while they want it.
   * Separate from `removedAt`, because the two answer different questions: a
   * removed Topic is gone from the application, while an unsubscribed one is
   * still there, still on `/topics`, and starts sending again the moment the
   * User resubscribes.
   */
  readonly unsubscribedAt: Date | null;
}

export interface DeliveryTime {
  readonly hour: number;
  readonly minute: number;
  readonly timezone: string;
}

export interface DeliverySettings {
  readonly userId: UserId;
  readonly hour: number;
  readonly minute: number;
  readonly timezone: string;
  readonly welcomeSentAt: Date | null;
  readonly updatedAt: Date;
}

export type EntityKind = 'person' | 'org' | 'place' | 'product' | 'concept';

export interface Entity {
  readonly id: EntityId;
  readonly canonicalName: string;
  readonly kind: EntityKind;
}

export interface Article {
  readonly id: ArticleId;
  readonly sourceId: SourceId;
  readonly externalId: string;
  readonly url: string;
  readonly title: string;
  readonly body: string;
  readonly publishedAt: Date;
  readonly ingestedAt: Date;
  readonly entities: readonly Entity[];
  /** The Article's text-derived identity, as stored and read back. */
  readonly signature: StorySignature;
  readonly storyId: StoryId | null;
}

export type ClusterId = string;

export interface Cluster {
  readonly id: ClusterId;
  readonly topicId: string;
  readonly title: string;
  readonly summary: string;
  readonly bulletPoints: readonly string[];
  readonly createdAt: Date;
  readonly lastSeenAt: Date;
  readonly articleCount: number;
  readonly velocity: number;
  readonly sourceIds: readonly string[];
  readonly state: 'active' | 'archive';
}

/**
 * When a Story's Articles were published, oldest and newest.
 *
 * The dedup window is a fact about when the reporting happened, so it is measured
 * against this rather than against when a poll brought the Articles in. It is
 * one value rather than two fields because a Story whose range could be set
 * inconsistently — newest before oldest, or one end left behind when a copy
 * arrived — is a Story whose window is quietly wrong.
 */
export interface PublishedRange {
  readonly first: Date;
  readonly last: Date;
}

export interface Story {
  readonly id: StoryId;
  /**
   * Every Source this Story has Articles from.
   *
   * One event however many outlets reported it, so a list rather than the one
   * Source it was first seen in — and read from the Articles themselves rather
   * than from a column on the Story, which would name one of them and leave the
   * rest to be inferred.
   */
  readonly sourceIds: readonly SourceId[];
  /** The signature this Story was formed from, fixed when it was created. */
  readonly signature: StorySignature;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
  readonly published: PublishedRange;
  readonly articleCount: number;
}

export const FEEDBACK_TYPES = [
  'thumbs_up',
  'thumbs_down',
  'hide_source',
  'more_like_this',
  'less_like_this',
] as const;
export type FeedbackType = (typeof FEEDBACK_TYPES)[number];

export type FeedbackScope = 'this_topic' | 'global';

export type Cadence = 'daily' | 'weekly' | 'never';

export interface BriefPlan {
  readonly id: string;
  readonly topicId: TopicId;
  readonly userId: UserId;
  readonly createdAt: Date;
  readonly clusterIds: readonly ClusterId[];
}

export interface BriefSnapshot {
  readonly id: string;
  readonly briefPlanId: string;
  readonly userId: UserId;
  readonly topicId: TopicId;
  readonly createdAt: Date;
  /** The brief as it was sent to an email client, styled for the wire. */
  readonly html: string;
  /**
   * The same brief as plain text, stored rather than derived from `html`. A
   * snapshot is what was sent, and the two halves of a message are two
   * different renderings a reader can have been shown.
   */
  readonly text: string;
  readonly unsubscribeToken: string;
  readonly globalUnsubscribeToken: string;
}

export interface EmailDelivery {
  readonly id: string;
  readonly userId: UserId;
  readonly briefSnapshotId: string;
  readonly topicId: TopicId;
  readonly sentAt: Date;
  readonly unsubscribeToken: string;
  readonly globalUnsubscribeToken: string;
  /**
   * What writing this brief cost.
   *
   * Held here rather than only on a pass of the daily job, because a brief is
   * also sent by hand from the Topic page and a counter only the job kept would
   * have nothing to say about those. It is also the only place the number belongs:
   * not on the BriefSnapshot, which is a document a User reads and which is
   * served forever, and not in a log, because nothing reads a log.
   */
  readonly generation: BriefGeneration;
}

export type UnsubscribeScope = 'this_topic' | 'global';

/**
 * One unsubscribe link, spent.
 *
 * Written when a token in a sent brief is used, and never edited afterwards: the
 * `token` column is unique, so this row *is* the single-use property rather than
 * a record of somebody checking a flag somewhere. It names the EmailDelivery the
 * link arrived in, which is what makes "this User unsubscribed from this Topic on
 * this day" answerable long after the token has expired.
 *
 * `topicId` is null for a `global` unsubscribe on purpose. "Stop emailing me" is
 * not a statement about the Topic the brief happened to be about, and a row that
 * carried the id would read as one.
 */
export interface Unsubscribe {
  readonly id: string;
  readonly userId: UserId;
  readonly topicId: TopicId | null;
  readonly scope: UnsubscribeScope;
  readonly emailDeliveryId: string;
  readonly token: string;
  readonly createdAt: Date;
}

/**
 * One Topic of one User, answered for one DeliverySlot.
 *
 * Written when a brief has actually gone out, so it is the record of the period
 * being dealt with rather than the intention to deal with it: a User the job
 * failed to send to has no BriefRun, so the DeliverySlot is still owed and the next
 * pass tries again. Its existence is also what stops two passes answering the same
 * DeliverySlot twice.
 */
export interface BriefRun {
  readonly id: string;
  readonly userId: UserId;
  readonly topicId: TopicId;
  /** The DeliverySlot this brief answers. */
  readonly scheduledFor: DeliverySlot;
  readonly sentAt: Date;
  /** The BriefSnapshot that was sent, so a run points at the brief it produced. */
  readonly briefSnapshotId: string;
}

/**
 * What producing one brief cost, and what it got for it.
 *
 * The written path degrades quietly on purpose — no credential, a failed call, a
 * spent budget, a citation that did not hold — so without this a brief that is
 * entirely quoted looks exactly like one that is entirely written, and nobody
 * finds out the feature has stopped working until a User says so. Each number is
 * a primitive nothing else can be derived from, and together they tell the whole
 * story: nothing asked and nothing written is the path switched off, asked and
 * nothing written is the path broken, asked and all written is healthy.
 */
export interface BriefGeneration {
  /** Clusters that got a written one-liner and bullets. */
  readonly writtenClusters: number;
  /** Requests made against the provider. Zero when none is configured. */
  readonly calls: number;
  /**
   * Written bullets thrown away for failing the citation contract. Counted by the
   * client, because the client is the only thing that ever sees them.
   */
  readonly discardedBullets: number;
}

/**
 * Nothing asked, nothing written, nothing dropped.
 *
 * The answer for a brief whose deployment has no summary client, and the default
 * for a delivery recorded without a report. A pass of the daily job builds a
 * mutable one of these and adds to it, which is the one thing this is not for.
 */
export const NO_GENERATION: BriefGeneration = {
  writtenClusters: 0,
  calls: 0,
  discardedBullets: 0,
};

/**
 * One pass of the daily job, and the whole of what is observable about it.
 *
 * A pass that finds nobody due reports zero of each rather than nothing at all,
 * because a job that has run and sent nothing is a different thing from a job
 * that is not running, and only the first is worth seeing. The written half is
 * counted here for the same reason: a pass that sent briefs and wrote none of
 * them has told an operator nothing until it says so itself.
 */
export interface BriefJobRun {
  readonly id: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  /** Briefs sent this pass. */
  readonly sentCount: number;
  /** Briefs owed and not sent this pass, however many Users were unaffected. */
  readonly failureCount: number;
  /** What every brief this pass sent cost to write, added up. */
  readonly generation: BriefGeneration;
}

export interface FeedbackEvent {
  readonly id: string;
  readonly userId: UserId;
  readonly clusterId: ClusterId;
  readonly feedbackType: FeedbackType;
  readonly scope: FeedbackScope | null;
  /**
   * The Source a `hide_source` signal is about, and null for the other four.
   *
   * The Cluster is where the User pressed the button, not what they said about:
   * a Cluster carries reporting from several Sources and hiding one of them is a
   * statement about that outlet. A row without a Source here is a hide that names
   * nothing, which is why the write path refuses to create one.
   */
  readonly sourceId: SourceId | null;
  readonly timestamp: Date;
}

/**
 * The 7d observation window and the 30d baseline it is compared against.
 *
 * Both bounds are half-open and they meet: the baseline ends where the
 * observation starts, so an Article published at exactly `observationStart` is
 * counted once, as an observation, and never as a baseline Article as well.
 */
export interface TrendWindow {
  readonly observationStart: Date;
  readonly observationEnd: Date;
  readonly baselineStart: Date;
  readonly baselineEnd: Date;
}

/**
 * One UTC day of a Topic's mention volume.
 *
 * Articles and Stories are both counted, and they are counted separately because
 * they answer different questions: Articles is how much was published, Stories is
 * how much actually happened. Three outlets carrying one story is three Articles
 * and one Story, and a trend that only showed the first number would call the
 * loudest week the most eventful one.
 */
export interface TrendVolumePoint {
  /** The UTC day this point covers, as `YYYY-MM-DD`. */
  readonly date: string;
  readonly articles: number;
  /** Distinct Stories among those Articles, each counted once. */
  readonly stories: number;
}

/**
 * A day whose mention volume stands out, and the Clusters that arrived on it.
 *
 * A trend without a cause is a number with nothing to act on, so the Clusters are
 * carried with it rather than looked up afterwards: the arrival of a Cluster is
 * what makes a day's volume jump, and each one is a link to the thing that
 * happened.
 */
export interface TrendSpike {
  readonly date: string;
  /** The day's Mention volume — Articles published — so a label can name the jump. */
  readonly articles: number;
  readonly clusterIds: readonly ClusterId[];
}

/** One Entity's mentions inside a Topic, day by day, over the whole measured span. */
export interface EntityMentions {
  readonly entityId: EntityId;
  readonly canonicalName: string;
  /** Articles in the observation window that named it. */
  readonly observationMentions: number;
  /** Articles in the baseline that named it. */
  readonly baselineMentions: number;
  readonly daily: readonly { date: string; mentions: number }[];
}

/**
 * What the repository measured for one Topic, before anything is decided about it.
 *
 * Everything here is a count taken from stored Articles and Clusters. The lift, the
 * ranking and the tier's cutoff are all computed from this by
 * `domain/trends.ts`, so the measurement is the only part that has to touch the
 * database — which is what makes the hourly cadence possible.
 */
export interface TopicTrendMeasurement {
  /** One point per day from the start of the baseline to the end of the observation. */
  readonly volume: readonly TrendVolumePoint[];
  readonly entities: readonly EntityMentions[];
  /** Cluster ids by the day the Cluster arrived, over the same span. */
  readonly clustersByDay: ReadonlyMap<string, readonly ClusterId[]>;
}

/**
 * An Entity whose mention rate has risen against the baseline.
 *
 * Carries its own daily series as well as the ratio, because a ratio with nothing
 * drawn under it is a claim a User cannot check: the sparkline is the evidence for
 * the number beside it.
 *
 * The three figures that come out of the 7d/30d comparison are nullable, and null
 * is the honest answer for a User whose tier cannot see either window in full. A
 * free User is shown three days of series and nothing else: shipping them a lift
 * and a baseline count beside it would describe the month the paywall is holding
 * back, in three numbers instead of thirty-seven. Null rather than zero because
 * "not shown to you" and "nothing happened" are different facts.
 */
export interface EmergingEntity {
  readonly entityId: EntityId;
  readonly canonicalName: string;
  /**
   * Observation rate over baseline rate, capped at `MAX_LIFT` so a zero baseline
   * round-trips through storage. Read `baselineMentions` rather than the number:
   * an Entity that was never mentioned before has no meaningful multiple.
   */
  readonly lift: number | null;
  /** Articles in the observation window that named it, or null when not shown. */
  readonly observationMentions: number | null;
  /** Articles in the baseline that named it, or null when not shown. */
  readonly baselineMentions: number | null;
  /** The daily series, cut to whatever this User's tier allows. */
  readonly daily: readonly { date: string; mentions: number }[];
}

/**
 * One Topic's trends, as materialised by the hourly job and read back by every
 * request that shows them.
 *
 * The window travels with it so the page can say which days it is looking at
 * without asking the clock a question whose answer has since moved on.
 */
export interface TopicTrend {
  readonly topicId: TopicId;
  readonly computedAt: Date;
  readonly window: TrendWindow;
  readonly volumeOverTime: readonly TrendVolumePoint[];
  readonly spikes: readonly TrendSpike[];
  /** Sorted by lift, loudest first. */
  readonly entities: readonly EmergingEntity[];
}

/** An Entity that is rising, attributed to the one Topic it rose in most. */
export interface RollupEntity {
  readonly entityId: EntityId;
  readonly canonicalName: string;
  /** Null when the tier cannot see the baseline it was measured against. */
  readonly lift: number | null;
  /**
   * What the baseline said about it, or null for the same reason. Carried so the
   * rollup can say "new in this window" the way the per-Topic view does, rather
   * than printing a capped multiple as though it were a measured ratio.
   */
  readonly baselineMentions: number | null;
  readonly topicId: TopicId;
  readonly topicSlug: string;
  readonly topicTitle: string;
}

/**
 * Every Topic a User holds, added together.
 *
 * Built from the stored per-Topic trends rather than from a fresh measurement, so
 * the dashboard costs a read and not another pass over every Article.
 */
export interface TrendsRollup {
  readonly window: TrendWindow;
  readonly volumeOverTime: readonly TrendVolumePoint[];
  /** Sorted by lift, loudest first, one entry per Entity however many Topics it rose in. */
  readonly entities: readonly RollupEntity[];
}

