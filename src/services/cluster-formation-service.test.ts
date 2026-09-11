import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import type { Source, StoryId, Cluster, TopicId } from '../domain/types.js';
import type { ArticleId } from '../domain/types.js';
import { makeEntry, BODY_A, BODY_B } from '../ingest/test-constants.js';
import { ClusterFormationService } from './cluster-formation-service.js';

async function insertTopicWithSources(
  topicRepo: DrizzleTopicRepo,
  userRepo: DrizzleUserRepo,
  input: {
    readonly id: string;
    readonly userId: string;
    readonly sourceIds: readonly string[];
  },
): Promise<TopicId> {
  await userRepo.insert({
    id: input.userId as UserId,
    createdAt: new Date('2026-09-01T00:00:00Z'),
    onboardingState: 'topics_picked',
  });
  await topicRepo.insert({
    id: input.id as TopicId,
    userId: input.userId as UserId,
    slug: input.id,
    title: `Topic ${input.id}`,
    blurb: '',
    category: 'news' as TopicCategory,
    origin: { kind: 'freeform' },
    sourceIds: [],
    createdAt: new Date('2026-09-01T00:00:00Z'),
  });
  for (let i = 0; i < input.sourceIds.length; i++) {
    await topicRepo.insertTopicSource(
      input.id as TopicId,
      input.sourceIds[i]!,
      i,
    );
  }
  return input.id as TopicId;
}

interface BuildResult {
  clusterFormationService: ClusterFormationService;
  clusterRepo: DrizzleClusterRepo;
  storyRepo: DrizzleStoryRepo;
  articleRepo: DrizzleArticleRepo;
  sourceRepo: DrizzleSourceRepo;
  topicRepo: DrizzleTopicRepo;
  userRepo: DrizzleUserRepo;
}

async function buildService(): Promise<BuildResult> {
  const { db } = createTestDb();
  const clusterRepo = new DrizzleClusterRepo(db);
  const storyRepo = new DrizzleStoryRepo(db);
  const articleRepo = new DrizzleArticleRepo(db);
  const sourceRepo = new DrizzleSourceRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const userRepo = new DrizzleUserRepo(db);

  const source: Source = {
    id: 'src-test',
    slug: 'test',
    name: 'Test Source',
    homepageUrl: 'https://example.com',
    feedUrl: 'https://example.com/feed',
    lastPolledAt: null,
    lastSuccessAt: null,
  };
  await sourceRepo.insert(source);

  const clusterFormationService = new ClusterFormationService({
    storyRepo,
    articleRepo,
    clusterRepo,
    topicRepo,
    clock: { now: () => new Date('2026-09-02T12:00:00Z') },
  });

  return {
    clusterFormationService,
    clusterRepo,
    storyRepo,
    articleRepo,
    sourceRepo,
    topicRepo,
    userRepo,
  };
}

describe('ClusterFormationService', () => {
  it('computes and inserts clusters from Stories', async () => {
    const { clusterFormationService, topicRepo, userRepo, storyRepo, articleRepo } = await buildService();
    await insertTopicWithSources(topicRepo, userRepo, {
      id: 'topic-1',
      userId: 'user-1',
      sourceIds: ['src-test'],
    });

    const windowStart = new Date('2026-09-01T12:00:00Z');
    const windowEnd = new Date('2026-09-02T12:00:00Z');

    await storyRepo.insert({
      id: 'story-1',
      sourceId: 'src-test',
      fingerprint: 'fp1',
      firstSeenAt: windowStart,
      lastSeenAt: windowEnd,
    });
    await articleRepo.insert({
      article: {
        id: 'article-1',
        sourceId: 'src-test',
        externalId: 'ext-1',
        url: 'https://example.com/1',
        title: 'Acme Corp launches AI product',
        body: BODY_A,
        publishedAt: windowEnd,
        ingestedAt: windowEnd,
        entities: [],
        keyPhrases: ['AI product', 'launch'],
        fingerprint: 'fp1',
        storyId: 'story-1',
      },
      entityIds: [],
    });

    const clusters = await clusterFormationService.computeAndInsertClusters(
      'topic-1',
      windowStart,
      windowEnd,
    );

    expect(clusters).toHaveLength(1);
    expect(clusters[0].title).toBe('Acme Corp launches AI product');
    expect(clusters[0].summary).toBe('Acme Corp');
    expect(clusters[0].bulletPoints.length).toBeGreaterThan(0);
  });
});
