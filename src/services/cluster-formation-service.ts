import type { Clock } from '../domain/clock.js';
import { assignClusterIds } from '../domain/cluster-identity.js';
import {
  groupIntoClusters,
  sharedEntityCount,
  type GroundedEntity,
} from '../domain/cluster-grouping.js';
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
 * The velocity a Cluster has to reach to be Active, in Articles per day.
 *
 * Chosen from the distribution `pnpm cluster:velocity` prints over a real corpus,
 * and the measurement and the corpus it was read from are in
 * `docs/cluster-velocity-baseline.md`. The line sits above one Article a day, so a
 * Cluster one outlet published once is not Active however recently that was — the
 * rate cannot exceed one while it holds a single Article, whatever its span — and
 * below two, so the two Articles inside a day that say a story is being picked up
 * are Active rather than waiting for a third.
 *
 * Measured as Articles rather than Stories because one Story told by six outlets
 * and one Story told by one are the same thing counted once, and the second is not
 * news. See ADR-0005 and ADR-0035.
 */
export const CLUSTER_ACTIVE_VELOCITY_THRESHOLD = 1.5;

/**
 * The floor on the span a rate is measured over.
 *
 * A Cluster whose Articles all landed in the same cycle would otherwise divide by
 * nearly zero and read as infinitely fast. A day is short enough that the floor
 * applies to most of what a corpus holds rather than to a rare burst — every
 * Cluster younger than a day is measured as a whole day — so it caps a young
 * Cluster's rate at its Article count, and one Article is never more than 1.0.
 * That is load-bearing rather than a detail: it is what makes "one outlet
 * published this story once" a fixed number instead of a function of how long ago
 * it happened, and so what lets the Active threshold sit above it. See ADR-0035.
 */
const MIN_VELOCITY_SPAN_DAYS = 1;

/**
 * How many statements a Cluster's bullets carry.
 *
 * Exported for the same reason `clusterVelocity` is: the summary measurement asks
 * what a Cluster is given rather than what it spends, and a report that read the
 * number off a copy of it would be measuring the copy.
 */
export const MAX_BULLET_POINTS = 3;

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
 * Each Entity arrives with its kind as well as its id, because grouping weighs
 * an Entity by what kind of thing it is and not only by how rare it is — see
 * `ENTITY_KIND_WEIGHTS`.
 *
 * Exported rather than kept as a method because the benchmark reads it too, and
 * a second copy of "which Articles of this Story are in scope for this Topic"
 * would drift from the one that runs — which is exactly what the benchmark
 * exists to catch.
 */
