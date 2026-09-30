import { DEFAULT_CLUSTER_WINDOW_DAYS } from '../domain/cluster-window.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import type {
  Account,
  Article,
  ArticleId,
  Cadence,
  Cluster,
  ClusterId,
  DeliverySettings,
  OnboardingState,
  SourceId,
  StoryId,
  Tier,
  Topic,
  TopicCategory,
  TopicId,
  TopicOrigin,
  User,
  UserId,
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
  readonly title?: string;
  readonly category?: TopicCategory;
  readonly origin?: TopicOrigin;
  readonly sourceIds?: readonly string[];
  readonly cadence?: Cadence;
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
    slug: input.id,
    title: input.title ?? `Topic ${input.id}`,
    blurb: '',
    category: input.category ?? ('news' as TopicCategory),
    origin: input.origin ?? { kind: 'freeform' },
    sourceIds: input.sourceIds ?? [],
    cadence: input.cadence ?? 'daily',
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
  readonly body?: string;
  readonly url?: string;
  readonly title?: string;
  readonly storyId?: string;
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
    sourceId: 'src-a' as SourceId,
    externalId: input.id,
    url: input.url ?? `https://example.com/${input.id}`,
    title: input.title ?? 'A headline',
    body: input.body ?? '',
    publishedAt: new Date('2026-09-02T10:00:00Z'),
    ingestedAt: new Date('2026-09-02T10:00:00Z'),
    entities: [],
    signature: EMPTY_SIGNATURE,
    storyId: (input.storyId ?? 'story-1') as StoryId,
  };
}

