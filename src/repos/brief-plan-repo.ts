import { and, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  briefPlans,
  type BriefPlanRow,
} from '../db/schema.js';
import type {
  BriefPlan,
  TopicId,
  UserId,
  ClusterId,
} from '../domain/types.js';

function rowToBriefPlan(row: BriefPlanRow): BriefPlan {
  return {
    id: row.id,
    topicId: row.topicId as TopicId,
    userId: row.userId as UserId,
    createdAt: new Date(row.createdAt),
    clusterIds: row.clusterIds
      ? (row.clusterIds.split(',').filter((s: string) => s.length > 0) as ClusterId[])
      : [],
  };
}

export interface BriefPlanRepo {
  insert(plan: BriefPlan): Promise<void>;
  findLatestByTopicId(topicId: string): Promise<BriefPlan | null>;
  listByUserId(userId: string): Promise<readonly BriefPlan[]>;
  /**
   * One plan, or null when there is none or it is not this User's. Scoped the
   * way `findByIdForUser` on snapshots is: the id arrives in a URL, so the
   * ownership check belongs to the lookup, not to a caller that might forget it.
   * The Cluster order is the order it was written in, so what a stored plan
   * answers is what was decided, never a fresh sort.
   */
  findByIdForUser(userId: string, id: string): Promise<BriefPlan | null>;
}

export class DrizzleBriefPlanRepo implements BriefPlanRepo {
  constructor(private readonly db: Db) {}

  async insert(plan: BriefPlan): Promise<void> {
    await this.db.insert(briefPlans).values({
      id: plan.id,
      topicId: plan.topicId,
      userId: plan.userId,
      createdAt: plan.createdAt,
      clusterIds: plan.clusterIds.join(','),
    });
  }

  async findLatestByTopicId(topicId: string): Promise<BriefPlan | null> {
    const rows = (await this.db
      .select()
      .from(briefPlans)
      .where(eq(briefPlans.topicId, topicId))
      .orderBy(briefPlans.createdAt)) as readonly BriefPlanRow[];
    const row = rows[rows.length - 1];
    return row ? rowToBriefPlan(row) : null;
  }

  async findByIdForUser(userId: string, id: string): Promise<BriefPlan | null> {
    const rows = (await this.db
      .select()
      .from(briefPlans)
      .where(and(eq(briefPlans.id, id), eq(briefPlans.userId, userId)))) as readonly BriefPlanRow[];
    const row = rows[0];
    return row ? rowToBriefPlan(row) : null;
  }

  async listByUserId(userId: string): Promise<readonly BriefPlan[]> {
    const rows = (await this.db
      .select()
      .from(briefPlans)
      .where(eq(briefPlans.userId, userId))
      .orderBy(briefPlans.createdAt)) as readonly BriefPlanRow[];
    return rows.map(rowToBriefPlan);
  }
}
