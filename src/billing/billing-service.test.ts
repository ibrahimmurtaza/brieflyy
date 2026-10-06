import { beforeEach, describe, expect, it } from 'vitest';

import { applySchema } from '../db/migrate.js';
import type { SqliteDriver } from '../db/client.js';
import type { PaymentEvent } from '../domain/payment.js';
import type { Account, User } from '../domain/types.js';
import { DrizzleBillingRepo } from '../repos/billing-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { countRows } from '../testing/db.js';
import { createTestDb } from '../testing/test-db.js';
import { makeAccount, makeUser } from '../testing/fixtures.js';
import { answeringWith, RECORDED_RENEWAL, RecordingPaymentProvider } from '../testing/payment-provider.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { BillingService, type PaymentEventOutcome } from './billing-service.js';

const NOW = new Date('2026-04-02T09:00:00Z');
const HOSTED = 'https://checkout.recording.test/pay/cs_recorded';

const IRIS: User = makeUser({ id: 'user-iris' });
const IRIS_ACCOUNT: Account = makeAccount({ id: 'account-iris', userId: 'user-iris' });

/** The event a completed payment arrives as, in the shape this repository sends one. */
const COMPLETED: Extract<PaymentEvent, { kind: 'checkout_completed' }> = {
  id: 'evt_1',
  kind: 'checkout_completed',
  reference: 'ref-1',
  subscriptionRef: 'sub_1',
  customerRef: 'cus_1',
};

/** When the double's Subscription says it renews, so the tests can name it too. */
const RENEWAL = RECORDED_RENEWAL;

let db: ReturnType<typeof createTestDb>['db'];
let driver: SqliteDriver;
let users: DrizzleUserRepo;
let service: BillingService;
let provider: RecordingPaymentProvider;

/**
 * A service over the same database, with a provider and a moment of the caller's
 * choosing.
 *
 * `null` rather than `undefined` for "no provider at all", because the default is
 * a working one and an omitted value cannot be told from an explicit absence —
 * which is exactly the distinction the no-provider tests are about. `at` is here
 * because one rule turns on where the clock is relative to a period's end, and a
 * test for it cannot be written against a clock that never moves.
 */
function aService(input: {
  readonly provider: RecordingPaymentProvider | null;
  readonly at?: Date;
}): BillingService {
  return new BillingService({
    repo: new DrizzleBillingRepo(db),
    userRepo: users,
    provider: input.provider ?? undefined,
    appBaseUrl: 'https://app.brieflyy.test',
    clock: makeTestClock(input.at ?? NOW).clock,
    random: deterministicRandom,
  });
}

beforeEach(async () => {
  resetDeterministic();
  const test = createTestDb();
  db = test.db;
  driver = test.driver;
  users = new DrizzleUserRepo(db);
  await users.insert(IRIS);
  provider = new RecordingPaymentProvider({ checkoutUrl: HOSTED });
  service = aService({ provider });
});

describe('starting a checkout', () => {
  it('records the reference before it asks the provider, so a completed one always resolves', async () => {
    // The order is the whole point: a provider that answered before the reference
    // was stored could send back a completed event naming something this
    // application has no record of, and the User would have paid for nothing.
    await service.startCheckout(IRIS, IRIS_ACCOUNT);

    const stored = await new DrizzleBillingRepo(db).findCheckoutReference(
      provider.checkouts[0]!.reference,
    );
    expect(stored?.userId).toBe('user-iris');
  });

  it('hands back where the provider says the User should pay', async () => {
    const outcome = await service.startCheckout(IRIS, IRIS_ACCOUNT);

    expect(outcome).toEqual({ status: 'started', url: HOSTED });
  });

  it('is unavailable on an instance with no payment provider', async () => {
    const bare = aService({ provider: null });

    expect(bare.checkoutAvailable()).toBe(false);
    expect(await bare.startCheckout(IRIS, IRIS_ACCOUNT)).toEqual({
      status: 'refused',
      reason: 'not_configured',
    });
  });

  it('says a provider that refused is unavailable rather than throwing', async () => {
    const refusing = aService({
      provider: new RecordingPaymentProvider({ refusing: true }),
    });

    expect(await refusing.startCheckout(IRIS, IRIS_ACCOUNT)).toEqual({
      status: 'refused',
      reason: 'unavailable',
    });
  });
});


