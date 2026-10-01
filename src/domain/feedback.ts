import {
  FEEDBACK_TYPES,
  type Article,
  type ArticleId,
  type Cluster,
  type ClusterId,
  type FeedbackEvent,
  type FeedbackScope,
  type FeedbackType,
  type SourceId,
  type TopicId,
} from './types.js';

/** The scope names, as values rather than only as a type. */
export const FEEDBACK_SCOPES = ['this_topic', 'global'] as const;

/**
 * Whether a value names one of the five signals in the glossary.
 *
 * A guard rather than a cast, because the route that records Feedback takes its
 * type off a form: a cast turned whatever arrived into a FeedbackType, so a
 * hand-typed `type=shrug` became a row whose `feedback_type` named nothing and
 * no read path could say so.
 */
export function isFeedbackType(value: unknown): value is FeedbackType {
  return typeof value === 'string' && (FEEDBACK_TYPES as readonly string[]).includes(value);
}

/** Whether a value names one of the two scopes, for the same reason. */
export function isFeedbackScope(value: unknown): value is FeedbackScope {
  return typeof value === 'string' && (FEEDBACK_SCOPES as readonly string[]).includes(value);
}

/**
 * Which of the two opposite signals a type belongs to, or null when it is not one
 * of a pair.
 *
 * A verdict and a preference are deliberately in different groups: a User can
 * want more of what is in a Cluster without also wanting that Cluster itself
 * shown again, so the two accumulate rather than replacing each other.
 */
type FeedbackGroup = 'verdict' | 'preference';

function groupOf(type: FeedbackType): FeedbackGroup | null {
  switch (type) {
    case 'thumbs_up':
    case 'thumbs_down':
      return 'verdict';
    case 'more_like_this':
    case 'less_like_this':
      return 'preference';
    default:
      return null;
  }
}

/**
 * Whether a signal's reach depends on a scope.
 *
 * Only Hide-source does: it names a Source, and a Source can be hidden from the
 * one Topic it was found in or from every Topic the User has. The other four name
 * a Cluster, and a Cluster is already scoped to a Topic by belonging to it.
 */
export function feedbackTypeWantsScope(type: FeedbackType): boolean {
  return type === 'hide_source';
}

/**
 * How far one signal moves a Cluster up or down the LivingBrief.
 *
 * `more_like_this` outranks `thumbs_up` because a thumb says this Cluster is
 * fine and "more like this" says what the User wants to see next, which is the
 * claim that should move an unseen Cluster up. `hide_source` carries no weight:
 * hiding is an exclusion decided against a Source, so nothing is ranked by it.
 */
export function signalWeight(type: FeedbackType): number {
  switch (type) {
    case 'thumbs_up':
      return 1;
    case 'thumbs_down':
      return -1;
    case 'more_like_this':
      return 2;
    case 'less_like_this':
      return -2;
    case 'hide_source':
      return 0;
  }
}

/** The signals a Cluster still carries, and what they are worth together. */
export interface ClusterSignals {
  /** The signals still in force. At most one verdict and one preference. */
  readonly activeTypes: ReadonlySet<FeedbackType>;
  /** What they add up to, as `signalWeight` sees each one. */
  readonly weight: number;
}

/**
 * What a User's signals say about each Cluster, newest event winning.
 *
 * ADR 0004 keeps every event as an audit trail and makes the latest event per
 * `(user, cluster, type)` the one that counts. Within a pair of opposite signals
 * that means one of them: a User who thumbs a Cluster up and then down has a
 * verdict here, not two, so the page shows the change rather than leaving both
 * buttons lit. A verdict and a preference are separate groups and both survive.
 *
 * A Cluster is absent unless it carries a signal that names the Cluster.
 * Hide-source is not one — it names a Source, and is read through
 * `hiddenSourcesById` instead — so a Cluster whose only signal was Hide-source
 * has no entry, and the page shows it with nothing lit.
 *
 * The events are expected newest first, which is what the repository returns.
 */
export function signalsByCluster(
  events: readonly FeedbackEvent[],
): ReadonlyMap<ClusterId, ClusterSignals> {
  // Per Cluster, per group: the type in force. The first event seen for a group is
  // the newest one, and nothing after it can replace it — which is also why the
  // order of `events` is load-bearing rather than incidental.
  const decided = new Map<ClusterId, Map<FeedbackGroup, FeedbackType>>();
  for (const event of events) {
    const group = groupOf(event.feedbackType);
    if (group === null) continue;
    const forCluster = decided.get(event.clusterId) ?? new Map<FeedbackGroup, FeedbackType>();
    if (!forCluster.has(group)) {
      forCluster.set(group, event.feedbackType);
      decided.set(event.clusterId, forCluster);
    }
  }

  const out = new Map<ClusterId, ClusterSignals>();
  for (const [clusterId, byGroup] of decided) {
    const activeTypes = new Set<FeedbackType>();
    let weight = 0;
    for (const type of byGroup.values()) {
      activeTypes.add(type);
      weight += signalWeight(type);
    }
    out.set(clusterId, { activeTypes, weight });
  }
  return out;
}

