import { eq } from 'drizzle-orm';

import type { Db } from '../db/client.js';
import {
  checkoutReferences,
  paymentEvents,
  subscriptions,
  type CheckoutReferenceRow,
  type PaymentEventRow,
  type SubscriptionRow,
} from '../db/schema.js';
import type {
  CheckoutReference,
  RecordedPaymentEvent,
  Subscription,
  UserId,
} from '../domain/types.js';

function rowToReference(row: CheckoutReferenceRow): CheckoutReference {
  return {
    reference: row.reference,
    userId: row.userId as UserId,
    createdAt: row.createdAt,
  };
}

function rowToSubscription(row: SubscriptionRow): Subscription {
  return {
    id: row.id,
    userId: row.userId as UserId,
    provider: row.provider,
    subscriptionRef: row.subscriptionRef,
    customerRef: row.customerRef,
    startedAt: row.startedAt,
    status: row.status,
    renewsAt: row.renewsAt,
    cancelledAt: row.cancelledAt,
  };
}

export interface BillingRepo {
  /** Record a Checkout this application started. */
  insertCheckoutReference(reference: CheckoutReference): Promise<void>;
  /**
   * The User a Checkout reference belongs to, or null for a reference Brieflyy
   * never issued.
   *
   * Null is the refusal and not an error, because it is the answer for a signed
   * event naming a reference this application has no record of — which is what a
   * validly signed event about somebody else's Checkout looks like from here.
   */
  findCheckoutReference(reference: string): Promise<CheckoutReference | null>;
  /**
   * Record that an event has been acted on.
   *
   * Throws when the provider's id has been recorded before, because the primary
   * key on `payment_events.id` *is* the single-use property — the service treats
   * that failure as a replay rather than re-deriving it from a read that two
   * concurrent deliveries could both pass.
   */
  insertPaymentEvent(event: RecordedPaymentEvent): Promise<void>;
  /** The event this provider id names, or null when it has never been acted on. */
  findPaymentEvent(id: string): Promise<RecordedPaymentEvent | null>;
  /**
   * Write what a User is paying for, replacing any row they already had.
   *
   * An upsert because a second Checkout completes for a User who is already
   * subscribed, and the second event is the newer answer rather than a second
   * subscription. It replaces the whole row rather than merging into it, so what
   * comes back describes what they are paying for *now*: a User who cancels and
   * then checks out again is paying, not cancelling.
   */
  saveSubscription(subscription: Subscription): Promise<void>;
  /** What a User is paying for, or null while they are paying for nothing. */
  findSubscriptionForUser(userId: UserId): Promise<Subscription | null>;
  /**
   * The Subscription a provider event names, or null when this application holds
   * no such row.
   *
   * The lookup a `subscription_ended` is resolved through, and it is by the
   * provider's own name for the subscription rather than by the User, because such
   * an event carries no Checkout reference and nothing else in it names a User.
   *
   * Null is also the answer for a Subscription that has since been replaced by a
   * newer Checkout, and it has to be: an old subscription ending must not move a
   * User down who has paid again since.
   */
  findSubscriptionByProviderRef(subscriptionRef: string): Promise<Subscription | null>;
}

/**
 * The billing layer's own persistence.
 *
 * Three things, all of them in the payment provider's vocabulary rather than the
 * application's: a value Brieflyy minted and can recognise, an event it was told
 * about once, and what a User is paying for. Kept apart from `UserRepo` because
 * `users.tier` is the fact every paywall reads and these are the record behind it —
 * a repository that held both would be one place to look for a fact the rest of
 * the application has no use for.
 */
export class DrizzleBillingRepo implements BillingRepo {
  constructor(private readonly db: Db) {}

  async insertCheckoutReference(reference: CheckoutReference): Promise<void> {
    await this.db.insert(checkoutReferences).values({
      reference: reference.reference,
      userId: reference.userId,
      createdAt: reference.createdAt,
    });
  }

  async findCheckoutReference(reference: string): Promise<CheckoutReference | null> {
    const rows = (await this.db
      .select()
      .from(checkoutReferences)
      .where(eq(checkoutReferences.reference, reference))) as readonly CheckoutReferenceRow[];
    return rows[0] ? rowToReference(rows[0]) : null;
  }

  async insertPaymentEvent(event: RecordedPaymentEvent): Promise<void> {
    await this.db.insert(paymentEvents).values({
      id: event.id,
      userId: event.userId,
      kind: event.kind,
      receivedAt: event.receivedAt,
    });
  }

  async findPaymentEvent(id: string): Promise<RecordedPaymentEvent | null> {
    const rows = (await this.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.id, id))) as readonly PaymentEventRow[];
    const row = rows[0];
    return row
      ? {
          id: row.id,
          userId: row.userId as UserId,
          kind: row.kind,
          receivedAt: row.receivedAt,
        }
      : null;
  }

  async saveSubscription(subscription: Subscription): Promise<void> {
    const row = {
      userId: subscription.userId,
      provider: subscription.provider,
      subscriptionRef: subscription.subscriptionRef,
      customerRef: subscription.customerRef,
      startedAt: subscription.startedAt,
      status: subscription.status,
      renewsAt: subscription.renewsAt,
      cancelledAt: subscription.cancelledAt,
    };
    // An update that returns the row it changed, so "was there one" is answered by
    // the same statement rather than by a read that a concurrent write could slip
    // between. The insert then only happens when there genuinely was nothing.
    const updated = await this.db
      .update(subscriptions)
      .set(row)
      .where(eq(subscriptions.userId, subscription.userId))
      .returning({ id: subscriptions.id });
    if (updated.length > 0) return;
    await this.db.insert(subscriptions).values({ id: subscription.id, ...row });
  }

  async findSubscriptionForUser(userId: UserId): Promise<Subscription | null> {
    const rows = (await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.userId, userId))) as readonly SubscriptionRow[];
    return rows[0] ? rowToSubscription(rows[0]) : null;
  }

  async findSubscriptionByProviderRef(
    subscriptionRef: string,
  ): Promise<Subscription | null> {
    const rows = (await this.db
      .select()
      .from(subscriptions)
      .where(eq(subscriptions.subscriptionRef, subscriptionRef))) as readonly SubscriptionRow[];
    return rows[0] ? rowToSubscription(rows[0]) : null;
  }
}