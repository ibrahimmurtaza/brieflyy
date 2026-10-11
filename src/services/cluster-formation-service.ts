import type { Clock } from '../domain/clock.js';
import { groupByEntityOverlap, sharedEntityCount } from '../domain/cluster-grouping.js';
import { bulletsFrom, oneLinerFrom } from '../domain/cluster-text.js';
import { clusterWindowStart } from '../domain/cluster-window.js';
import type {
  Article,
  Cluster,
  ClusterId,
  EntityId,
  Story,
  StoryId,
  Topic,
  TopicId,
} from '../domain/types.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { StoryRepo } from '../repos/story-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * The velocity a Cluster has to reach to be Active, in Stories per day.
 *
 * The glossary says Active is a matter of velocity being above a threshold but
 * not what the number is, and 0.2 is where the line earns its keep: two Stories
 * inside the default seven-day window clear it, while a single Story that has
 * not been re-seen since the window opened does not. That is the difference
 * between a story that is moving and one that was covered once, which is what a
 * User opening a LivingBrief is trying to tell apart.
 */
export const CLUSTER_ACTIVE_VELOCITY_THRESHOLD = 0.2;

/**
 * The floor on the span a rate is measured over. A Cluster whose Stories all
 * landed in the same cycle would otherwise divide by nearly zero and read as
 * infinitely fast, and a day is short enough that the floor only ever applies to
 * a Cluster that really is bursting.
 */
const MIN_VELOCITY_SPAN_DAYS = 1;

/** How many statements a Cluster's bullets carry. */
const MAX_BULLET_POINTS = 3;

export interface ClusterFormationReport {
  /** How many Topics were formed. */
  readonly topicsFormed: number;
  /** Every Cluster formed across those Topics. */
  readonly clusters: readonly Cluster[];
  /** How many Clusters a re-form left behind and archived. */
  readonly archived: number;
}

export interface ClusterFormationServiceDeps {
  readonly storyRepo: StoryRepo;
  readonly articleRepo: ArticleRepo;
  readonly clusterRepo: ClusterRepo;
  readonly topicRepo: TopicRepo;
  readonly clock: Clock;
}

/**
 * The Entities grouping sees for each of a Topic's Stories.
 *
 * Exported rather than kept as a method because the benchmark reads it too, and
 * a second copy of "which Articles of this Story are in scope for this Topic"
 * would drift from the one that runs — which is exactly what the benchmark
 * exists to catch.
 */
export async function entityIdsByStoryInScope(
  topic: Topic,
  stories: readonly Story[],
  articleRepo: ArticleRepo,
): Promise<readonly (readonly EntityId[])[]> {
  const perStory = await Promise.all(
    stories.map(async (story) => {
      const articles = await articleRepo.listByStory(story.id);
      return articles.filter((a) => topic.sourceIds.includes(a.sourceId));
    }),
  );
  return entityIdsOf(perStory);
}

export class ClusterFormationService {
  constructor(private readonly deps: ClusterFormationServiceDeps) {}

  /**
   * Form every Topic's Clusters for the window ending now. This is what the
   * ingest cycle runs once the Stories it wrote have settled, so that a User
   * opening a Topic sees Clusters rather than an empty page.
   */
  async formForAllTopics(
    now: Date = this.deps.clock.now(),
  ): Promise<ClusterFormationReport> {
    const topics = await this.deps.topicRepo.listAll();
    const clusters: Cluster[] = [];
    let archived = 0;
    for (const topic of topics) {
      const formed = await this.formTopic(topic, now);
      clusters.push(...formed.clusters);
      archived += formed.archived;
    }
    return { topicsFormed: topics.length, clusters, archived };
  }

  /**
   * Form one Topic's Clusters over the window its own setting asks for.
   */
  async formClustersForTopic(
    topicId: TopicId,
    now: Date = this.deps.clock.now(),
  ): Promise<readonly Cluster[]> {
    const topic = await this.deps.topicRepo.getById(topicId);
    if (!topic) return [];
    const { clusters } = await this.formTopic(topic, now);
    return clusters;
  }

