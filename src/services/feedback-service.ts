import type { Clock } from '../domain/clock.js';
import type { ClusterId, FeedbackEvent, FeedbackType, UserId } from '../domain/types.js';
import type { FeedbackRepo } from '../repos/feedback-repo.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';

export interface FeedbackServiceDeps {
  readonly feedbackRepo: FeedbackRepo;
  readonly clusterRepo: ClusterRepo;
  readonly clock: Clock;
}

export class FeedbackService {
  constructor(private readonly deps: FeedbackServiceDeps) {}

  async recordFeedback(input: {
    readonly userId: UserId;
    readonly clusterId: ClusterId;
    readonly feedbackType: FeedbackType;
    readonly scope?: 'this_topic' | 'global' | null | undefined;
  }): Promise<void> {
    const event: FeedbackEvent = {
      id: `fe-${input.userId}-${input.clusterId}-${input.feedbackType}-${this.deps.clock.now().toISOString()}`,
      userId: input.userId,
      clusterId: input.clusterId,
      feedbackType: input.feedbackType,
      scope: input.scope ?? (input.feedbackType === 'hide_source' ? 'this_topic' : null),
      timestamp: this.deps.clock.now(),
    };
    await this.deps.feedbackRepo.insert(event);
  }

  async getLatestEventsForCluster(userId: UserId, clusterId: ClusterId): Promise<readonly FeedbackEvent[]> {
    return this.deps.feedbackRepo.listLatestByUserAndCluster(userId, clusterId);
  }

  async getEventsForUser(userId: UserId): Promise<readonly FeedbackEvent[]> {
    return this.deps.feedbackRepo.listByUser(userId);
  }
}