/** The Source a User has asked not to see, and where the ask reaches. */
export interface HiddenSource {
  readonly sourceId: SourceId;
  /** The scope the latest signal for this Source was given with. */
  readonly scope: FeedbackScope;
  /**
   * The Topic a `this_topic` hide applies to, or null when the hide is global.
   * Derived from the Cluster the signal was recorded on rather than stored on
   * the event: a Cluster already belongs to one Topic, so recording it twice
   * would be a second answer to a question the row answers.
   */
  readonly topicId: TopicId | null;
}

/**
 * The Sources a User has hidden, from their Hide-source signals.
 *
 * Keyed by Source rather than by Cluster, because that is what the signal is
 * about: the old route wrote `hide_source` with no Source on it and hid the whole
 * Cluster, so a User who disliked one outlet lost every other outlet's reporting
 * of the same story with it. `topicIdOf` resolves the Cluster a signal was
 * recorded on to the Topic it belonged to; a Cluster that cannot be resolved
 * (removed, or belonging to somebody else) leaves a `this_topic` hide unapplied
 * rather than guessing which Topic it was about.
 */
export function hiddenSourcesById(
  events: readonly FeedbackEvent[],
  topicIdOf: (clusterId: ClusterId) => TopicId | null,
): ReadonlyMap<SourceId, HiddenSource> {
  const out = new Map<SourceId, HiddenSource>();
  for (const event of events) {
    if (!feedbackTypeWantsScope(event.feedbackType)) continue;
    if (!event.sourceId) continue;
    // Newest first, so the first signal seen for a Source is the one in force and
    // a later one is history.
    if (out.has(event.sourceId)) continue;
    const scope: FeedbackScope = event.scope ?? 'this_topic';
    const topicId = scope === 'global' ? null : topicIdOf(event.clusterId);
    if (scope === 'this_topic' && topicId === null) continue;
    out.set(event.sourceId, { sourceId: event.sourceId, scope, topicId });
  }
  return out;
}

/**
 * The Sources hidden from one Topic: the ones hidden from that Topic, plus the
 * ones hidden from everywhere.
 */
export function hiddenSourceIdsIn(
  hidden: ReadonlyMap<SourceId, HiddenSource>,
  topicId: TopicId,
): ReadonlySet<SourceId> {
  const out = new Set<SourceId>();
  for (const source of hidden.values()) {
    if (source.scope === 'global' || source.topicId === topicId) out.add(source.sourceId);
  }
  return out;
}

/** A signal's weight on each Article it reached. */
export type WeightByArticleId = ReadonlyMap<ArticleId, number>;

/**
 * How much a Cluster's Articles say the User wants to see more of it.
 *
 * The weights are propagated onto the Articles of the Stories a signal was given
 * on (ADR 0004), and a Cluster is scored by the mean of the weights behind it, so
 * a Cluster sharing one Article with something the User liked rises a little
 * rather than all the way: sharing an Article is weaker evidence than being it. A
 * Cluster with no Articles scores zero, which is the ordinary case for a Cluster
 * whose Articles are all from Sources this Topic does not follow.
 */
export function clusterRelevance(
  articles: readonly Article[],
  weightByArticleId: WeightByArticleId,
): number {
  if (articles.length === 0) return 0;
  let total = 0;
  for (const article of articles) total += weightByArticleId.get(article.id) ?? 0;
  return total / articles.length;
}

/** A Cluster's relevance, keyed by the Cluster it belongs to. */
export type RelevanceByClusterId = ReadonlyMap<ClusterId, number>;

/**
 * The order a LivingBrief shows a Topic's Clusters in.
 *
 * Relevance first, then recency, so a User who has said nothing sees exactly the
 * order the brief has always used and a signal can only move a Cluster relative
 * to what the User has already answered for. Recency is the tiebreak rather than
 * the primary key because a liked story from yesterday is not more interesting
 * than a liked story from this morning.
 */
export function orderByRelevance<T extends Cluster>(
  clusters: readonly T[],
  relevance: RelevanceByClusterId,
): readonly T[] {
  return [...clusters].sort((a, b) => {
    const delta = (relevance.get(a.id) ?? 0) - (relevance.get(b.id) ?? 0);
    if (delta !== 0) return -delta;
    return b.lastSeenAt.getTime() - a.lastSeenAt.getTime();
  });
}
