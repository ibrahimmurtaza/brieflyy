import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleFeedbackRepo } from './feedback-repo.js';

describe('DrizzleFeedbackRepo', () => {
  it('inserts and lists feedback events', async () => {
    const { db, driver } = createTestDb();
    // Insert reference rows directly via raw SQL to bypass foreign key issues
    driver.prepare('INSERT INTO users (id, created_at, onboarding_state) VALUES (?, ?, ?)').run('user-1', Date.now(), 'completed');
    driver.prepare('INSERT INTO clusters (id, topic_id, title, summary, bullet_points, created_at, last_seen_at, article_count, velocity, source_ids, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('cluster-1', 'topic-1', 'Test', 'Test summary', '[]', Date.now(), Date.now(), 1, 1, '[]', 'active');

    const repo = new DrizzleFeedbackRepo(db);
    await repo.insert({
      id: 'fe-1',
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'thumbs_up',
      scope: null,
      timestamp: new Date('2026-01-01T10:00:00Z'),
    });
    const all = await repo.listByUser('user-1');
    expect(all.length).toBe(1);
    expect(all[0].feedbackType).toBe('thumbs_up');
  });

  it('lists events by user and cluster', async () => {
    const { db, driver } = createTestDb();
    driver.prepare('INSERT INTO users (id, created_at, onboarding_state) VALUES (?, ?, ?)').run('user-1', Date.now(), 'completed');
    driver.prepare('INSERT INTO clusters (id, topic_id, title, summary, bullet_points, created_at, last_seen_at, article_count, velocity, source_ids, state) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run('cluster-1', 'topic-1', 'Test', 'Test summary', '[]', Date.now(), Date.now(), 1, 1, '[]', 'active');
    const repo = new DrizzleFeedbackRepo(db);
    await repo.insert({
      id: 'fe-1',
      userId: 'user-1',
      clusterId: 'cluster-1',
      feedbackType: 'thumbs_down',
      scope: 'this_topic',
      timestamp: new Date('2026-01-01T10:00:00Z'),
    });
    const events = await repo.listByUserAndCluster('user-1', 'cluster-1');
    expect(events.length).toBe(1);
    expect(events[0].scope).toBe('this_topic');
  });
});
