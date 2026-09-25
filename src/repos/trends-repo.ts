import type { TopicId, TopicTrend } from '../domain/types.js';

export interface TrendsRepo {
  computeTopicTrend(topicId: TopicId, tier: 'free' | 'paid'): Promise<TopicTrend>;
}

