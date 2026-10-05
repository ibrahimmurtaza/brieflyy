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
import { answeringWith, RecordingPaymentProvider } from '../testing/payment-provider.js';
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

const COMPLETED: PaymentEvent = {
  id: 'evt_1',
  kind: 'checkout_completed',
  reference: 'ref-1',
  subscriptionRef: 'sub_1',
  customerRef: 'cus_1',
};

let db: ReturnType<typeof createTestDb>['db'];
let driver: SqliteDriver;
let users: DrizzleUserRepo;
let service: BillingService;
let provider: RecordingPaymentProvider;

/**
 * A service over the same database, with a provider of the caller's choosing.
 *
 * `null` rather than `undefined` for "no provider at all", because the default is
 * a working one and an omitted value cannot be told from an explicit absence —
 * which is exactly the distinction the no-provider tests are about.
 */
function aService(input: { readonly provider: RecordingPaymentProvider | null }): BillingService {
  return new BillingService({
    repo: new DrizzleBillingRepo(db),
    userRepo: users,
    provider: input.provider ?? undefined,
    appBaseUrl: 'https://app.brieflyy.test',
    clock: makeTestClock(NOW).clock,
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