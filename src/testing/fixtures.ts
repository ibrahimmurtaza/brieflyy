import { DEFAULT_CLUSTER_WINDOW_DAYS } from '../domain/cluster-window.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import { NO_BACKOFF } from '../domain/types.js';
import type {
  Account,
  Article,
  ArticleId,
  BriefPlan,
  BriefSnapshot,
  Cadence,
  Cluster,
  ClusterId,
  DeliveryOutcome,
  DeliverySettings,
  EmailDelivery,
  Entity,
  EntityId,
  FeedbackEvent,
  FeedbackScope,
  FeedbackType,
  OnboardingState,
  Source,
  SourceId,
  Story,
  StoryId,
  Tier,
  Topic,
  TopicCategory,
  TopicId,
  TopicOrigin,
  User,
  UserId,
  Weekday,
} from '../domain/types.js';

export interface UserFixture {
  readonly id: string;
  readonly createdAt?: Date;
  readonly onboardingState?: OnboardingState;
  readonly tier?: Tier;
  readonly unsubscribedAt?: Date | null;
}

/**
 * A User on the free tier with sensible defaults. Tests only state the fields
 * they care about, so a new required field on User does not break every helper.
 */
export function makeUser(input: UserFixture): User {
  return {
    id: input.id as UserId,
    createdAt: input.createdAt ?? new Date('2026-01-01T00:00:00Z'),
    onboardingState: input.onboardingState ?? ('not_started' as OnboardingState),
    tier: input.tier ?? ('free' as Tier),
    unsubscribedAt: input.unsubscribedAt ?? null,
  };
}

export interface TopicFixture {
  readonly id: string;
  readonly userId: string;
  /** Defaults to the id, which is what every fixture that does not care wants. */
  readonly slug?: string;
  readonly title?: string;
  readonly category?: TopicCategory;
  readonly origin?: TopicOrigin;
  readonly sourceIds?: readonly string[];
  readonly cadence?: Cadence;
  readonly cadenceDay?: Weekday | null;
  readonly clusterWindowDays?: number;
  readonly createdAt?: Date;
  readonly removedAt?: Date | null;
  readonly unsubscribedAt?: Date | null;
}

/**
 * A free-form Topic with sensible defaults. Tests only state the fields they
 * care about, so a new required field on Topic does not break every helper.
 */
export function makeTopic(input: TopicFixture): Topic {
  return {
    id: input.id as TopicId,
    userId: input.userId as UserId,
    slug: input.slug ?? input.id,
    title: input.title ?? `Topic ${input.id}`,
    blurb: '',
    category: input.category ?? ('news' as TopicCategory),
    origin: input.origin ?? { kind: 'freeform' },
    sourceIds: input.sourceIds ?? [],
    cadence: input.cadence ?? 'daily',
    cadenceDay: input.cadenceDay ?? null,
    clusterWindowDays: input.clusterWindowDays ?? DEFAULT_CLUSTER_WINDOW_DAYS,
    createdAt: input.createdAt ?? new Date('2026-09-01T00:00:00Z'),
    removedAt: input.removedAt ?? null,
    unsubscribedAt: input.unsubscribedAt ?? null,
  };
}

export interface AccountFixture {
  readonly id: string;
  readonly userId: string;
  readonly email?: string;
  readonly emailVerifiedAt?: Date | null;
}

/**
 * A verified Account for a User. A brief is addressed to an Account, so any test
 * that needs a brief sent has to have one of these rather than just a User.
 */
export function makeAccount(input: AccountFixture): Account {
  return {
    id: input.id,
    userId: input.userId as UserId,
    email: input.email ?? `${input.id}@example.com`,
    emailVerifiedAt: input.emailVerifiedAt ?? new Date('2026-01-01T00:00:00Z'),
    createdAt: new Date('2026-01-01T00:00:00Z'),
  };
}

export interface DeliverySettingsFixture {
  readonly userId: string;
  readonly hour?: number;
  readonly minute?: number;
  readonly timezone?: string;
  /**
   * When the User recorded this DeliveryTime. It decides which DeliverySlots the User can
   * be owed, so a test about a DeliverySlot that passed before they asked for one has to
   * set it.
   */
  readonly updatedAt?: Date;
  readonly welcomeSentAt?: Date | null;
}