describe('applying a payment event', () => {
  /** A Checkout started through the double, and the reference it was given. */
  async function aStartedCheckout(): Promise<string> {
    await service.startCheckout(IRIS, IRIS_ACCOUNT);
    return provider.checkouts[0]!.reference;
  }

  /**
   * Deliver an event through the seam, as a provider that has already verified it
   * would.
   *
   * `applySignedRequest` is the only way into the service — there is deliberately
   * no method that takes an event — so this is how a test hands one over at all,
   * and it is the same call the route makes.
   */
  async function deliver(event: PaymentEvent): Promise<PaymentEventOutcome> {
    const answering = aService({
      provider: new RecordingPaymentProvider({ event: answeringWith(event) }),
    });
    return answering.applySignedRequest({ body: '{}', signature: 't=1,v1=whatever' });
  }

  it('moves the User onto the paid tier and records what they are paying for', async () => {
    const reference = await aStartedCheckout();

    expect(await deliver({ ...COMPLETED, reference })).toEqual({
      status: 'accepted',
      kind: 'checkout_completed',
      userId: 'user-iris',
    });
    expect((await users.getById('user-iris'))?.tier).toBe('paid');
    expect(await service.subscriptionFor('user-iris')).toMatchObject({
      userId: 'user-iris',
      provider: 'recording',
      subscriptionRef: 'sub_1',
      customerRef: 'cus_1',
      startedAt: NOW,
    });
  });

  it('refuses a reference this application never issued, and changes nothing', async () => {
    expect(await deliver({ ...COMPLETED, reference: 'never-minted' })).toEqual({
      status: 'unknown_checkout',
      reference: 'never-minted',
    });
    expect((await users.getById('user-iris'))?.tier).toBe('free');
    expect(await service.subscriptionFor('user-iris')).toBeNull();
  });

  it('refuses a checkout whose User is gone, and changes nothing', async () => {
    // Not a separate answer from a reference Brieflyy never issued, because
    // `checkout_references.user_id` cascades: a deleted User takes the reference
    // with them, so the two cases are the same lookup finding nothing.
    const reference = await aStartedCheckout();
    await users.delete('user-iris');

    expect(await deliver({ ...COMPLETED, reference })).toEqual({
      status: 'unknown_checkout',
      reference,
    });
  });

  it('applies one event once, however many times it arrives', async () => {
    const reference = await aStartedCheckout();
    await deliver({ ...COMPLETED, reference });

    // A User moved back down, by the only means there is. The replay must not
    // undo it: the grant is the event, and the event happened once.
    await users.setTier('user-iris', 'free');

    expect(await deliver({ ...COMPLETED, reference })).toEqual({
      status: 'replayed',
      eventId: 'evt_1',
    });
    expect((await users.getById('user-iris'))?.tier).toBe('free');
  });

  it('grants on a retry after failing part-way, rather than losing the payment', async () => {
    const reference = await aStartedCheckout();
    // A real failure part-way through, caused by taking a table away rather than
    // by a double: a grant is three writes, and the receipt is the last of them.
    driver.exec('DROP TABLE subscriptions');

    await expect(deliver({ ...COMPLETED, reference })).rejects.toThrow();

    // The receipt was not written, so this event has not been applied and the
    // provider's next delivery still has it to apply. Recording the event before
    // the effect would have marked a payment spent for a User who never got the
    // tier, and the retry would have been answered as a replay.
    expect(countRows(driver, 'payment_events')).toBe(0);

    applySchema(driver);

    expect(await deliver({ ...COMPLETED, reference })).toEqual({
      status: 'accepted',
      kind: 'checkout_completed',
      userId: 'user-iris',
    });
    expect((await users.getById('user-iris'))?.tier).toBe('paid');
    expect(countRows(driver, 'payment_events')).toBe(1);
  });

  it('treats a second event for the same Checkout as a newer grant rather than a second subscription', async () => {
    // A User who checks out twice is one Subscription with the newer references on
    // it. Two rows would leave "which one is the User's subscription" with no
    // answer, and the unique index on the User is what gives it one.
    const reference = await aStartedCheckout();
    await deliver({ ...COMPLETED, reference });
    await deliver({ ...COMPLETED, id: 'evt_2', reference, subscriptionRef: 'sub_2' });

    expect((await service.subscriptionFor('user-iris'))?.subscriptionRef).toBe('sub_2');
  });

  it('starts the newer subscription paying, whatever the one it replaced was doing', async () => {
    // A User who cancels, waits, and checks out again is paying. Carrying the old
    // row's `cancelling` onto the new one would tell the page they had already
    // asked to stop the subscription they just paid for.
    const reference = await aStartedCheckout();
    await deliver({ ...COMPLETED, reference });
    await service.cancelSubscription(IRIS);
    await deliver({ ...COMPLETED, id: 'evt_2', reference, subscriptionRef: 'sub_2' });

    expect(await service.subscriptionFor('user-iris')).toMatchObject({
      subscriptionRef: 'sub_2',
      status: 'active',
      cancelledAt: null,
    });
  });
});
/**
 * A User on the paid tier with a Subscription recorded, by the only way in.
 *
 * One fixture for every half below, because "what a completed payment leaves behind"
 * is a fixture rather than the thing under test. It goes through a Checkout started
 * with the given provider and then an event delivered through `applySignedRequest`,
 * so the reference the event names is the one the provider was actually handed
 * rather than one written beside it.
 *
 * Returns the provider, so a test can see what the service then asked of it.
 */
