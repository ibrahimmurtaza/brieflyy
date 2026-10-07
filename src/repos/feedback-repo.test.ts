import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { makeCluster, makeTopic, makeUser } from '../testing/fixtures.js';
import { DrizzleClusterRepo } from './cluster-repo.js';
import { DrizzleFeedbackRepo } from './feedback-repo.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleUserRepo } from './user-repo.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { NO_BACKOFF } from '../domain/types.js';
import type { SourceId } from '../domain/types.js';

describe('DrizzleFeedbackRepo', () => {
  let feedbackRepo: DrizzleFeedbackRepo;

  beforeEach(async () => {
    const { db } = createTestDb();
    const userRepo = new DrizzleUserRepo(db);
    const topicRepo = new DrizzleTopicRepo(db);
    const clusterRepo = new DrizzleClusterRepo(db);
    feedbackRepo = new DrizzleFeedbackRepo(db);
    await new DrizzleSourceRepo(db).insert({
      id: 'reuters' as SourceId,
      slug: 'reuters',
      name: 'Reuters',
      homepageUrl: 'https://reuters.example.com',
      feedUrl: null,
      lastPolledAt: null,
      lastSuccessAt: null,
      backoff: NO_BACKOFF,
    });

    await userRepo.insert(makeUser({ id: 'user-1', onboardingState: 'completed' }));
    await topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'user-1' }));
    await clusterRepo.insert(
      makeCluster({ id: 'cluster-1', topicId: 'topic-1', summary: 'Test summary' }),
    );
  });

  it('inserts and lists feedback events', async () => {
    await feedbackRepo.insert({
      id: 'fe-1',
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'thumbs_up',
      scope: null,
      sourceId: null,
      timestamp: new Date('2026-01-01T10:00:00Z'),
    });
    const all = await feedbackRepo.listByUser('user-1');
    expect(all.length).toBe(1);
    expect(all[0]?.feedbackType).toBe('thumbs_up');
  });

  it('lists events by user and cluster', async () => {
    await feedbackRepo.insert({
      id: 'fe-1',
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'thumbs_down',
      scope: 'this_topic',
      sourceId: null,
      timestamp: new Date('2026-01-01T10:00:00Z'),
    });
    const events = await feedbackRepo.listByUserAndCluster('user-1', 'cluster-1');
    expect(events.length).toBe(1);
    expect(events[0]?.scope).toBe('this_topic');
  });

  it('round-trips the Source a hide_source signal names', async () => {
    // Without it the row said "hide something" about a Cluster, and the read
    // path had no way to tell which outlet was meant.
    await feedbackRepo.insert({
      id: 'fe-hide',
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'hide_source',
      scope: 'this_topic',
      sourceId: 'reuters' as SourceId,
      timestamp: new Date('2026-01-01T10:00:00Z'),
    });

    const [event] = await feedbackRepo.listByUser('user-1');
    expect(event?.sourceId).toBe('reuters');
  });

  it('lists a User\'s events newest first, so latest-wins can be read off the order', async () => {
    await feedbackRepo.insert({
      id: 'fe-old',
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'thumbs_up',
      scope: null,
      sourceId: null,
      timestamp: new Date('2026-01-01T10:00:00Z'),
    });
    await feedbackRepo.insert({
      id: 'fe-new',
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'thumbs_down',
      scope: null,
      sourceId: null,
      timestamp: new Date('2026-01-02T10:00:00Z'),
    });

    const events = await feedbackRepo.listByUser('user-1');
    expect(events.map((e) => e.feedbackType)).toEqual(['thumbs_down', 'thumbs_up']);
  });
});
