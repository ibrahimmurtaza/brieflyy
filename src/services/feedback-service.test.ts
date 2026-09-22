import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleFeedbackRepo } from '../repos/feedback-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { FeedbackService } from './feedback-service.js';
import { makeTestClock } from '../testing/test-clocks.js';

describe('FeedbackService', () => {
  it('records feedback and retrieves it', async () => {
    const { db, driver } = createTestDb();
    driver.prepare('INSERT INTO users (id, created_at, onboarding_state) VALUES (?, ?, ?)').run('user-1', Date.now(), 'completed');
    driver.prepare('INSERT INTO clusters (id, topic_id, title, summary, bullet_points, created_at, last_seen_at, article_count, velocity, source_ids, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('cluster-1', 'topic-1', 'Test', 'Test summary', '[]', Date.now(), Date.now(), 1, 1, '[]', 'active');

    const repo = new DrizzleFeedbackRepo(db);
    const clusterRepo = new DrizzleClusterRepo(db);
    const service = new FeedbackService({
      feedbackRepo: repo,
      clusterRepo,
      clock: makeTestClock(new Date('2026-01-01T10:00:00Z')).clock,
    });

    await service.recordFeedback({
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'thumbs_up',
    });

    const events = await service.getLatestEventsForCluster('user-1', 'cluster-1');
    expect(events.length).toBe(1);
    expect(events[0].feedbackType).toBe('thumbs_up');
  });
});