async function aSubscriber(
  input: ConstructorParameters<typeof RecordingPaymentProvider>[0] = {},
): Promise<RecordingPaymentProvider> {
  const live = new RecordingPaymentProvider({
    ...input,
    subscription:
      input.subscription ??
      (() => ({ customerRef: 'cus_recorded', renewsAt: RENEWAL, cancelAtPeriodEnd: false })),
  });
  await aService({ provider: live }).startCheckout(IRIS, IRIS_ACCOUNT);
  await deliver({ ...COMPLETED, reference: live.checkouts[0]!.reference });
  return live;
}

/**
 * Deliver an event through the seam, as a provider that has already verified it
 * would.
 *
 * `applySignedRequest` is the only way into the service — there is deliberately no
 * method that takes an event — so this is how a test hands one over at all, and it
 * is the same call the route makes.
 */
async function deliver(event: PaymentEvent): Promise<PaymentEventOutcome> {
  const answering = aService({
    provider: new RecordingPaymentProvider({ event: answeringWith(event) }),
  });
  return answering.applySignedRequest({ body: '{}', signature: 't=1,v1=whatever' });
}

describe('a subscription that has ended', () => {
  it('moves the User back down and records the Subscription as over', async () => {
    await aSubscriber();

    // Without this, an application that only ever hears about a payment completing
    // can put a User onto the paid tier and has no way at all to take them off it.
    const ENDED: PaymentEvent = {
      id: 'evt_9',
      kind: 'subscription_ended',
      subscriptionRef: 'sub_1',
      customerRef: 'cus_1',
    };
    expect(await deliver(ENDED)).toEqual({
      status: 'accepted',
      kind: 'subscription_ended',
      userId: 'user-iris',
    });
    expect((await users.getById('user-iris'))?.tier).toBe('free');
    expect(await service.subscriptionFor('user-iris')).toMatchObject({ status: 'ended' });
  });

  it('refuses a Subscription this application never recorded, and changes nothing', async () => {
    await aSubscriber();

    // Which is also the answer for a Subscription a User has since replaced with a
    // newer Checkout: the old one ending must not move somebody who has paid again.
    expect(
      await deliver({
        id: 'evt_9',
        kind: 'subscription_ended',
        subscriptionRef: 'sub_somebody_else',
        customerRef: 'cus_9',
      }),
    ).toEqual({ status: 'unknown_subscription', subscriptionRef: 'sub_somebody_else' });
    expect((await users.getById('user-iris'))?.tier).toBe('paid');
    expect(await service.subscriptionFor('user-iris')).toMatchObject({ status: 'active' });
  });

  it('applies one cancellation once, however many times it arrives', async () => {
    await aSubscriber();
    const ended: PaymentEvent = {
      id: 'evt_9',
      kind: 'subscription_ended',
      subscriptionRef: 'sub_1',
      customerRef: 'cus_1',
    };
    await deliver(ended);

    // Back onto the paid tier by the only means there is, to show the replay does
    // not undo it: the ending happened once.
    await users.setTier('user-iris', 'paid');

    expect(await deliver(ended)).toEqual({ status: 'replayed', eventId: 'evt_9' });
    expect((await users.getById('user-iris'))?.tier).toBe('paid');
  });
});