/** Eight in the morning UTC, recorded long ago, unless a test says otherwise. */
export function makeDeliverySettings(input: DeliverySettingsFixture): DeliverySettings {
  return {
    userId: input.userId as UserId,
    hour: input.hour ?? 8,
    minute: input.minute ?? 0,
    timezone: input.timezone ?? 'UTC',
    welcomeSentAt: input.welcomeSentAt ?? new Date('2026-01-01T00:00:00Z'),
    updatedAt: input.updatedAt ?? new Date('2026-01-01T00:00:00Z'),
  };
}

export interface ClusterFixture {
  readonly id: string;
  readonly topicId: string;
  readonly title?: string;
  readonly summary?: string;
  readonly bulletPoints?: readonly string[];
  readonly articleCount?: number;
  readonly velocity?: number;
  readonly sourceIds?: readonly string[];
  readonly state?: Cluster['state'];
  readonly createdAt?: Date;
  readonly lastSeenAt?: Date;
}

/** An Active Cluster with sensible defaults. */
export function makeCluster(input: ClusterFixture): Cluster {
  return {
    id: input.id as ClusterId,
    topicId: input.topicId,
    title: input.title ?? `Cluster ${input.id}`,
    summary: input.summary ?? `Summary ${input.id}`,
    bulletPoints: input.bulletPoints ?? [],
    createdAt: input.createdAt ?? new Date('2026-09-02T12:00:00Z'),
    lastSeenAt: input.lastSeenAt ?? new Date('2026-09-02T12:00:00Z'),
    articleCount: input.articleCount ?? 1,
    velocity: input.velocity ?? 1,
    sourceIds: input.sourceIds ?? [],
    state: input.state ?? 'active',
  };
}

export interface ArticleFixture {
  readonly id: string;
  readonly sourceId?: string;
  readonly body?: string;
  readonly url?: string;
  readonly title?: string;
  readonly publishedAt?: Date;
  readonly ingestedAt?: Date;
  readonly storyId?: string | null;
}

/**
 * An Article from one Source, with the fields a test cares about left to it.
 *
 * An Article is what a Cluster's bullets are quoted from, so a test that renders
 * a brief needs one whether or not it is about Articles — hence a fixture
 * rather than a hand-built object per test.
 */
export function makeArticle(input: ArticleFixture): Article {
  return {
    id: input.id as ArticleId,
    sourceId: (input.sourceId ?? 'src-a') as SourceId,
    externalId: input.id,
    url: input.url ?? `https://example.com/${input.id}`,
    title: input.title ?? 'A headline',
    body: input.body ?? '',
    publishedAt: input.publishedAt ?? new Date('2026-09-02T10:00:00Z'),
    ingestedAt: input.ingestedAt ?? new Date('2026-09-02T10:00:00Z'),
    entities: [],
    signature: EMPTY_SIGNATURE,
    storyId: (input.storyId === undefined ? 'story-1' : input.storyId) as StoryId | null,
  };
}

export interface SourceFixture {
  readonly id: string;
  readonly name?: string;
  readonly slug?: string;
}

/** A registry Source, with the fields a test cares about left to it. */
export function makeSource(input: SourceFixture): Source {
  return {
    id: input.id as SourceId,
    slug: input.slug ?? input.id,
    name: input.name ?? `Source ${input.id}`,
    homepageUrl: `https://example.com/${input.slug ?? input.id}`,
    feedUrl: null,
    lastPolledAt: null,
    lastSuccessAt: null,
    backoff: NO_BACKOFF,
  };
}

export interface EntityFixture {
  readonly id: string;
  readonly canonicalName?: string;
  readonly kind?: Entity['kind'];
}

/** An Entity the corpus has already keyed. */
export function makeEntity(input: EntityFixture): Entity {
  return {
    id: input.id as EntityId,
    canonicalName: input.canonicalName ?? `Entity ${input.id}`,
    kind: input.kind ?? 'org',
  };
}

export interface StoryFixture {
  readonly id: string;
  readonly sourceIds?: readonly string[];
  readonly firstSeenAt?: Date;
  readonly lastSeenAt?: Date;
  readonly firstPublishedAt?: Date;
  readonly lastPublishedAt?: Date;
  readonly articleCount?: number;
}

