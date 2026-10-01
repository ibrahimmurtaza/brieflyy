import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import {
  feedbackTypeWantsScope,
  hiddenSourceIdsIn,
  hiddenSourcesById,
  isFeedbackScope,
  isFeedbackType,
  signalsByCluster,
  type ClusterSignals,
  type HiddenSource,
  type WeightByArticleId,
} from '../domain/feedback.js';
import type {
  Article,
  ArticleId,
  ClusterId,
  FeedbackEvent,
  FeedbackScope,
  FeedbackType,
  SourceId,
  TopicId,
  UserId,
} from '../domain/types.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { FeedbackRepo } from '../repos/feedback-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';

export interface FeedbackServiceDeps {
  readonly feedbackRepo: FeedbackRepo;
  readonly clusterRepo: ClusterRepo;
  readonly articleRepo: ArticleRepo;
  readonly topicRepo: TopicRepo;
  readonly clock: Clock;
  /**
   * Where each event's id comes from.
   *
   * A random id rather than one built out of the User, the Cluster, the signal and
   * the clock, because that recipe collides: two signals of the same kind on the
   * same Cluster within one millisecond produce the same string, and the second
   * write fails on the primary key rather than being recorded. Idempotence narrows
   * the window but does not close it — a User hiding two Sources on one Cluster is
   * two rows with the same recipe.
   */
  readonly random: RandomSource;
}

/** What came of a request to record a signal. */
export type FeedbackOutcome =
  | { readonly status: 'recorded' }
  /** The signal was already the one in force, so nothing was written. */
  | { readonly status: 'unchanged' }
  /** Not one of the five signals in the glossary. */
  | { readonly status: 'invalid_type' }
  /** The scope was not one of the two the glossary names. */
  | { readonly status: 'invalid_scope' }
  /** The Cluster is not on the Topic the request was made from. */
  | { readonly status: 'unknown_cluster' }
  /** A Hide-source with no Source on it, which is not a signal about anything. */
  | { readonly status: 'missing_source' }
  /** A Hide-source naming a Source this Topic does not follow. */
  | { readonly status: 'unknown_source' };

/**
 * Everything one Topic's page needs to say what a User has already said.
 *
 * One call rather than four, because the page has to hold all of it at once: the
 * button states, the Sources to leave out, and the relevance order. A caller that
 * assembled them separately would have to re-derive the same "latest event wins"
 * rule in each place, and the four answers could disagree.
 */
export interface TopicFeedback {
  /** What each Cluster carries, newest signal winning. */
  readonly signalsByCluster: ReadonlyMap<ClusterId, ClusterSignals>;
  /** Every Source the User has hidden, with the scope each was given with. */
  readonly hiddenSources: ReadonlyMap<SourceId, HiddenSource>;
  /** The Sources hidden from this Topic, being this Topic's and the global ones. */
  readonly hiddenSourceIds: ReadonlySet<SourceId>;
  /**
   * A signal's weight on each Article of the Stories it was given on, which is
   * how it reaches the Clusters built from those same Articles.
   */
  readonly weightByArticleId: ReadonlyMap<ArticleId, number>;
}

/**
 * Feedback, from the form a User pressed to the page that reflects it.
 *
 * The route that writes Feedback goes through this service rather than the
 * repository, which is what makes the write and the read agree: the same
 * latest-wins rule decides what the button shows lit and what the brief ranks by,
 * so a signal cannot be stored and then read back as something the User did not
 * say.
 */
export class FeedbackService {
  constructor(private readonly deps: FeedbackServiceDeps) {}

  /**
   * Record one signal about one Cluster.
   *
   * A signal identical to the one already in force writes nothing, so a User who
   * presses the same button twice gets one row rather than a pile of identical
   * ones that each have to be read past to find the current answer. A signal that
   * *changes* writes a new event and leaves the old one in place, because ADR 0004
   * keeps the audit trail and makes the latest event per
   * `(user, cluster, type)` the one that counts.
   */
  async recordFeedback(input: {
    readonly userId: UserId;
    readonly topicId: TopicId;
    readonly clusterId: ClusterId;
    readonly feedbackType: FeedbackType;
    /** Required by Hide-source, and ignored by the other four. */
    readonly sourceId?: SourceId | undefined;
    readonly scope?: FeedbackScope | undefined;
  }): Promise<FeedbackOutcome> {
    if (!isFeedbackType(input.feedbackType)) return { status: 'invalid_type' };
    const scope = this.resolveScope(input.feedbackType, input.scope);
    if (feedbackTypeWantsScope(input.feedbackType) && scope === null) {
      return { status: 'invalid_scope' };
    }

    const cluster = await this.deps.clusterRepo.findById(input.clusterId);
    // The Cluster has to be one of this Topic's. The route used to take any
    // clusterId off the form and write against it, so a User could leave a signal
    // on a Cluster belonging to somebody else's Topic.
    if (!cluster || cluster.topicId !== input.topicId) return { status: 'unknown_cluster' };

    const topic = await this.deps.topicRepo.getById(input.topicId);
    if (!topic || topic.userId !== input.userId) return { status: 'unknown_cluster' };

    const sourceId = feedbackTypeWantsScope(input.feedbackType) ? (input.sourceId ?? null) : null;
    if (feedbackTypeWantsScope(input.feedbackType)) {
      if (!sourceId) return { status: 'missing_source' };
      if (!topic.sourceIds.includes(sourceId)) return { status: 'unknown_source' };
    }

    const events = await this.deps.feedbackRepo.listByUser(input.userId);
    if (this.alreadyInForce(events, { ...input, sourceId, scope })) return { status: 'unchanged' };

    await this.deps.feedbackRepo.insert({
      id: `fe-${this.deps.random.uuid()}`,
      userId: input.userId,
      clusterId: input.clusterId,
      feedbackType: input.feedbackType,
      scope,
      sourceId,
      timestamp: this.deps.clock.now(),
    });
    return { status: 'recorded' };
  }