export async function groundingByStoryInScope(
  topic: Topic,
  stories: readonly Story[],
  articleRepo: ArticleRepo,
): Promise<readonly (readonly GroundedEntity[])[]> {
  const perStory = await Promise.all(
    stories.map(async (story) => {
      const articles = await articleRepo.listByStory(story.id);
      return articles.filter((a) => topic.sourceIds.includes(a.sourceId));
    }),
  );
  return groundingOf(perStory);
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
   *
   * The one thing carried across a cycle is the Cluster's id, and the rule that
   * carries it is `domain/cluster-identity.ts`: a group of Stories keeps the id of
   * the Cluster it has most in common with, and everything else is new. So the
   * Clusters a User has been reading — and given Feedback on — stay the same rows
   * as Stories join them and age out of them, and the Archive does not accumulate
   * a copy of every Cluster for every way its membership has ever moved.
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

    const groups = await this.groupStories(topic, stories);
    const ids = assignClusterIds(
      topic.id,
      groups.map((group) => group.map((story) => story.id)),
      await this.deps.clusterRepo.listHeldByTopicId(topic.id),
    );

    const clusters: Cluster[] = [];
    for (const [index, group] of groups.entries()) {
      const cluster = await this.finalizeCluster(topic, group, ids[index]!, now);
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
   * here. What is left here is the reading of it: the Entities of the Articles of
   * a Story that this Topic actually follows, the signature the Story carries,
   * and the order each group comes back in.
   *
   * The signature is read off the Story rather than off its Articles. A Story
   * carries the signature of the Article that formed it and does not grow one as
   * copies arrive (ADR-0007), and that is the signature the rule gates on: a
   * union over the Articles was measured against the same labelled families and
   * costs recall at the floor that holds it in place, because the union widens
   * both sides of the comparison without widening their overlap.
   */
  private async groupStories(
    topic: Topic,
    stories: readonly Story[],
  ): Promise<readonly (readonly Story[])[]> {
    if (stories.length === 0) return [];
    const groundingByStory = await groundingByStoryInScope(
      topic,
      stories,
      this.deps.articleRepo,
    );

    const groups = groupIntoClusters(stories, (story, index) => ({
      entities: groundingByStory[index]!,
      signature: story.signature,
    }));
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
    id: ClusterId,
    now: Date,
  ): Promise<Cluster> {
    const perStory = await this.inScopeArticlesByStory(topic, stories);
    const articles: Article[] = perStory.flat();
    const summary = clusterSummaryOf(rankArticles(articles));
    const sourceIds = [
      ...new Set(articles.map((a) => a.sourceId).filter((id) => id.length > 0)),
    ].sort();
    const velocity = clusterVelocity(articles, stories, now);

    return {
      id,
      topicId: topic.id,
      title: summary.title,
      summary: summary.oneLiner,
      bulletPoints: summary.bulletPoints,
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
 * The kind is carried through with the id because grouping weighs the two
 * together.
 */
function groundingOf(
  perStory: readonly (readonly Article[])[],
): readonly (readonly GroundedEntity[])[] {
  return perStory.map((articles) => {
    const grounding = new Map<EntityId, GroundedEntity>();
    for (const article of articles) {
      for (const entity of article.entities) {
        grounding.set(entity.id, { id: entity.id, kind: entity.kind });
      }
    }
    return [...grounding.values()];
  });
}

/**
 * Articles a day, over the time since the Cluster's first Story was seen.
 *
 * The span is the Cluster's own life rather than the Topic's whole window,
 * because the question the number answers is whether a Cluster is still moving.
 * A story that broke this morning and a story that broke a week ago with
 * nothing since both have one Article, and only one of them is news.
 *
 * Articles rather than Stories, because a Story is one thing however many outlets
 * reported it and a Cluster's rate is what says how much attention that thing is
 * getting. Counting Stories gives one outlet's first report and twenty outlets
 * reporting it at once the same number, which is the same number a story nobody
 * has followed up on gets — so the rate is flat across most of what it ranks,
 * and a brief leads with whichever of those a cycle happened to write first. See
 * ADR-0035.
 *
 * The Articles counted are the ones the Cluster is built from: those of its
 * Stories that came from a Source this Topic follows, which is what `articleCount`
 * already holds and what a Cluster's summary is quoted from.
 */
export function clusterVelocity(
  articles: readonly Article[],
  stories: readonly Story[],
  now: Date,
): number {
  if (articles.length === 0) return 0;
  return articles.length / clusterSpanDays(stories, now);
}

function clusterSpanDays(stories: readonly Story[], now: Date): number {
  if (stories.length === 0) return MIN_VELOCITY_SPAN_DAYS;
  const firstSeenAt = stories.reduce(
    (earliest, story) => Math.min(earliest, story.firstSeenAt.getTime()),
    stories[0]!.firstSeenAt.getTime(),
  );
  return Math.max(MIN_VELOCITY_SPAN_DAYS, (now.getTime() - firstSeenAt) / DAY_MS);
}

/**
 * Whether a Cluster's rate is measured over the floor rather than over its own span.
 *
 * Exported for the same reason `clusterVelocity` is, and answering this rather than
 * handing out the span because the measurement asks exactly this: how many Clusters
 * a corpus measures over the floor decides whether the distribution it prints is
 * one of rates or one of Article counts, and a report that could not say which
 * would read as a claim about the rule when it is a claim about the corpus.
 */
export function measuredOverSpanFloor(stories: readonly Story[], now: Date): boolean {
  return clusterSpanDays(stories, now) === MIN_VELOCITY_SPAN_DAYS;
}

/**
 * The Articles of a Cluster, most representative first.
 *
 * The representative Article is the one sharing the most Entities with the rest
 * of the Cluster, so the sentence a Cluster is titled by is one the Cluster as a
 * whole is actually about rather than whatever happened to be written first.
 * Recency breaks a tie, because between two equally central Articles the newer
 * one has the more complete account.
 *
 * Exported for the same reason `clusterVelocity` is, and because the order is half
 * of what a Cluster summary is: the representative is what it is titled by and the
 * order is the order its bullets are drawn in, so a measurement of the summary has
 * to read this rather than re-derive a second order and report on it.
 */
export function rankArticles(articles: readonly Article[]): readonly Article[] {
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

export interface ClusterSummaryText {
  /** The Cluster's headline: its representative Article's own title. */
  readonly title: string;
  /** The line the bullets sit under: the representative Article's first statement. */
  readonly oneLiner: string;
  /** The statements below it, none of which repeats either of the two. */
  readonly bulletPoints: readonly string[];
}

/**
 * What a Cluster is shown with, read off its Articles in ranked order.
 *
 * One place, because the three lines are not independent: the title is the
 * representative Article's headline and the one-liner is a sentence off the same
 * Article, so a rule that excluded the one-liner from the bullets and not the title
 * would put the title straight back in through the headline fallback. Built here
 * rather than inline in `finalizeCluster` so the summary measurement runs this
 * rather than a second copy of it — a report reading its own copy would carry on
 * printing a clean number the day the rule changed and nobody changed it.
 */
export function clusterSummaryOf(ranked: readonly Article[]): ClusterSummaryText {
  const representative = ranked[0];
  const oneLiner = representative ? oneLinerFrom(representative) : '';
  const title = representative?.title.trim() ?? '';
  return {
    title,
    oneLiner,
    bulletPoints: bulletsFrom(ranked, MAX_BULLET_POINTS, [oneLiner, title]),
  };
}

function mostRecent(stories: readonly Story[]): Story {
  return stories.reduce(
    (latest, story) =>
      story.lastSeenAt.getTime() > latest.lastSeenAt.getTime() ? story : latest,
    stories[0]!,
  );
}
