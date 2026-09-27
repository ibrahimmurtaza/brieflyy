import type {
  Cadence,
  Cluster,
  ClusterId,
  Topic,
  TopicCategory,
  TopicId,
  TopicOrigin,
  UserId,
} from '../domain/types.js';

export interface TopicFixture {
  readonly id: string;
  readonly userId: string;
  readonly title?: string;
  readonly category?: TopicCategory;
  readonly origin?: TopicOrigin;
  readonly sourceIds?: readonly string[];
  readonly cadence?: Cadence;
  readonly createdAt?: Date;
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
    createdAt: input.createdAt ?? new Date('2026-09-01T00:00:00Z'),
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
