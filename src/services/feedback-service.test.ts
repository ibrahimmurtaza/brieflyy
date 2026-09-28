import { beforeEach, describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { makeCluster, makeTopic } from '../testing/fixtures.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleFeedbackRepo } from '../repos/feedback-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { makeTestClock } from '../testing/test-clocks.js';
import { FeedbackService } from './feedback-service.js';

describe('FeedbackService', () => {
  let service: FeedbackService;

  beforeEach(async () => {
    const { db } = createTestDb();
    const userRepo = new DrizzleUserRepo(db);
    const topicRepo = new DrizzleTopicRepo(db);
    const clusterRepo = new DrizzleClusterRepo(db);

    await userRepo.insert({
      id: 'user-1',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      onboardingState: 'completed',
      tier: 'free',
    });
    await topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'user-1' }));
    await clusterRepo.insert(makeCluster({ id: 'cluster-1', topicId: 'topic-1' }));

    service = new FeedbackService({
      feedbackRepo: new DrizzleFeedbackRepo(db),
      clusterRepo,
      clock: makeTestClock(new Date('2026-01-01T10:00:00Z')).clock,
    });
  });

  it('records feedback and retrieves it', async () => {
    await service.recordFeedback({
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'thumbs_up',
    });

    const events = await service.getLatestEventsForCluster('user-1', 'cluster-1');
    expect(events.length).toBe(1);
    expect(events[0]?.feedbackType).toBe('thumbs_up');
  });
});
