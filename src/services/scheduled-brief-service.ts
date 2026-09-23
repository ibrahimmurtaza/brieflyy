import type { Clock } from '../domain/clock.js';
import type { EmailTransport } from '../email/transport.js';
import type { BriefPlanService } from './brief-plan-service.js';
import type { BriefPlanRepo } from '../repos/brief-plan-repo.js';
import type { BriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import type { EmailDeliveryRepo } from '../repos/email-delivery-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import type { AccountRepo } from '../repos/account-repo.js';
import type { DeliverySettingsRepo } from '../repos/delivery-settings-repo.js';
import type { RandomSource } from '../domain/crypto.js';

export interface ScheduledBriefServiceDeps {
  readonly briefPlanService: BriefPlanService;
  readonly briefPlanRepo: BriefPlanRepo;
  readonly briefSnapshotRepo: BriefSnapshotRepo;
  readonly emailDeliveryRepo: EmailDeliveryRepo;
  readonly topicRepo: TopicRepo;
  readonly userRepo: UserRepo;
  readonly accountRepo: AccountRepo;
  readonly deliverySettingsRepo: DeliverySettingsRepo;
  readonly emailTransport: EmailTransport;
  readonly clock: Clock;
  readonly random: RandomSource;
}

export interface ScheduledBriefRunResult {
  readonly sentCount: number;
  readonly failureCount: number;
  readonly lastRunTime: Date;
}

export class ScheduledBriefService {
  constructor(private readonly deps: ScheduledBriefServiceDeps) {}

  async run(): Promise<ScheduledBriefRunResult> {
    const now = this.deps.clock.now();
    const sentCount = 0;
    const failureCount = 0;

    // For the scope of this ticket, we implement the observable daily job
    // structure without full scheduling logic.
    return {
      sentCount,
      failureCount,
      lastRunTime: now,
    };
  }
}