describe('stating the subscription state of a User', () => {
  it('answers that a User with no stored billing state has nothing to say', async () => {
    // The arrival a User with no subscription makes, which is most of them. It is
    // an answer and not a failure: there is no row to read, and that is the fact.
    expect(await service.subscriptionStateFor(IRIS)).toEqual({ kind: 'none' });
    expect(provider.checkouts).toEqual([]);
  });

  it('names the plan, when it renews, and that it is still paying', async () => {
    await aSubscriber();

    expect(await service.subscriptionStateFor(IRIS)).toEqual({
      kind: 'known',
      freshness: 'asked',
      subscription: {
        id: expect.any(String),
        userId: 'user-iris',
        provider: 'recording',
        subscriptionRef: 'sub_1',
        customerRef: 'cus_recorded',
        startedAt: NOW,
        status: 'active',
        renewsAt: RENEWAL,
        cancelledAt: null,
      },
    });
  });

  it('asks the provider only while the stored date cannot be the answer', async () => {
    const live = await aSubscriber();
    const asking = aService({ provider: live });

    // The first read has nothing stored, so it has to ask; the second has a renewal
    // date, and a date in the future *is* the next charge — so it does not. That is
    // the property ADR-0023 promised and asking on every visit would break: reading
    // what a User is paying for is a read of the database.
    expect(await asking.subscriptionStateFor(IRIS)).toMatchObject({ freshness: 'asked' });
    expect(live.reads).toHaveLength(1);

    expect(await asking.subscriptionStateFor(IRIS)).toMatchObject({
      freshness: 'recorded',
      subscription: { renewsAt: RENEWAL },
    });
    expect(live.reads, 'a page view reached the payment provider').toHaveLength(1);
  });

  it('asks again once the stored date has passed, because the period has moved on', async () => {
    const nextPeriod = new Date('2026-07-01T09:00:00Z');
    const live = await aSubscriber({
      subscription: () => ({ customerRef: 'cus_recorded', renewsAt: nextPeriod, cancelAtPeriodEnd: false }),
    });
    await aService({ provider: live }).subscriptionStateFor(IRIS);
    expect((await service.subscriptionFor('user-iris'))?.renewsAt).toEqual(nextPeriod);

    // Past the recorded date the answer has moved somewhere only the provider knows,
    // so this is the read that has to reach out — and what it gets is written down
    // in place of the one that has expired.
    const later = aService({ provider: live, at: new Date('2026-08-01T09:00:00Z') });
    expect(await later.subscriptionStateFor(IRIS)).toMatchObject({ freshness: 'asked' });
    expect(live.reads).toHaveLength(2);
    expect((await service.subscriptionFor('user-iris'))?.renewsAt).toEqual(nextPeriod);
  });

  it('keeps what is stored when the provider cannot be asked, and says so', async () => {
    const live = await aSubscriber({ unreachable: true });
    const stalled = aService({ provider: live });

    // Somebody else's service not answering is not a fact about the Subscription.
    // Overwriting the stored row with a guess would leave a User with a renewal date
    // this application made up.
    expect(await stalled.subscriptionStateFor(IRIS)).toMatchObject({
      kind: 'known',
      freshness: 'unreachable',
      subscription: { status: 'active', renewsAt: null },
    });
  });

  it('never asks the provider about a Subscription that has ended', async () => {
    const live = await aSubscriber();
    await deliver({
      id: 'evt_ended',
      kind: 'subscription_ended',
      subscriptionRef: 'sub_1',
      customerRef: 'cus_1',
    });
    const after = aService({ provider: live, at: new Date('2026-06-01T09:00:00Z') });

    // `ended` is a settled fact rather than an absence, which is what separates it
    // from every other reason to read the provider. The period is over, the provider
    // will never hold this Subscription again, and a User who wants to pay again
    // mints a new one. Asking on every visit would put somebody else's API between a
    // User and a page they can open any number of times, and would write the same
    // row back every time — the failure ADR-0024 rules out by name.
    expect(await after.subscriptionStateFor(IRIS)).toMatchObject({
      kind: 'known',
      freshness: 'recorded',
      subscription: { status: 'ended' },
    });
    expect(await after.subscriptionStateFor(IRIS)).toMatchObject({ freshness: 'recorded' });
    expect(live.reads, 'a page view reached the payment provider').toEqual([]);
    expect((await service.subscriptionFor('user-iris'))?.status).toBe('ended');
  });

  it('still asks about a cancelled Subscription whose period has run out, and ends it when the provider has let it go', async () => {
    const live = await aSubscriber();
    await aService({ provider: live }).cancelSubscription(IRIS);

    // A provider that has stopped holding it, which is where a `cancelling` row
    // ends up when the signed event that settles it is missed — and the state the
    // application would otherwise hold forever, because a promise about a date is
    // not a fact and only the provider can convert it.
    const gone = new RecordingPaymentProvider({ unknownSubscription: true });
    const after = aService({ provider: gone, at: new Date('2026-06-01T09:00:00Z') });

    expect(await after.subscriptionStateFor(IRIS)).toMatchObject({
      kind: 'known',
      freshness: 'asked',
      subscription: { status: 'ended' },
    });
    expect(gone.reads).toHaveLength(1);
    expect((await service.subscriptionFor('user-iris'))?.status).toBe('ended');
  });

  it('reads a Subscription the provider no longer holds as one that has ended', async () => {
    await aSubscriber();
    const forgetting = aService({
      provider: new RecordingPaymentProvider({ unknownSubscription: true }),
    });

    // Reached through a provider whose own answer is `unknown`, because "the
    // provider holds no such Subscription" is a fact only it can report.
    expect(await forgetting.subscriptionStateFor(IRIS)).toMatchObject({
      kind: 'known',
      freshness: 'asked',
      subscription: { status: 'ended' },
    });
    // The tier is not moved by a page read. The page a User is looking at must not
    // be the thing that takes their plan away; the provider's signed event is.
    expect((await users.getById('user-iris'))?.tier).toBe('paid');
  });

  it('leaves a stored Subscription standing on an instance with no provider', async () => {
    await aSubscriber();

    // Still true: the row is what happened, and a deployment with no provider
    // configured cannot make it untrue.
    expect(await aService({ provider: null }).subscriptionStateFor(IRIS)).toMatchObject({
      kind: 'known',
      freshness: 'recorded',
      subscription: { status: 'active' },
    });
  });
});

