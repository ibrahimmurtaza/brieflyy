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

export interface User {
  readonly id: UserId;
  readonly createdAt: Date;
  readonly onboardingState: OnboardingState;
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

export interface MagicLink {
  readonly id: MagicLinkId;
  readonly accountId: AccountId;
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
  readonly createdAt: Date;
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
  readonly keyPhrases: readonly string[];
  readonly fingerprint: string;
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

export interface Story {
  readonly id: StoryId;
  readonly sourceId: SourceId;
  readonly fingerprint: string;
  readonly firstSeenAt: Date;
  readonly lastSeenAt: Date;
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
  readonly html: string;
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
}

export interface FeedbackEvent {
  readonly id: string;
  readonly userId: UserId;
  readonly clusterId: ClusterId;
  readonly feedbackType: FeedbackType;
  readonly scope: FeedbackScope | null;
  readonly timestamp: Date;
}