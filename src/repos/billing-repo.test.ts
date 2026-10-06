import { beforeEach, describe, expect, it } from 'vitest';

import type { Db, SqliteDriver } from '../db/client.js';
import { subscriptions } from '../db/schema.js';
import { countRows } from '../testing/db.js';
import { createTestDb } from '../testing/test-db.js';
import { makeUser } from '../testing/fixtures.js';
import { DrizzleUserRepo } from './user-repo.js';
import { DrizzleBillingRepo } from './billing-repo.js';
import type { CheckoutReference, RecordedPaymentEvent, Subscription } from '../domain/types.js';

const NOW = new Date('2026-05-04T10:00:00Z');

function makeHarness(): {
  readonly db: Db;
  readonly driver: SqliteDriver;
  readonly repo: DrizzleBillingRepo;
} {
  const { db, driver } = createTestDb();
  return { db, driver, repo: new DrizzleBillingRepo(db) };
}

function aCheckout(userId = 'user-1'): CheckoutReference {
  return { reference: 'ref-1', userId, createdAt: NOW };
}

function aSubscription(userId = 'user-1', subscriptionRef = 'sub_1'): Subscription {
  return {
    id: 'subscription-1',
    userId,
    provider: 'stripe',
    subscriptionRef,
    customerRef: 'cus_1',
    startedAt: NOW,
    status: 'active',
    renewsAt: null,
    cancelledAt: null,
  };
}

function anEvent(id = 'evt_1'): RecordedPaymentEvent {
  return { id, userId: 'user-1', kind: 'checkout_completed', receivedAt: NOW };
}

let db: Db;
let driver: SqliteDriver;
let repo: DrizzleBillingRepo;
let users: DrizzleUserRepo;

beforeEach(async () => {
  const harness = makeHarness();
  db = harness.db;
  driver = harness.driver;
  repo = harness.repo;
  users = new DrizzleUserRepo(db);
  await users.insert(makeUser({ id: 'user-1' }));
});

describe('checkout references', () => {
  it('reads back the User a minted reference belongs to', async () => {
    await repo.insertCheckoutReference(aCheckout());

    expect(await repo.findCheckoutReference('ref-1')).toEqual(aCheckout());
  });

  it('has no answer for a reference it never issued', async () => {
    expect(await repo.findCheckoutReference('ref-1')).toBeNull();
  });

  it('takes the references away with the User they belong to', async () => {
    await repo.insertCheckoutReference(aCheckout());
    await users.delete('user-1');

    expect(await repo.findCheckoutReference('ref-1')).toBeNull();
  });

  it('refuses the same reference twice', async () => {
    await repo.insertCheckoutReference(aCheckout());

    await expect(repo.insertCheckoutReference(aCheckout('user-2'))).rejects.toThrow();
  });
});

describe('payment events', () => {
  it('reads back an event it recorded, so a replay can be recognised', async () => {
    await repo.insertPaymentEvent(anEvent());

    expect(await repo.findPaymentEvent('evt_1')).toEqual(anEvent());
  });

  it('has no answer for an event it has never been given', async () => {
    expect(await repo.findPaymentEvent('evt_1')).toBeNull();
  });

  it('refuses the same event twice, which is what makes one event one grant', async () => {
    await repo.insertPaymentEvent(anEvent());

    // The insert failing is the whole single-use property. A service that read
    // first and then wrote would have a window between the two, and two
    // deliveries landing in it would both grant.
    await expect(repo.insertPaymentEvent(anEvent())).rejects.toThrow();
  });
});

describe('subscriptions', () => {
  it('reads back what a User is paying for', async () => {
    await repo.saveSubscription(aSubscription());

    expect(await repo.findSubscriptionForUser('user-1')).toEqual(aSubscription());
  });

  it('has nothing for a User who is paying for nothing', async () => {
    expect(await repo.findSubscriptionForUser('user-1')).toBeNull();
  });

  it('holds one row per User however many times one is saved', async () => {
    await repo.saveSubscription(aSubscription());
    await repo.saveSubscription({ ...aSubscription('user-1', 'sub_2'), id: 'subscription-2' });

    const stored = await repo.findSubscriptionForUser('user-1');
    expect(stored?.subscriptionRef).toBe('sub_2');
    expect(countRows(driver, 'subscriptions')).toBe(1);
  });

  it('refuses a second row for one User, so the index is the single-subscription rule', async () => {
    await repo.saveSubscription(aSubscription());

    // Checked by the database refusing rather than by the service remembering to
    // look: "one Subscription per User" is the unique index, and anything else
    // saying it would be a second statement of the same rule that could drift.
    await expect(
      db.insert(subscriptions).values({
        id: 'subscription-2',
        userId: 'user-1',
        provider: 'stripe',
        subscriptionRef: 'sub_2',
        customerRef: 'cus_2',
        startedAt: NOW,
        status: 'active',
        renewsAt: null,
        cancelledAt: null,
      }),
    ).rejects.toThrow();
  });

  it('reads back the period a Subscription is in and the dates around it', async () => {
    // The whole point of the row: "paying", "told to stop" and "stopped" have to
    // survive a round trip, or the page that states them states nothing.
    await repo.saveSubscription({
      ...aSubscription(),
      status: 'cancelling',
      renewsAt: new Date('2026-06-04T10:00:00Z'),
      cancelledAt: new Date('2026-05-20T08:00:00Z'),
    });

    expect(await repo.findSubscriptionForUser('user-1')).toMatchObject({
      status: 'cancelling',
      renewsAt: new Date('2026-06-04T10:00:00Z'),
      cancelledAt: new Date('2026-05-20T08:00:00Z'),
    });
  });

  it('reads the row back as the newer subscription when a second Checkout lands', async () => {
    // The row is what this User is paying for now, not a history of what they have
    // paid for: a User who cancels and then checks out again is paying, so the row
    // says paying. The cancellation they asked for belongs to the subscription that
    // was replaced, and it is recorded on the event that asked for it.
    await repo.saveSubscription({
      ...aSubscription(),
      status: 'cancelling',
      renewsAt: new Date('2026-06-04T10:00:00Z'),
      cancelledAt: new Date('2026-05-20T08:00:00Z'),
    });
    await repo.saveSubscription({ ...aSubscription('user-1', 'sub_2'), id: 'subscription-2' });

    expect(await repo.findSubscriptionForUser('user-1')).toMatchObject({
      subscriptionRef: 'sub_2',
      status: 'active',
      cancelledAt: null,
    });
  });

  it('finds a Subscription by the name the provider gives it', async () => {
    // The only way a `subscription_ended` finds its User: such an event names no
    // Checkout reference, because the Checkout was months ago.
    await repo.saveSubscription(aSubscription('user-1', 'sub_iris'));

    expect(await repo.findSubscriptionByProviderRef('sub_iris')).toEqual(aSubscription('user-1', 'sub_iris'));
  });

  it('has nothing for a Subscription the provider names but this application never recorded', async () => {
    await repo.saveSubscription(aSubscription('user-1', 'sub_iris'));

    expect(await repo.findSubscriptionByProviderRef('sub_somebody_else')).toBeNull();
  });
});