  /**
   * Whether recording this signal would say something the User has already said.
   *
   * `events` are newest first, so the first event for a Cluster is the one in
   * force. A Hide-source is compared against the first event naming that Source
   * rather than the first event for the Cluster, because hiding is a statement
   * about a Source and a User can hide two of them from the same Cluster.
   */
  private alreadyInForce(
    events: readonly FeedbackEvent[],
    input: {
      readonly clusterId: ClusterId;
      readonly feedbackType: FeedbackType;
      readonly sourceId: SourceId | null;
      readonly scope: FeedbackScope | null;
    },
  ): boolean {
    // Two separate questions, because the two kinds of signal are in force under
    // different rules. A Cluster signal is in force if it is among the signals the
    // Cluster still carries; a hide is in force if the *newest hide naming that
    // Source* says the same thing. Deciding the hide by walking to the first event
    // that happens to be a hide would let an unrelated Cluster signal recorded
    // after it answer the question instead, and a second identical hide would be
    // written as a duplicate.
    if (input.feedbackType === 'hide_source') {
      const newest = hiddenSourcesById(events, () => input.clusterId).get(input.sourceId!);
      if (!newest) return false;
      return newest.scope === input.scope;
    }
    return signalsByCluster(events).get(input.clusterId)?.activeTypes.has(input.feedbackType) === true;
  }

  /**
   * The scope a signal was given with.
   *
   * Only Hide-source carries one — it is the only signal whose reach depends on it,
   * since the other four are about a Cluster and a Cluster belongs to one Topic.
   * Absent means the narrowest scope rather than none, so the column is never null
   * for a hide and a hide reads the same whichever way it was submitted.
   */
  private resolveScope(
    feedbackType: FeedbackType,
    scope: FeedbackScope | undefined,
  ): FeedbackScope | null {
    if (feedbackType !== 'hide_source') return null;
    if (scope === undefined) return 'this_topic';
    return isFeedbackScope(scope) ? scope : null;
  }

  /** What this User has said, as one Topic's page reads it. */
  async feedbackFor(userId: UserId, topicId: TopicId): Promise<TopicFeedback> {
    const events = await this.deps.feedbackRepo.listByUser(userId);
    const clusters = await this.deps.clusterRepo.listByTopicId(topicId);
    const topicIdOf = new Map(clusters.map((c) => [c.id, c.topicId]));
    const signals = signalsByCluster(events);

    const hiddenSources = hiddenSourcesById(events, (clusterId) => topicIdOf.get(clusterId) ?? null);
    return {
      signalsByCluster: signals,
      hiddenSources,
      hiddenSourceIds: hiddenSourceIdsIn(hiddenSources, topicId),
      weightByArticleId: await this.propagate(signals),
    };
  }

  /**
   * A signal's weight on every Article of the Stories the Cluster was formed
   * from, which is the propagation ADR 0004 describes and the reason a signal on
   * one Cluster reaches another built from the same Article.
   *
   * Propagated from the signal *in force* on each Cluster rather than from every
   * event, so a Cluster that was liked and then disliked propagates a dislike
   * rather than both. Clusters carrying no weight are skipped without a query: a
   * User who has given one signal should not pay for a read of every Cluster they
   * have ever looked at.
   */
  private async propagate(
    signals: ReadonlyMap<ClusterId, ClusterSignals>,
  ): Promise<WeightByArticleId> {
    const weights = new Map<ArticleId, number>();
    for (const [clusterId, clusterSignals] of signals) {
      if (clusterSignals.weight === 0) continue;
      const storyIds = await this.deps.clusterRepo.listStoryIdsByClusterId(clusterId);
      for (const storyId of storyIds) {
        for (const article of await this.deps.articleRepo.listByStory(storyId)) {
          weights.set(article.id, (weights.get(article.id) ?? 0) + clusterSignals.weight);
        }
      }
    }
    return weights;
  }

  async getEventsForUser(userId: UserId): Promise<readonly FeedbackEvent[]> {
    return this.deps.feedbackRepo.listByUser(userId);
  }
}
