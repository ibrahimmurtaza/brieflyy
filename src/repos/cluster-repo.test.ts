import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { makeTopic, makeCluster, makeStory, makeUser } from '../testing/fixtures.js';
import { DrizzleClusterRepo } from './cluster-repo.js';
import { DrizzleStoryRepo } from './story-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleUserRepo } from './user-repo.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import { NO_BACKOFF } from '../domain/types.js';
import type {
  Source,
  StoryId,
  Cluster,
  TopicId,
  UserId,
} from '../domain/types.js';
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
  await userRepo.insert(
    makeUser({ id: input.userId as UserId, onboardingState: 'topics_picked' }),
  );
  await topicRepo.insert(
    makeTopic({ id: input.id, userId: input.userId }),
  );
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
    await userRepo.insert(
      makeUser({ id: 'user-1' as UserId, onboardingState: 'completed' }),
    );
    await topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'user-1' }));
    await sourceRepo.insert({
      id: 'src-test',
      slug: 'test',
      name: 'Test Source',
      homepageUrl: 'https://example.com',
      feedUrl: 'https://example.com/feed',
      lastPolledAt: null,
      lastSuccessAt: null,
      backoff: NO_BACKOFF,
    });
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
      backoff: NO_BACKOFF,
    };
    await sourceRepo.insert(source);

    const topicId = 'topic-1' as TopicId;
    const storyId = 'story-1' as StoryId;
    const articleId = 'article-1' as ArticleId;
    const now = new Date('2026-09-02T12:00:00Z');

    await storyRepo.insert({
      id: storyId,
      signature: EMPTY_SIGNATURE,
      firstSeenAt: now,
      lastSeenAt: now,
      published: { first: now, last: now }
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
        signature: EMPTY_SIGNATURE,
        storyId,
      },
      entityIds: [],
    });

    const cluster: Cluster = makeCluster({
      id: 'cluster-1',
      topicId,
      title: 'Acme Corp launches AI product',
      summary:
        'Acme Corp today unveiled a new AI product called Foo, analysts said.',
      bulletPoints: [
        'Acme Corp today unveiled a new AI product called Foo, analysts said.',
        'The launch changes the landscape for enterprise customers worldwide.',
      ],
      createdAt: now,
      lastSeenAt: now,
      articleCount: 1,
      velocity: 1.0,
      sourceIds: [source.id],
    });

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
      backoff: NO_BACKOFF,
    };
    await sourceRepo.insert(source);

    const topicId = 'topic-1' as TopicId;
    const storyId = 'story-1' as StoryId;
    const now = new Date('2026-09-02T12:00:00Z');

    await storyRepo.insert({
      id: storyId,
      signature: EMPTY_SIGNATURE,
      firstSeenAt: now,
      lastSeenAt: now,
      published: { first: now, last: now }
    });

    const cluster1: Cluster = makeCluster({
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
    });

    await clusterRepo.insert(cluster1, [storyId]);

    const cluster2: Cluster = makeCluster({
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
    });

    await clusterRepo.insert(cluster2, [storyId]);

    const clusters = await clusterRepo.listByTopicId(topicId);
    expect(clusters).toHaveLength(2);
    expect(clusters[0]?.title).toBe('Cluster 1');
    expect(clusters[1]?.title).toBe('Cluster 2');
    expect(clusters.map((c) => c.title)).toEqual(['Cluster 1', 'Cluster 2']);
  });

  it('stores a velocity that is a rate rather than a whole number', async () => {
    await clusterRepo.insert(
      makeCluster({ id: 'cluster-1', topicId: 'topic-1', velocity: 2 / 7 }),
      [],
    );

    const found = await clusterRepo.findById('cluster-1');

    expect(found?.velocity).toBeCloseTo(2 / 7, 6);
  });

  it('re-forming a Cluster updates it rather than raising a duplicate-key error', async () => {
    const now = new Date('2026-09-02T12:00:00Z');
    const storyId = 'story-1' as StoryId;
    await storyRepo.insert({
      id: storyId,
      signature: EMPTY_SIGNATURE,
      firstSeenAt: now,
      lastSeenAt: now,
      published: { first: now, last: now }
    });
    await clusterRepo.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        summary: 'First pass at this Cluster.',
        velocity: 1,
      }),
      [storyId],
    );

    await clusterRepo.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: 'topic-1',
        summary: 'Second pass at this Cluster.',
        velocity: 3,
        lastSeenAt: new Date('2026-09-02T13:00:00Z'),
      }),
      [storyId],
    );

    const clusters = await clusterRepo.listByTopicId('topic-1');
    expect(clusters).toHaveLength(1);
    expect(clusters[0]?.summary).toBe('Second pass at this Cluster.');
    expect(clusters[0]?.velocity).toBe(3);
  });

  it('archives the Clusters a re-form left behind', async () => {
    const now = new Date('2026-09-02T12:00:00Z');
    await clusterRepo.insert(makeCluster({ id: 'cluster-1', topicId: 'topic-1' }), []);
    await clusterRepo.insert(makeCluster({ id: 'cluster-2', topicId: 'topic-1' }), []);

    const archived = await clusterRepo.archiveExcluding(
      'topic-1',
      ['cluster-2'],
      new Date('2026-09-02T13:00:00Z'),
    );

    expect(archived).toBe(1);
    const clusters = await clusterRepo.listByTopicId('topic-1');
    expect(clusters.find((c) => c.id === 'cluster-1')?.state).toBe('archive');
    expect(clusters.find((c) => c.id === 'cluster-2')?.state).toBe('active');
  });

  it('archives every Cluster of a Topic that has none left to show', async () => {
    await clusterRepo.insert(makeCluster({ id: 'cluster-1', topicId: 'topic-1' }), []);

    const archived = await clusterRepo.archiveExcluding('topic-1', [], new Date());

    expect(archived).toBe(1);
    const clusters = await clusterRepo.listByTopicId('topic-1');
    expect(clusters.every((c) => c.state === 'archive')).toBe(true);
  });

  it('leaves another Topic alone when archiving', async () => {
    await topicRepo.insert(makeTopic({ id: 'topic-2', userId: 'user-1' }));
    await clusterRepo.insert(makeCluster({ id: 'cluster-1', topicId: 'topic-1' }), []);
    await clusterRepo.insert(makeCluster({ id: 'cluster-2', topicId: 'topic-2' }), []);

    await clusterRepo.archiveExcluding('topic-1', [], new Date());

    const other = await clusterRepo.findById('cluster-2');
    expect(other?.state).toBe('active');
  });

  it('retires the Stories of the Clusters it archives', async () => {
    await storyRepo.insert(makeStory({ id: 'story-1' }));
    await clusterRepo.insert(makeCluster({ id: 'cluster-1', topicId: 'topic-1' }), [
      'story-1' as StoryId,
    ]);
    expect((await storyRepo.getById('story-1' as StoryId))?.state).toBe('active');

    await clusterRepo.archiveExcluding('topic-1', [], new Date());

    // Written by the same pass that archived the Cluster, so a Story nothing is
    // covering is Retired without anything having to go looking to find out.
    expect((await storyRepo.getById('story-1' as StoryId))?.state).toBe('archive');
  });

  it('leaves a Story Active while one of the Clusters holding it is', async () => {
    await storyRepo.insert(makeStory({ id: 'story-1' }));
    await clusterRepo.insert(makeCluster({ id: 'cluster-1', topicId: 'topic-1' }), [
      'story-1' as StoryId,
    ]);
    await clusterRepo.insert(makeCluster({ id: 'cluster-2', topicId: 'topic-1' }), [
      'story-1' as StoryId,
    ]);

    // One Cluster going quiet is not the Story being Retired, which is why the
    // rule is about none of them rather than about the last one.
    await clusterRepo.archiveExcluding('topic-1', ['cluster-2'], new Date());

    expect((await storyRepo.getById('story-1' as StoryId))?.state).toBe('active');
  });

  it('brings a Retired Story back when one of its Clusters is Active again', async () => {
    await storyRepo.insert(makeStory({ id: 'story-1' }));
    await clusterRepo.insert(
      makeCluster({ id: 'cluster-1', topicId: 'topic-1', state: 'archive' }),
      ['story-1' as StoryId],
    );
    expect((await storyRepo.getById('story-1' as StoryId))?.state).toBe('archive');

    // A Cluster that is covered again comes back as Active on the next pass, and
    // the Story leaves Retired with it rather than staying retired by accident.
    await clusterRepo.insert(
      makeCluster({ id: 'cluster-1', topicId: 'topic-1', state: 'active' }),
      ['story-1' as StoryId],
    );

    expect((await storyRepo.getById('story-1' as StoryId))?.state).toBe('active');
  });

  it('retires a Story whose only Cluster was formed below the threshold', async () => {
    await storyRepo.insert(makeStory({ id: 'story-1' }));

    // Forming a Cluster writes the state it decided on, so a Cluster that is born
    // Archived is a Cluster that was never Active and must not leave its Stories
    // looking as though it were.
    await clusterRepo.insert(
      makeCluster({ id: 'cluster-1', topicId: 'topic-1', state: 'archive' }),
      ['story-1' as StoryId],
    );

    expect((await storyRepo.getById('story-1' as StoryId))?.state).toBe('archive');
  });
});