describe('stopping a subscription', () => {
  it('reaches the provider, and records what it then said', async () => {
    const live = await aSubscriber();
    const stopping = aService({ provider: live });

    expect(await stopping.cancelSubscription(IRIS)).toEqual({
      status: 'stopping',
      endsAt: RENEWAL,
    });
    expect(live.cancellations).toEqual([{ subscriptionRef: 'sub_1' }]);
    expect(await stopping.subscriptionFor('user-iris')).toMatchObject({
      status: 'cancelling',
      cancelledAt: NOW,
      renewsAt: RENEWAL,
    });
  });

  it('leaves the User on the paid plan until the period they paid for is up', async () => {
    const live = await aSubscriber();

    // The whole meaning of a cancellation: the next charge stops, and the days
    // already paid for do not disappear with it.
    await aService({ provider: live }).cancelSubscription(IRIS);
    expect((await users.getById('user-iris'))?.tier).toBe('paid');
  });

  it('records the period as already stopping rather than asking the provider twice', async () => {
    const live = await aSubscriber();
    const stopping = aService({ provider: live });
    await stopping.cancelSubscription(IRIS);

    expect(await stopping.cancelSubscription(IRIS)).toEqual({
      status: 'already_stopped',
      endsAt: RENEWAL,
    });
    expect(live.cancellations).toHaveLength(1);
  });

  it('reports a Subscription the provider has already finished as already stopped', async () => {
    // The two answers are opposites of each other in what they tell the User: one
    // says the charge has stopped, the other says it will keep coming. Announcing
    // this one as the second would be the single thing on this page that could not
    // be further from the truth.
    const live = await aSubscriber({ unknownSubscription: true });
    const stopping = aService({ provider: live });

    expect(await stopping.cancelSubscription(IRIS)).toEqual({
      status: 'already_stopped',
      endsAt: null,
    });
    expect(await stopping.subscriptionFor('user-iris')).toMatchObject({ status: 'ended' });
  });

  it('changes nothing at all when the provider could not be reached', async () => {
    const live = await aSubscriber({ refusingCancellation: true });
    const stopping = aService({ provider: live });

    // A cancellation recorded as asked for without the provider having been told
    // would be a Subscription that keeps charging and reads as stopped.
    expect(await stopping.cancelSubscription(IRIS)).toEqual({ status: 'unavailable' });
    expect(await stopping.subscriptionFor('user-iris')).toMatchObject({
      status: 'active',
      cancelledAt: null,
    });
  });

  it('has nothing to stop for a User who is not paying for anything', async () => {
    expect(await service.cancelSubscription(IRIS)).toEqual({ status: 'nothing_to_stop' });
    expect(provider.cancellations).toEqual([]);
  });

  it('says so on an instance with no payment provider', async () => {
    await aSubscriber();

    // The row exists and the provider does not. Saying so is what keeps the page
    // from offering a control that could not work — the same rule the Google
    // sign-in page follows (ADR-0019).
    expect(await aService({ provider: null }).cancelSubscription(IRIS)).toEqual({
      status: 'not_configured',
    });
  });
});

describe('reading a signed request', () => {
  it('acts on what the provider read, and not on the body it was handed', async () => {
    // The double answers with a fixed event whatever it is given, so the event it
    // names is unresolvable and nothing is written — which is the point: the body
    // and the signature in this request were never consulted for anything.
    const answering = aService({
      provider: new RecordingPaymentProvider({ event: answeringWith(COMPLETED) }),
    });

    const outcome = await answering.applySignedRequest({
      body: JSON.stringify({ client_reference_id: 'in-the-body' }),
      signature: 't=1,v1=whatever',
    });

    expect(outcome).toEqual({ status: 'unknown_checkout', reference: 'ref-1' });
    expect((await users.getById('user-iris'))?.tier).toBe('free');
  });

  it('refuses everything on an instance with no payment provider', async () => {
    expect(
      await aService({ provider: null }).applySignedRequest({ body: '{}', signature: 'x' }),
    ).toEqual({ status: 'not_configured' });
  });
});