  /**
   * Clusters are re-formed from scratch on every call rather than added to, so
   * a Story that has aged out of the window stops being counted. Anything left
   * over is archived, which is what stops a Topic's LivingBrief from filling up
   * with copies of Stories that have moved on.
   */
  private async formTopic(
    topic: Topic,
    now: Date,
  ): Promise<{ clusters: readonly Cluster[]; archived: number }> {
    // A Topic the User never gave a Source has nothing to form Clusters from.
    if (topic.sourceIds.length === 0) {
      return { clusters: [], archived: 0 };
    }

    const windowStart = clusterWindowStart(now, topic.clusterWindowDays);
    const stories = await this.deps.storyRepo.listBySourceIdsInWindow({
      sourceIds: topic.sourceIds,
      windowStart,
    });

    const clusters: Cluster[] = [];
    for (const group of await this.groupStories(topic, stories)) {
      const cluster = await this.finalizeCluster(topic, group, now);
      await this.deps.clusterRepo.insert(
        cluster,
        group.map((story) => story.id),
      );
      clusters.push(cluster);
    }

    const archived = await this.deps.clusterRepo.archiveExcluding(
      topic.id,
      clusters.map((c) => c.id),
      now,
    );
    return { clusters, archived };
  }

  /**
   * Split Stories into the groups that become Clusters.
   *
   * The rule itself is in `domain/cluster-grouping.ts`, which the benchmark
   * measures against real Topics as well, so that what is measured is what runs
   * here. What is left here is the reading of it: the Entities of the Articles
   * of a Story that this Topic actually follows, and the order each group comes
   * back in.
   */
  private async groupStories(
    topic: Topic,
    stories: readonly Story[],
  ): Promise<readonly (readonly Story[])[]> {
    if (stories.length === 0) return [];
    const entityIdsByStory = await entityIdsByStoryInScope(
      topic,
      stories,
      this.deps.articleRepo,
    );

    const groups = groupByEntityOverlap(
      stories,
      (_story, index) => entityIdsByStory[index]!,
    );
    return groups.map((group) =>
      [...group].sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime()),
    );
  }

  /**
   * The Articles of these Stories that the Topic follows, one list per Story.
   *
   * A Story can span Sources now, and one of them is usually not on this Topic's
   * list — the same syndicated report arrives for every Topic, and each one is
   * built from the Sources it follows. Grouping on Entities the User cannot see
   * would fuse two Stories because of a mention from an outlet they never added,
   * and a Cluster summary is only ever quoted from Articles in the Cluster, so
   * the ones out of scope have to be out of the Cluster too. Which is also what
   * keeps a Cluster's Source list a list of Sources the User follows.
   */
  private async inScopeArticlesByStory(
    topic: Topic,
    stories: readonly Story[],
  ): Promise<readonly (readonly Article[])[]> {
    return Promise.all(
      stories.map(async (story) => {
        const articles = await this.deps.articleRepo.listByStory(story.id);
        return articles.filter((a) => topic.sourceIds.includes(a.sourceId));
      }),
    );
  }

  private async finalizeCluster(
    topic: Topic,
    stories: readonly Story[],
    now: Date,
  ): Promise<Cluster> {
    const perStory = await this.inScopeArticlesByStory(topic, stories);
    const articles: Article[] = perStory.flat();
    const ranked = rankArticles(articles);
    const representative = ranked[0];

    const oneLiner = representative ? oneLinerFrom(representative) : '';
    const title = representative?.title.trim() ?? '';
    const bulletPoints = bulletsFrom(
      ranked,
      MAX_BULLET_POINTS,
      oneLiner,
    );
    const sourceIds = [
      ...new Set(articles.map((a) => a.sourceId).filter((id) => id.length > 0)),
    ].sort();
    const velocity = clusterVelocity(stories, now);

    return {
      id: clusterIdFor(topic.id, stories),
      topicId: topic.id,
      title,
      summary: oneLiner,
      bulletPoints,
      createdAt: now,
      lastSeenAt: mostRecent(stories).lastSeenAt,
      articleCount: articles.length,
      velocity,
      sourceIds,
      state:
        velocity >= CLUSTER_ACTIVE_VELOCITY_THRESHOLD ? 'active' : 'archive',
    };
  }
}

