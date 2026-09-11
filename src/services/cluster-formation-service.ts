import type { Clock } from '../domain/clock.js';
import type { Cluster, ClusterId, TopicId, StoryId, ArticleId, SourceId } from '../domain/types.js';
import type { StoryRepo } from '../repos/story-repo.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';

export interface ClusterFormationServiceDeps {
  readonly storyRepo: StoryRepo;
  readonly articleRepo: ArticleRepo;
  readonly clusterRepo: ClusterRepo;
  readonly topicRepo: TopicRepo;
  readonly clock: Clock;
}

export class ClusterFormationService {
  constructor(private readonly deps: ClusterFormationServiceDeps) {}

  async computeAndInsertClusters(topicId: TopicId, windowStart: Date, windowEnd: Date): Promise<readonly Cluster[]> {
    const topic = await this.deps.topicRepo.getById(topicId);
    const sourceIds = topic?.sourceIds ?? [];
    const candidateStories = await this.deps.storyRepo.listBySourceIdsInWindow({
      sourceIds,
      windowStart,
    });

    if (candidateStories.length === 0) return [];

    const clusters: Cluster[] = [];
    let currentClusterStories: StoryId[] = [];
    let currentClusterArticleCount = 0;
    let currentClusterVelocity = 0;

    for (const story of candidateStories) {
      if (currentClusterStories.length === 0) {
        currentClusterStories = [story.id];
        currentClusterArticleCount = story.articleCount;
        currentClusterVelocity = story.articleCount;
        continue;
      }

      const previousStory = candidateStories[candidateStories.indexOf(story) - 1];
      if (!previousStory) continue;
      const storyOverlap = await this.computeStoryOverlap(story.id, previousStory.id);

      if (storyOverlap > 0.5) {
        currentClusterStories.push(story.id);
        currentClusterArticleCount += story.articleCount;
        currentClusterVelocity = Math.max(currentClusterVelocity, story.articleCount);
      } else {
        await this.finalizeCluster(
          topicId,
          currentClusterStories,
          currentClusterArticleCount,
          currentClusterVelocity,
          windowStart,
          windowEnd,
          clusters,
        );
        currentClusterStories = [story.id];
        currentClusterArticleCount = story.articleCount;
        currentClusterVelocity = story.articleCount;
      }
    }

    if (currentClusterStories.length > 0) {
      await this.finalizeCluster(
        topicId,
        currentClusterStories,
        currentClusterArticleCount,
        currentClusterVelocity,
        windowStart,
        windowEnd,
        clusters,
      );
    }

    return clusters;
  }

  private async computeStoryOverlap(storyId1: StoryId, storyId2: StoryId): Promise<number> {
    const story1Entities = await this.deps.articleRepo.listByStory(storyId1);
    const story2Entities = await this.deps.articleRepo.listByStory(storyId2);

    const entities1 = new Set(story1Entities.flatMap(e => e.entities.map(ent => ent.id)));
    const entities2 = new Set(story2Entities.flatMap(e => e.entities.map(ent => ent.id)));

    const intersection = new Set([...entities1].filter(id => entities2.has(id)));

    return intersection.size / Math.max(entities1.size, entities2.size);
  }

  private async finalizeCluster(
    topicId: TopicId,
    storyIds: StoryId[],
    articleCount: number,
    velocity: number,
    windowStart: Date,
    windowEnd: Date,
    clusters: Cluster[],
  ): Promise<void> {
    // Gather all articles across stories to get representative title/body and source union
    const allArticlesInCluster: import('../domain/types.js').Article[] = [];
    for (const sid of storyIds) {
      const articles = await this.deps.articleRepo.listByStory(sid);
      for (const a of articles) {
        if (a) allArticlesInCluster.push(a);
      }
    }
    const sampleArticle = allArticlesInCluster[0];
    const title = sampleArticle?.title ?? '';
    const body = sampleArticle?.body ?? '';

    const { extractEntities, extractKeyPhrases } = await import('../domain/extract.js');
    const entities = extractEntities(`${title}\n${body}`);
    const keyPhrases = extractKeyPhrases(body);

    const summary = (entities.length > 0 ? entities[0] : title) ?? '';
    const bulletPoints = keyPhrases.slice(0, 3);

    const sourceIds = Array.from(new Set(allArticlesInCluster.map(a => a?.sourceId).filter((s): s is string => !!s)));
    const days = Math.max(1, (windowEnd.getTime() - windowStart.getTime()) / (1000 * 60 * 60 * 24));
    const computedVelocity = Math.max(0, storyIds.length / days);
    const state = computedVelocity > 0 ? 'active' : 'archive';

    const clusterId = `cluster-${topicId}-${windowStart.toISOString()}-${storyIds.sort().join('-')}`;
    const cluster: Cluster = {
      id: clusterId,
      topicId,
      title,
      summary,
      bulletPoints,
      createdAt: this.deps.clock.now(),
      lastSeenAt: windowEnd,
      articleCount,
      velocity: computedVelocity,
      sourceIds,
      state,
    };

    await this.deps.clusterRepo.insert(cluster, storyIds);
    clusters.push(cluster);
  }
}
