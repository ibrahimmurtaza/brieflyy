import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { makeCluster, makeTopic } from '../testing/fixtures.js';
import { DrizzleClusterRepo } from './cluster-repo.js';
import { DrizzleFeedbackRepo } from './feedback-repo.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleUserRepo } from './user-repo.js';

describe('DrizzleFeedbackRepo', () => {
  let feedbackRepo: DrizzleFeedbackRepo;

  beforeEach(async () => {
    const { db } = createTestDb();
    const userRepo = new DrizzleUserRepo(db);
    const topicRepo = new DrizzleTopicRepo(db);
    const clusterRepo = new DrizzleClusterRepo(db);
    feedbackRepo = new DrizzleFeedbackRepo(db);

    await userRepo.insert({
      id: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      onboardingState: 'completed',
      tier: 'free',
    });
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
      timestamp: new Date('2026-01-01T10:00:00Z'),
    });
    const events = await feedbackRepo.listByUserAndCluster('user-1', 'cluster-1');
    expect(events.length).toBe(1);
    expect(events[0]?.scope).toBe('this_topic');
  });
});