/** A Story with a published range, which is the part the dedup window needs. */
export function makeStory(input: StoryFixture): Story {
  const firstSeenAt = input.firstSeenAt ?? new Date('2026-09-02T09:00:00Z');
  const lastSeenAt = input.lastSeenAt ?? firstSeenAt;
  return {
    id: input.id as StoryId,
    sourceIds: (input.sourceIds ?? ['src-a']) as readonly SourceId[],
    signature: EMPTY_SIGNATURE,
    firstSeenAt,
    lastSeenAt,
    published: {
      first: input.firstPublishedAt ?? firstSeenAt,
      last: input.lastPublishedAt ?? lastSeenAt,
    },
    articleCount: input.articleCount ?? 1,
    // A Story is Active as formed: it comes out of reporting happening now, and only
    // the pass that decides which Clusters are Active may say otherwise — so there
    // is no fixture option for the other state, since nothing writes one.
    state: 'active',
  };
}

export interface BriefPlanFixture {
  readonly id: string;
  readonly topicId: string;
  readonly userId: string;
  readonly clusterIds?: readonly string[];
  readonly createdAt?: Date;
}

/** A BriefPlan over one Topic's Clusters. The parent every snapshot needs. */
export function makeBriefPlan(input: BriefPlanFixture): BriefPlan {
  return {
    id: input.id,
    topicId: input.topicId as TopicId,
    userId: input.userId as UserId,
    createdAt: input.createdAt ?? new Date('2026-09-02T08:00:00Z'),
    clusterIds: (input.clusterIds ?? []) as readonly ClusterId[],
  };
}

export interface BriefSnapshotFixture {
  readonly id: string;
  readonly briefPlanId: string;
  readonly userId: string;
  readonly topicId: string;
  readonly createdAt?: Date;
  readonly html?: string;
  readonly text?: string;
}

/**
 * A BriefSnapshot: the brief as it was sent, in both renderings.
 *
 * Both halves are fixtures rather than one derived from the other because the
 * point of storing both is that they can disagree — that is what "the brief you
 * were sent" means.
 */
export function makeBriefSnapshot(input: BriefSnapshotFixture): BriefSnapshot {
  return {
    id: input.id,
    briefPlanId: input.briefPlanId,
    userId: input.userId as UserId,
    topicId: input.topicId as TopicId,
    createdAt: input.createdAt ?? new Date('2026-09-02T08:00:00Z'),
    html: input.html ?? '<p>A brief that was sent.</p>',
    text: input.text ?? 'A brief that was sent.',
    unsubscribeToken: `unsub-${input.id}`,
    globalUnsubscribeToken: `global-unsub-${input.id}`,
  };
}

export interface EmailDeliveryFixture {
  readonly id: string;
  readonly userId: string;
  readonly topicId: string;
  readonly briefSnapshotId: string;
  readonly sentAt: Date;
  readonly outcome?: DeliveryOutcome;
}

/**
 * One send attempt, whether or not the transport took the message.
 *
 * A fixture rather than an object per test because a delivery carries two
 * required unsubscribe tokens and a generation report beside its own fields, and
 * because a test about what a User received needs a delivery to have received
 * anything at all.
 */
export function makeEmailDelivery(input: EmailDeliveryFixture): EmailDelivery {
  return {
    id: input.id,
    userId: input.userId as UserId,
    topicId: input.topicId as TopicId,
    briefSnapshotId: input.briefSnapshotId,
    sentAt: input.sentAt,
    outcome: input.outcome ?? 'sent',
    unsubscribeToken: `unsub-${input.id}`,
    globalUnsubscribeToken: `global-unsub-${input.id}`,
    generation: { writtenClusters: 0, calls: 0, discardedBullets: 0 },
  };
}

export interface FeedbackEventFixture {
  readonly id: string;
  readonly userId: string;
  readonly clusterId: string;
  readonly feedbackType?: FeedbackType;
  readonly scope?: FeedbackScope | null;
  readonly sourceId?: string | null;
  readonly timestamp?: Date;
}

/** One signal a User gave on a Cluster. */
export function makeFeedbackEvent(input: FeedbackEventFixture): FeedbackEvent {
  return {
    id: input.id,
    userId: input.userId as UserId,
    clusterId: input.clusterId as ClusterId,
    feedbackType: input.feedbackType ?? 'thumbs_up',
    scope: input.scope ?? null,
    sourceId: (input.sourceId ?? null) as SourceId | null,
    timestamp: input.timestamp ?? new Date('2026-09-02T11:00:00Z'),
  };
}

