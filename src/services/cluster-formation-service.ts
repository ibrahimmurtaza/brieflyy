import type { Clock } from '../domain/clock.js';
import { assignClusterIds } from '../domain/cluster-identity.js';
import {
  groundingFor,
  groupIntoClusters,
  sharedEntityCount,
  type Grouping,
} from '../domain/cluster-grouping.js';
import { clusterWindowStart } from '../domain/cluster-window.js';
import { clusterSummaryOf, MAX_BULLET_POINTS } from '../domain/cluster-summary.js';
import type {
  Article,
  Cluster,
  ClusterId,
  Story,
  StoryId,
  Topic,
  TopicId,
} from '../domain/types.js';
import type { Db } from '../db/client.js';
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

export interface ClusterFormationReport {
  /**
   * How many Topics were formed, which is every Topic that was **not** refused.
   *
   * The two counts together cover the Topics the pass walked, and neither would be
   * worth having alone: a report saying it formed six Topics and listing no Clusters
   * for one of them is the silence this refusal exists to end.
   */
  readonly topicsFormed: number;
  /** Every Cluster formed across those Topics. */
  readonly clusters: readonly Cluster[];
  /** How many Clusters a re-form left behind and archived. */
  readonly archived: number;
  /**
   * The Topics whose Stories carry embeddings from more than one model, and which.
   *
   * A Topic in here was not formed at all: grouping refused it, so it keeps the
   * Clusters it had rather than being emptied into a grouping nobody can act on.
   * There is nowhere else inside the application this can be seen — a mixed corpus
   * produces cosines that all still look like numbers, so a User finds their
   * Clusters quietly worse and nothing anywhere says why.
   */
  readonly refused: readonly RefusedTopic[];
}

/** One Topic grouping refused, named by its id rather than by its Stories. */
export interface RefusedTopic {
  readonly topicId: TopicId;
  /** Every model found in its Stories' embeddings, sorted. */
  readonly models: readonly string[];
  /** Every width found in its Stories' embeddings, sorted. */
  readonly widths: readonly number[];
}

export interface ClusterFormationServiceDeps {
  readonly storyRepo: StoryRepo;
  readonly articleRepo: ArticleRepo;
  readonly clusterRepo: ClusterRepo;
  readonly topicRepo: TopicRepo;
  readonly db: Db;
  readonly clock: Clock;
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
    const refused: RefusedTopic[] = [];
    let archived = 0;
    for (const topic of topics) {
      const formed = await this.formTopic(topic, now);
      // One refused Topic does not stop the rest: the loop is over every Topic the
      // database holds, and a model change is not a property of the User who owns
      // the one that changed. The refusal is reported rather than thrown, so the
      // cycle that called this finishes and says what it could not do.
      if (formed.refusal !== null) refused.push(formed.refusal);
      else {
        clusters.push(...formed.clusters);
        archived += formed.archived;
      }
    }
    return { topicsFormed: topics.length - refused.length, clusters, archived, refused };
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
   *
   * **A Topic grouping refuses is left alone rather than emptied.** Grouping
   * refuses a set whose Stories carry embeddings from more than one model, and the
   * alternative here — carrying on with two of three floors for the pairs that
   * cannot be compared — is a clustering nobody chose, reported nowhere. Archiving
   * what the Topic had would be the other half of that silence: a User whose model
   * changed would open their brief to nothing at all, with no reason given. So the
   * Clusters stay, the refusal is reported, and an operator backfills the corpus.
   */
  private async formTopic(
    topic: Topic,
    now: Date,
  ): Promise<{
    clusters: readonly Cluster[];
    archived: number;
    refusal: RefusedTopic | null;
  }> {
    // A Topic the User never gave a Source has nothing to form Clusters from.
    if (topic.sourceIds.length === 0) {
      return { clusters: [], archived: 0, refusal: null };
    }

    const windowStart = clusterWindowStart(now, topic.clusterWindowDays);
    const stories = await this.deps.storyRepo.listBySourceIdsInWindow({
      sourceIds: topic.sourceIds,
      windowStart,
    });

    const grouping = await this.groupStories(topic, stories);
    if (grouping.refusal !== null) {
      return {
        clusters: [],
        archived: 0,
        refusal: { topicId: topic.id, models: grouping.refusal.models, widths: grouping.refusal.widths },
      };
    }
    const groups = grouping.clusters;

    const ids = assignClusterIds(
      topic.id,
      groups.map((group) => group.map((story) => story.id)),
      await this.deps.clusterRepo.listHeldByTopicId(topic.id),
    );

    // Finalize every Cluster (this reads its Articles, so it happens before the
    // transaction: the read side stays outside, deliberately).
    const prepared: { readonly cluster: Cluster; readonly storyIds: readonly StoryId[] }[] = [];
    for (const [index, group] of groups.entries()) {
      prepared.push({
        cluster: await this.finalizeCluster(topic, group, ids[index]!, now),
        storyIds: group.map((story) => story.id),
      });
    }

    // Everything one Topic's formation writes lands in one transaction: the
    // upsert of each Cluster, its membership rows, both sides of the Story
    // states, and the archive pass. A failure anywhere rolls the whole Topic
    // back to the way it was before the pass.
    let archived = 0;
    this.deps.db.transaction((tx) => {
      for (const { cluster, storyIds } of prepared) {
        this.deps.clusterRepo.insert(cluster, storyIds, tx);
      }
      archived = this.deps.clusterRepo.archiveExcluding(
        topic.id,
        prepared.map(({ cluster }) => cluster.id),
        now,
        tx,
      );
    });
    return { clusters: prepared.map(({ cluster }) => cluster), archived, refusal: null };
  }

  /**
   * Split Stories into the groups that become Clusters, or report why not.
   *
   * The rule itself is in `domain/cluster-grouping.ts`, which the benchmark
   * measures against real Topics as well, so that what is measured is what runs
   * here. What is left here is the reading of it: the Entities of the Articles of
   * a Story that this Topic actually follows, the signature the Story carries,
   * the embedding the Story carries, and the order each group comes back in.
   *
   * The signature is read off the Story rather than off its Articles. A Story
   * carries the signature of the Article that formed it and does not grow one as
   * copies arrive (ADR-0007), and that is the signature the rule gates on: a
   * union over the Articles was measured against the same labelled families and
   * costs recall at the floor that holds it in place, because the union widens
   * both sides of the comparison without widening their overlap.
   *
   * The embedding is read the same way and for the same reason — it is the second
   * reading of that same Article, fixed at formation (ADR-0037). A Story carrying
   * none reads as carrying none rather than as reading as zeroes, which is what
   * keeps a corpus that embeds nothing grouping exactly as it did before. A Topic
   * carrying two models' worth is the other end of that: grouping returns a refusal
   * naming both, and this passes it on rather than grouping what is left.
   */
  private async groupStories(
    topic: Topic,
    stories: readonly Story[],
  ): Promise<Grouping<Story>> {
    if (stories.length === 0) return { clusters: [], refusal: null };
    const grounded = await groundingFor(topic, stories, this.deps.articleRepo);

    const grouping = groupIntoClusters(stories, (_story, index) => grounded[index]!);
    if (grouping.clusters === null) return grouping;
    return {
      clusters: grouping.clusters.map((group) =>
        [...group].sort((a, b) => a.lastSeenAt.getTime() - b.lastSeenAt.getTime()),
      ),
      refusal: null,
    };
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

function mostRecent(stories: readonly Story[]): Story {
  return stories.reduce(
    (latest, story) =>
      story.lastSeenAt.getTime() > latest.lastSeenAt.getTime() ? story : latest,
    stories[0]!,
  );
}
