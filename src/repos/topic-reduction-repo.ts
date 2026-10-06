import { asc, eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { topicReductions, type TopicReductionRow } from '../db/schema.js';
import type { TopicId, TopicReduction, UserId } from '../domain/types.js';

function rowToReduction(row: TopicReductionRow): TopicReduction {
  return {
    id: row.id,
    userId: row.userId as UserId,
    cap: row.cap,
    held: row.held,
    keptTopicIds: parseTopicIds(row.keptTopicIds),
    stoppedTopicIds: parseTopicIds(row.stoppedTopicIds),
    answeredAt: row.answeredAt,
  };
}

/**
 * The Ids a column holds, in the order it stored them.
 *
 * Anything that is not an array of strings reads back as none rather than throwing:
 * the column is written only by the method below, so a value here that is not one
 * is a row some other build left, and a page that shows an answer must not be the
 * thing that fails.
 */
function parseTopicIds(raw: string): readonly TopicId[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is TopicId => typeof id === 'string');
  } catch {
    return [];
  }
}

export interface TopicReductionRepo {
  /**
   * Record the answer a User gave, once they have given it.
   *
   * Never updated: a second answer is a second row, because a User who pays again
   * and then stops paying is deciding twice rather than correcting themselves.
   */
  insert(reduction: TopicReduction): Promise<void>;
  /**
   * Every answer this User has given, oldest first.
   *
   * Read on one request path, and only for whether there is any answer at all — the
   * page uses it to refuse to announce an answer the User never gave. What they hold
   * is not read back, because what a User is over their cap by is derived from their
   * tier and their Topics: an unanswered state has no row to go stale.
   */
  findForUser(userId: UserId): Promise<readonly TopicReduction[]>;
}

/**
 * What a User answered when they were asked which of their Topics to stop.
 *
 * Its own file rather than a method on `BillingRepo`, because that one is documented
 * as the record behind `users.tier` — what a User is paying for, in the provider's
 * vocabulary — and a decision about Topics is in neither that vocabulary nor
 * `TopicRepo`'s, whose rows are the settings of a Topic and the Topics a User holds.
 */
export class DrizzleTopicReductionRepo implements TopicReductionRepo {
  constructor(private readonly db: Db) {}

  async insert(reduction: TopicReduction): Promise<void> {
    await this.db.insert(topicReductions).values({
      id: reduction.id,
      userId: reduction.userId,
      cap: reduction.cap,
      held: reduction.held,
      keptTopicIds: JSON.stringify(reduction.keptTopicIds),
      stoppedTopicIds: JSON.stringify(reduction.stoppedTopicIds),
      answeredAt: reduction.answeredAt,
    });
  }

  async findForUser(userId: UserId): Promise<readonly TopicReduction[]> {
    const rows = (await this.db
      .select()
      .from(topicReductions)
      .where(eq(topicReductions.userId, userId))
      .orderBy(asc(topicReductions.answeredAt))) as readonly TopicReductionRow[];
    return rows.map(rowToReduction);
  }
}