/**
 * Which Entities each Story carries, as the union over its Articles.
 *
 * A Story's Entities are the ones its Articles name, and an Article with none
 * contributes nothing rather than an empty set that would overlap everything.
 */
function entityIdsOf(
  perStory: readonly (readonly Article[])[],
): readonly (readonly EntityId[])[] {
  return perStory.map((articles) => {
    const ids = new Set<EntityId>();
    for (const article of articles) {
      for (const entity of article.entities) ids.add(entity.id);
    }
    return [...ids];
  });
}

/**
 * Stories per day, over the time since the first of them was seen.
 *
 * The span is the Cluster's own life rather than the Topic's whole window,
 * because the question the number answers is whether a Cluster is still moving.
 * A story that broke this morning and a story that broke a week ago with
 * nothing since both have one Story, and only one of them is news.
 */
function clusterVelocity(stories: readonly Story[], now: Date): number {
  if (stories.length === 0) return 0;
  const firstSeenAt = stories.reduce(
    (earliest, story) => Math.min(earliest, story.firstSeenAt.getTime()),
    stories[0]!.firstSeenAt.getTime(),
  );
  const spanDays = Math.max(
    MIN_VELOCITY_SPAN_DAYS,
    (now.getTime() - firstSeenAt) / DAY_MS,
  );
  return stories.length / spanDays;
}

/**
 * The Articles of a Cluster, most representative first.
 *
 * The representative Article is the one sharing the most Entities with the rest
 * of the Cluster, so the sentence a Cluster is titled by is one the Cluster as a
 * whole is actually about rather than whatever happened to be written first.
 * Recency breaks a tie, because between two equally central Articles the newer
 * one has the more complete account.
 */
function rankArticles(articles: readonly Article[]): readonly Article[] {
  const entityIdsByArticle = articles.map(
    (a) => new Set(a.entities.map((e) => e.id)),
  );
  const centrality = entityIdsByArticle.map(
    (ids) =>
      entityIdsByArticle.filter(
        (other) => other !== ids && sharedEntityCount(ids, other) > 0,
      ).length,
  );
  return articles
    .map((article, index) => ({ article, index, centrality: centrality[index]! }))
    .sort(
      (a, b) =>
        b.centrality - a.centrality ||
        b.article.publishedAt.getTime() - a.article.publishedAt.getTime() ||
        a.index - b.index,
    )
    .map((entry) => entry.article);
}

function mostRecent(stories: readonly Story[]): Story {
  return stories.reduce(
    (latest, story) =>
      story.lastSeenAt.getTime() > latest.lastSeenAt.getTime() ? story : latest,
    stories[0]!,
  );
}

/**
 * A Cluster's id, derived from the Stories in it.
 *
 * Derived from membership rather than from the clock so that re-forming the
 * same Stories lands on the same Cluster and updates it. An id carrying the
 * window would make every cycle mint a fresh copy of every Cluster, and a
 * Topic's LivingBrief would fill with duplicates of the same news.
 *
 * The cost is that a Cluster which gains or loses a Story becomes a different
 * Cluster by id, and the one it was is archived. That is the glossary's shape
 * rather than a leak: Archive is history of Clusters beyond their active
 * lifetime, and a Story joining a Cluster is a genuine change to what that
 * Cluster is, not a new draft of the same thing.
 */
function clusterIdFor(topicId: TopicId, stories: readonly Story[]): ClusterId {
  const members = stories.map((s) => s.id).sort().join('|');
  return `cluster-${topicId}-${members}` as ClusterId;
}
