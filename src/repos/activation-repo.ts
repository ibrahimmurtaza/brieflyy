import { and, eq, gte, lte, sql } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import { emailDeliveries, users } from '../db/schema.js';

/**
 * How long a User has to receive their first brief and count as activated.
 *
 * A day rather than a shorter window because a brief goes out at the User's own
 * DeliveryTime, which is a time of day they chose and could be later than any
 * earlier one; a first brief the morning after signing up is the ordinary case
 * rather than a slow one. The glossary's "within a day of signing up" is this
 * number, and it is reported alongside the measure rather than left to the reader
 * to assume.
 */
export const ACTIVATION_WINDOW_MS = 24 * 60 * 60 * 1000;

/** The same window in the unit the surfaces report it in. */
export const ACTIVATION_WINDOW_HOURS = ACTIVATION_WINDOW_MS / (60 * 60 * 1000);

export interface ActivationMeasure {
  /**
   * How many Users received their first brief within the window of signing up.
   *
   * One per User, however many briefs arrived inside it: the thing being counted
   * is a User who got a brief, not a brief.
   */
  readonly activated: number;
  /**
   * Every User, which is the denominator the count above is a part of.
   *
   * Carried rather than left to the reader because a bare count of activated
   * Users cannot be read: three of three and three of three hundred are the same
   * three, and an operator can only tell them apart from how many there were.
   */
  readonly signedUp: number;
  /**
   * The window `activated` was measured over.
   *
   * Part of the answer rather than a constant behind it: a count of Users is only
   * a fact about a period, and a reader handed the count alone has to guess which.
   */
  readonly windowHours: number;
}

export interface ActivationRepo {
  /**
   * How many Users have been activated, and how many there are to have been.
   *
   * Read off what the application already stores — when each User signed up, and
   * when the transport took their first brief — rather than off a row written to
   * be counted. A stored activation would be a second record of an arrival the
   * EmailDelivery already holds, and it would be a record that can disagree with
   * it: a pass that died between sending and writing would leave the counter
   * behind the inbox, which is the failure this measure exists to catch.
   */
  measure(): Promise<ActivationMeasure>;
}

interface MeasureRow {
  readonly signedUp: number;
  readonly activated: number;
}

export class DrizzleActivationRepo implements ActivationRepo {
  constructor(private readonly db: Db) {}

  async measure(): Promise<ActivationMeasure> {
    // The first brief per User that the transport actually took, collapsed in SQL
    // rather than read out row by row, because the measure is one number over
    // every User and a User's briefs are many rows.
    const firstSentBrief = this.db
      .select({
        userId: emailDeliveries.userId,
        // Aliased, because it is a raw aggregate rather than a column: the outer
        // query reads it by name off the subquery.
        sentAt: sql<number>`MIN(${emailDeliveries.sentAt})`.as('sent_at'),
      })
      .from(emailDeliveries)
      // Only what the provider took. A refusal reached nobody and an `unknown` is
      // Brieflyy saying it does not know, so neither is a User who received a
      // brief — and a User is judged by the first such delivery, which is not
      // necessarily their first attempt.
      .where(eq(emailDeliveries.outcome, 'sent'))
      .groupBy(emailDeliveries.userId)
      .as('first_sent_brief');

    const rows = (await this.db
      .select({
        signedUp: sql<number>`COUNT(*)`,
        // How many Users got a row from the join, which is how many have a first
        // sent brief inside the window. A User with no sent brief at all has none,
        // and a User whose first one landed outside the window has none either —
        // in both cases the left join leaves `first_sent_brief.user_id` null and
        // `COUNT` of a column skips it. Both ends of the window are in the join
        // rather than in a CASE over every User, because a User is either inside
        // the window or not: the end is included, so a brief landing exactly on it
        // is within a day of signing up, and the start is too, because a brief
        // that arrived before the User row was written is not an arrival within a
        // day of signing up at all.
        activated: sql<number>`COUNT(${firstSentBrief.userId})`,
      })
      .from(users)
      // From `users` rather than from the deliveries, so a signed-up User who has
      // had no brief is in `signedUp` and absent from `activated` rather than
      // invisible in both.
      .leftJoin(
        firstSentBrief,
        and(
          eq(firstSentBrief.userId, users.id),
          gte(firstSentBrief.sentAt, users.createdAt),
          lte(firstSentBrief.sentAt, sql`${users.createdAt} + ${ACTIVATION_WINDOW_MS}`),
        ),
      )) as readonly MeasureRow[];

    const row = rows[0];
    // Both aggregates are `COUNT`, so neither is ever null — but an installation
    // nobody has signed up for gets no row at all, and a measure that reports one
    // half of itself as absent and the other as zero is one a reader has to
    // interpret rather than read.
    return {
      activated: Number(row?.activated ?? 0),
      signedUp: Number(row?.signedUp ?? 0),
      windowHours: ACTIVATION_WINDOW_HOURS,
    };
  }
}
