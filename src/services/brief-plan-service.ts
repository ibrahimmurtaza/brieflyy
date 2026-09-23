import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import type {
  BriefPlan,
  BriefSnapshot,
  Cluster,
  TopicId,
  UserId,
  ClusterId,
} from '../domain/types.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { BriefPlanRepo } from '../repos/brief-plan-repo.js';
import type { BriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';

export interface BriefPlanServiceDeps {
  readonly clusterRepo: ClusterRepo;
  readonly briefPlanRepo: BriefPlanRepo;
  readonly briefSnapshotRepo: BriefSnapshotRepo;
  readonly topicRepo: TopicRepo;
  readonly clock: Clock;
  readonly random: RandomSource;
}

export interface CreateBriefPlanInput {
  readonly topicId: TopicId;
  readonly userId: UserId;
  readonly maxClusters?: number;
}

export class BriefPlanService {
  constructor(private readonly deps: BriefPlanServiceDeps) {}

  async createPlan(input: CreateBriefPlanInput): Promise<BriefPlan> {
    const clusters = await this.deps.clusterRepo.listByTopicId(input.topicId);
    const activeClusters = clusters
      .filter((c) => c.state === 'active')
      .sort((a, b) => b.velocity - a.velocity || b.createdAt.getTime() - a.createdAt.getTime());

    const selected = input.maxClusters
      ? activeClusters.slice(0, input.maxClusters)
      : activeClusters.slice(0, 5);

    const clusterIds: ClusterId[] = selected.map((c) => c.id as ClusterId);

    const plan: BriefPlan = {
      id: this.deps.random.uuid(),
      topicId: input.topicId,
      userId: input.userId,
      createdAt: this.deps.clock.now(),
      clusterIds,
    };

    await this.deps.briefPlanRepo.insert(plan);
    return plan;
  }

  async createSnapshotFromPlan(
    plan: BriefPlan,
    html: string,
  ): Promise<BriefSnapshot> {
    const token = this.deps.random.uuid();
    const globalToken = this.deps.random.uuid();

    const snapshot: BriefSnapshot = {
      id: this.deps.random.uuid(),
      briefPlanId: plan.id,
      userId: plan.userId,
      topicId: plan.topicId,
      createdAt: this.deps.clock.now(),
      html,
      unsubscribeToken: token,
      globalUnsubscribeToken: globalToken,
    };

    await this.deps.briefSnapshotRepo.insert(snapshot);
    return snapshot;
  }
}
