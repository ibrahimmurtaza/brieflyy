import { beforeEach, describe, expect, it } from 'vitest';

import type { PaymentEvent } from '../domain/payment.js';
import type { Account, User } from '../domain/types.js';
import { DrizzleBillingRepo } from '../repos/billing-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import { makeAccount, makeUser } from '../testing/fixtures.js';
import { RecordingPaymentProvider } from '../testing/payment-provider.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { BillingService } from './billing-service.js';

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
  /** A Checkout this application started, and the reference it was given. */
  async function aStartedCheckout(): Promise<string> {
    await service.startCheckout(IRIS, IRIS_ACCOUNT);
    return provider.checkouts[0]!.reference;
  }

  it('moves the User onto the paid tier and records what they are paying for', async () => {
    const reference = await aStartedCheckout();

    const outcome = await service.applyEvent({ ...COMPLETED, reference });

    expect(outcome).toEqual({ status: 'accepted', userId: 'user-iris' });
    expect((await users.getById('user-iris'))?.tier).toBe('paid');
    const subscription = await service.subscriptionFor('user-iris');
    expect(subscription).toMatchObject({
      userId: 'user-iris',
      provider: 'recording',
      subscriptionRef: 'sub_1',
      customerRef: 'cus_1',
      startedAt: NOW,
    });
  });

  it('refuses a reference this application never issued, and changes nothing', async () => {
    const outcome = await service.applyEvent({ ...COMPLETED, reference: 'never-minted' });

    expect(outcome).toEqual({ status: 'unknown_checkout', reference: 'never-minted' });
    expect((await users.getById('user-iris'))?.tier).toBe('free');
    expect(await service.subscriptionFor('user-iris')).toBeNull();
  });

  it('refuses a checkout whose User is gone, and changes nothing', async () => {
    // Not a separate answer from a reference Brieflyy never issued, because
    // `checkout_references.user_id` cascades: a deleted User takes the reference
    // with them, so the two cases are the same lookup finding nothing.
    const reference = await aStartedCheckout();
    await users.delete('user-iris');

    expect(await service.applyEvent({ ...COMPLETED, reference })).toEqual({
      status: 'unknown_checkout',
      reference,
    });
  });

  it('applies one event once, however many times it arrives', async () => {
    const reference = await aStartedCheckout();
    await service.applyEvent({ ...COMPLETED, reference });

    // A User moved back down, by the only means there is. The replay must not
    // undo it: the grant is the event, and the event happened once.
    await users.setTier('user-iris', 'free');
    const again = await service.applyEvent({ ...COMPLETED, reference });

    expect(again).toEqual({ status: 'replayed', eventId: 'evt_1' });
    expect((await users.getById('user-iris'))?.tier).toBe('free');
  });

  it('treats a second event for the same Checkout as a new grant rather than a second subscription', async () => {
    // A User who checks out twice is one Subscription with the newer references on
    // it. Two rows would leave "which one is the User's subscription" with no
    // answer, and the unique index on the User is what gives it one.
    const reference = await aStartedCheckout();
    await service.applyEvent({ ...COMPLETED, reference });
    await service.applyEvent({
      ...COMPLETED,
      id: 'evt_2',
      reference,
      subscriptionRef: 'sub_2',
    });

    const subscription = await service.subscriptionFor('user-iris');
    expect(subscription?.subscriptionRef).toBe('sub_2');
  });
});

describe('reading a signed request', () => {
  it('acts on the event a verified reading carries, and only then', async () => {
    // The double answers `verified` for anything it is handed, which is exactly why
    // this test exists: what is being checked is the routing of the reading and the
    // path from it to the tier, not the double's own signature handling — which is
    // `stripe-payment-provider.test.ts`'s and the HTTP suite's job.
    const answerer = new RecordingPaymentProvider({ checkoutUrl: HOSTED, event: COMPLETED });
    const answering = aService({ provider: answerer });
    await answering.startCheckout(IRIS, IRIS_ACCOUNT);
    const reference = answerer.checkouts[0]!.reference;

    const outcome = await answering.applySignedRequest({
      body: '{}',
      signature: 't=1,v1=whatever',
    });

    // The double names a fixed reference rather than the one it was handed, so the
    // event is unresolvable — which is the point: it proves the body was never
    // consulted for anything, and only the reading was acted on.
    expect(outcome).toEqual({ status: 'unknown_checkout', reference: 'ref-1' });
    expect((await users.getById('user-iris'))?.tier).toBe('free');
    expect(reference).not.toBe('ref-1');
  });

  it('refuses everything on an instance with no payment provider', async () => {
    const bare = aService({ provider: null });

    expect(await bare.applySignedRequest({ body: '{}', signature: 'x' })).toEqual({
      status: 'not_configured',
    });
  });
});