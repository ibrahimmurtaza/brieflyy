import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleClusterRepo } from './cluster-repo.js';
import { DrizzleStoryRepo } from './story-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleUserRepo } from './user-repo.js';
import type { Source, StoryId, Cluster, TopicId } from '../domain/types.js';
import type { ArticleId } from '../domain/types.js';
import { makeEntry, BODY_A, BODY_B } from '../ingest/test-constants.js';

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

describe('DrizzleClusterRepo', () => {
  let clusterRepo: DrizzleClusterRepo;
  let storyRepo: DrizzleStoryRepo;
  let articleRepo: DrizzleArticleRepo;
  let sourceRepo: DrizzleSourceRepo;
  let topicRepo: DrizzleTopicRepo;
  let userRepo: DrizzleUserRepo;

  beforeEach(async () => {
    const { db } = createTestDb();
    clusterRepo = new DrizzleClusterRepo(db);
    storyRepo = new DrizzleStoryRepo(db);
    articleRepo = new DrizzleArticleRepo(db);
    sourceRepo = new DrizzleSourceRepo(db);
    topicRepo = new DrizzleTopicRepo(db);
    userRepo = new DrizzleUserRepo(db);
  });

  it('creates a Cluster with extractive summary and bullet points from Stories', async () => {
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

    const topicId = 'topic-1' as TopicId;
    const storyId = 'story-1' as StoryId;
    const articleId = 'article-1' as ArticleId;
    const now = new Date('2026-09-02T12:00:00Z');

    await storyRepo.insert({
      id: storyId,
      sourceId: source.id,
      fingerprint: 'fp1',
      firstSeenAt: now,
      lastSeenAt: now,
    });

    await articleRepo.insert({
      article: {
        id: articleId,
        sourceId: source.id,
        externalId: 'ext-1',
        url: 'https://example.com/1',
        title: 'Acme Corp launches AI product',
        body: BODY_A,
        publishedAt: now,
        ingestedAt: now,
        entities: [],
        keyPhrases: [],
        fingerprint: 'fp1',
        storyId,
      },
      entityIds: [],
    });

    const cluster: Cluster = {
      id: 'cluster-1',
      topicId,
      title: 'Acme Corp launches AI product',
      summary: 'Acme Corp today unveiled a new AI product called Foo, analysts said.',
      bulletPoints: [
        'Acme Corp today unveiled a new AI product called Foo, analysts said.',
        'The launch changes the landscape for enterprise customers worldwide.',
      ],
      createdAt: now,
      lastSeenAt: now,
      articleCount: 1,
      velocity: 1.0,
      sourceIds: [source.id],
    };

    await clusterRepo.insert(cluster, [storyId]);

    const found = await clusterRepo.findById('cluster-1');
    expect(found).not.toBeNull();
    expect(found?.id).toBe('cluster-1');
    expect(found?.title).toBe('Acme Corp launches AI product');
    expect(found?.summary).toBe('Acme Corp today unveiled a new AI product called Foo, analysts said.');
    expect(found?.bulletPoints).toEqual([
      'Acme Corp today unveiled a new AI product called Foo, analysts said.',
      'The launch changes the landscape for enterprise customers worldwide.',
    ]);
    expect(found?.articleCount).toBe(1);
    expect(found?.sourceIds).toEqual([source.id]);
  });

  it('lists Clusters by topic ID', async () => {
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

    const topicId = 'topic-1' as TopicId;
    const storyId = 'story-1' as StoryId;
    const now = new Date('2026-09-02T12:00:00Z');

    await storyRepo.insert({
      id: storyId,
      sourceId: source.id,
      fingerprint: 'fp1',
      firstSeenAt: now,
      lastSeenAt: now,
    });

    const cluster1: Cluster = {
      id: 'cluster-1',
      topicId,
      title: 'Cluster 1',
      summary: 'Summary 1',
      bulletPoints: ['Point 1'],
      createdAt: now,
      lastSeenAt: now,
      articleCount: 1,
      velocity: 1.0,
      sourceIds: [source.id],
    };

    await clusterRepo.insert(cluster1, [storyId]);

    const cluster2: Cluster = {
      id: 'cluster-2',
      topicId,
      title: 'Cluster 2',
      summary: 'Summary 2',
      bulletPoints: ['Point 2'],
      createdAt: new Date('2026-09-02T13:00:00Z'),
      lastSeenAt: new Date('2026-09-02T13:00:00Z'),
      articleCount: 1,
      velocity: 0.5,
      sourceIds: [source.id],
    };

    await clusterRepo.insert(cluster2, [storyId]);

    const clusters = await clusterRepo.listByTopicId(topicId);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.title).toBe('Cluster 1');
    expect(clusters[1]?.title).toBe('Cluster 2');
    expect(clusters.map((c) => c.title)).toEqual(['Cluster 1', 'Cluster 2']);
  });
});

import type { UserId, TopicCategory } from '../domain/types.js';
