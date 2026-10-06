import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Clock } from '../domain/clock.js';
import { makeTestClock } from '../testing/test-clocks.js';
import {
  STRIPE_API_KEY,
  STRIPE_PAID_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  checkoutCompletedBody,
  signedCheckoutCompleted,
  signedSubscriptionDeleted,
  stripeSignatureHeader,
} from '../testing/stripe-webhook.js';
import {
  createStripePaymentProvider,
  StripePaymentProvider,
  type StripePaymentProviderOptions,
} from './stripe-payment-provider.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** A clock the provider reads its signature tolerance against. */
function clockAt(unixSeconds: number): Clock {
  return makeTestClock(new Date(unixSeconds * 1000)).clock;
}

function aProvider(
  overrides: Partial<StripePaymentProviderOptions> = {},
): StripePaymentProvider {
  return new StripePaymentProvider({
    secretKey: STRIPE_API_KEY,
    webhookSecret: STRIPE_WEBHOOK_SECRET,
    priceId: STRIPE_PAID_PRICE_ID,
    clock: clockAt(1_700_000_000),
    ...overrides,
  });
}

const TIMESTAMP = 1_700_000_000;
const REFERENCE = '0f6c1e5a-3d6b-4d0e-9b3a-9b1c2d3e4f50';

function completedEvent(id = 'evt_1'): { readonly body: string; readonly signature: string } {
  return {
    body: checkoutCompletedBody({ eventId: id, reference: REFERENCE }),
    signature: stripeSignatureHeader(STRIPE_WEBHOOK_SECRET, TIMESTAMP, checkoutCompletedBody({
      eventId: id,
      reference: REFERENCE,
    })),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('reading a signed payment event', () => {
  it('verifies a signature computed outside this repository', () => {
    // The digest below was produced by a different implementation (.NET's
    // HMACSHA256) rather than by anything in this file, so this test cannot pass
    // by the signer and the verifier agreeing on the same mistake. `unrecognised`
    // rather than `verified` because `{}` is not an event — and it is the right
    // evidence anyway: a body that had failed its signature check would have been
    // refused as unsigned instead.
    const digest = 'da95d9562758810f63c818b872bb1cba30d25a8c27f4d442343ac05ffbe6dca5';
    expect(
      stripeSignatureHeader('whsec_example_only', TIMESTAMP, '{}'),
      'the independently computed digest moved',
    ).toBe(`t=${TIMESTAMP},v1=${digest}`);

    const reading = aProvider().readEvent({
      body: '{}',
      signature: `t=${TIMESTAMP},v1=${digest}`,
    });

    expect(reading).toEqual({ status: 'unrecognised' });
  });

  it('reads a completed checkout into the one event this application acts on', () => {
    const signed = completedEvent();

    const reading = aProvider().readEvent(signed);

    expect(reading).toEqual({
      status: 'verified',
      event: {
        id: 'evt_1',
        kind: 'checkout_completed',
        reference: REFERENCE,
        subscriptionRef: 'sub_test_1',
        customerRef: 'cus_test_1',
      },
    });
  });

  it('refuses a request signed with a secret this application does not hold', () => {
    const body = checkoutCompletedBody({ eventId: 'evt_1', reference: REFERENCE });

    const reading = aProvider().readEvent({
      body,
      signature: stripeSignatureHeader('whsec_somebody_elses_secret', TIMESTAMP, body),
    });

    expect(reading).toEqual({ status: 'unsigned' });
  });

  it('refuses a body that was changed after it was signed', () => {
    const signed = completedEvent();

    const reading = aProvider().readEvent({
      body: signed.body.replace('cus_test_1', 'cus_somebody_else'),
      signature: signed.signature,
    });

    expect(reading).toEqual({ status: 'unsigned' });
  });

  it('refuses a signature whose timestamp is outside the tolerance', () => {
    const signed = completedEvent();

    // The age is measured both ways, so a timestamp from the future is refused on
    // the same grounds as one from the past rather than accepted as "not yet".
    expect(
      aProvider({ clock: clockAt(TIMESTAMP - 301) }).readEvent(signed),
    ).toEqual({ status: 'unsigned' });
    expect(
      aProvider({ clock: clockAt(TIMESTAMP + 301) }).readEvent(signed),
    ).toEqual({ status: 'unsigned' });
  });

  it('accepts one that is merely near the edge', () => {
    const signed = completedEvent();

    expect(aProvider({ clock: clockAt(TIMESTAMP - 299) }).readEvent(signed).status).toBe(
      'verified',
    );
  });

  it('acknowledges an event of a kind this application does not act on', () => {
    const body = JSON.stringify({ id: 'evt_2', type: 'invoice.paid', data: { object: {} } });

    const reading = aProvider().readEvent({
      body,
      signature: stripeSignatureHeader(STRIPE_WEBHOOK_SECRET, TIMESTAMP, body),
    });

    expect(reading).toEqual({ status: 'unrecognised' });
  });

  it.each([
    { what: 'no signature header at all', signature: '' },
    { what: 'a header naming no timestamp', signature: 'v1=' + 'a'.repeat(64) },
    { what: 'a header naming no digest', signature: `t=${TIMESTAMP}` },
    { what: 'a digest that is not a digest', signature: `t=${TIMESTAMP},v1=nonsense` },
  ])('refuses $what', ({ signature }) => {
    const body = checkoutCompletedBody({ eventId: 'evt_1', reference: REFERENCE });

    const reading = aProvider().readEvent({ body, signature });

    expect(reading).toEqual({ status: 'unsigned' });
  });

  it('accepts a header carrying more than one digest, as a key rotation does', () => {
    const body = checkoutCompletedBody({ eventId: 'evt_1', reference: REFERENCE });
    const reading = aProvider().readEvent({
      body,
      signature: `t=${TIMESTAMP},v1=${'a'.repeat(64)},v1=${stripeSignatureHeader(
        STRIPE_WEBHOOK_SECRET,
        TIMESTAMP,
        body,
      )
        .split('v1=')[1]}`,
    });

    expect(reading.status).toBe('verified');
  });

  it('refuses a body that verified but is not an event', () => {
    const body = 'not json at all';

    const reading = aProvider().readEvent({
      body,
      signature: stripeSignatureHeader(STRIPE_WEBHOOK_SECRET, TIMESTAMP, body),
    });

    expect(reading).toEqual({ status: 'unrecognised' });
  });

  it('will not act on a completed checkout that names no reference', () => {
    // The signature held, so this really is the provider — it is a payment for a
    // Checkout Brieflyy did not start, and there is nothing it could resolve it to.
    // `unrecognised` rather than `unsigned`, because the second would tell the
    // provider its signature was wrong when it was not.
    const body = checkoutCompletedBody({ eventId: 'evt_1', reference: '' });

    const reading = aProvider().readEvent({
      body,
      signature: stripeSignatureHeader(STRIPE_WEBHOOK_SECRET, TIMESTAMP, body),
    });

    expect(reading).toEqual({ status: 'unrecognised' });
  });

  it('will not act on a completed checkout with no subscription behind it', () => {
    // The stored column is the provider's own name for what it is charging for, and
    // an empty string in it would read back as an id somebody gave us. A session
    // with nothing to charge is not the subscription Checkout this sells, so there
    // is nothing to record either way.
    const session = JSON.parse(checkoutCompletedBody({ eventId: 'evt_1', reference: 'ref-1' }));
    delete session.data.object.subscription;
    const body = JSON.stringify(session);

    const reading = aProvider().readEvent({
      body,
      signature: stripeSignatureHeader(STRIPE_WEBHOOK_SECRET, TIMESTAMP, body),
    });

    expect(reading).toEqual({ status: 'unrecognised' });
  });

  it('records a missing customer as unknown rather than as an empty id', () => {
    const session = JSON.parse(checkoutCompletedBody({ eventId: 'evt_1', reference: 'ref-1' }));
    delete session.data.object.customer;
    const body = JSON.stringify(session);

    const reading = aProvider().readEvent({
      body,
      signature: stripeSignatureHeader(STRIPE_WEBHOOK_SECRET, TIMESTAMP, body),
    });

    expect(reading).toMatchObject({
      status: 'verified',
      event: { subscriptionRef: 'sub_test_1', customerRef: null },
    });
  });

  it('reads a subscription that has ended as the other event this application acts on', () => {
    // An application that only ever hears about a payment completing can put a User
    // onto the paid tier and has no way at all to move them down again.
    const signed = signedSubscriptionDeleted({ eventId: 'evt_3', timestamp: TIMESTAMP });

    const reading = aProvider().readEvent(signed);

    expect(reading).toEqual({
      status: 'verified',
      event: {
        id: 'evt_3',
        kind: 'subscription_ended',
        subscriptionRef: 'sub_test_1',
        customerRef: 'cus_test_1',
      },
    });
  });

  it('will not act on a subscription that ended without naming itself', () => {
    const body = JSON.stringify({
      id: 'evt_4',
      type: 'customer.subscription.deleted',
      data: { object: { customer: 'cus_test_1' } },
    });

    const reading = aProvider().readEvent({
      body,
      signature: stripeSignatureHeader(STRIPE_WEBHOOK_SECRET, TIMESTAMP, body),
    });

    expect(reading).toEqual({ status: 'unrecognised' });
  });

  it('still refuses a forged cancellation, before it reads anything of it', () => {
    const forged = signedSubscriptionDeleted({
      eventId: 'evt_3',
      timestamp: TIMESTAMP,
      secret: 'whsec_a_secret_this_application_never_had',
    });

    expect(aProvider().readEvent(forged)).toEqual({ status: 'unsigned' });
  });
});

describe('reading a subscription from the provider', () => {
  const RENEWAL = new Date('2026-04-02T09:00:00Z');

  /** The provider's own shape, which is what the reader has to understand. */
  function subscriptionBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      id: 'sub_test_1',
      object: 'subscription',
      customer: 'cus_test_1',
      status: 'active',
      cancel_at_period_end: false,
      current_period_end: Math.floor(RENEWAL.getTime() / 1000),
      ...overrides,
    };
  }

  it('reads the end of the period already paid for and whether it has been told to stop', async () => {
    const calls: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      calls.push(String(url));
      return { ok: true, status: 200, async json() { return subscriptionBody(); } };
    });

    const reading = await aProvider().readSubscription('sub_test_1');

    expect(reading).toEqual({
      status: 'known',
      current: {
        customerRef: 'cus_test_1',
        renewsAt: RENEWAL,
        cancelAtPeriodEnd: false,
      },
    });
    expect(calls).toEqual(['https://api.stripe.com/v1/subscriptions/sub_test_1']);
  });

  it('reads a subscription the provider has been told to stop as one already stopping', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      async json() {
        return subscriptionBody({ cancel_at_period_end: true, status: 'active' });
      },
    }));

    expect(await aProvider().readSubscription('sub_test_1')).toEqual({
      status: 'known',
      current: { customerRef: 'cus_test_1', renewsAt: RENEWAL, cancelAtPeriodEnd: true },
    });
  });

  it('answers that the provider holds no such subscription, rather than throwing', async () => {
    // A real answer rather than a failure: a subscription that has already gone is
    // the reason a User's row stops claiming they are paying, and it must not be
    // confused with somebody else's service being unreachable.
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, async json() { return {}; } }));

    expect(await aProvider().readSubscription('sub_gone')).toEqual({ status: 'unknown' });
  });

  it('says unavailable rather than guessing, when the provider is not answering', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 503, async json() { return {}; } }));

    expect(await aProvider().readSubscription('sub_test_1')).toEqual({ status: 'unavailable' });
  });

  it('records a renewal date the provider did not name as unknown', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      status: 200,
      async json() {
        return subscriptionBody({ current_period_end: null });
      },
    }));

    // A date the application worked out from `startedAt` would be an invention
    // printed on a page as though the provider had said it.
    expect(await aProvider().readSubscription('sub_test_1')).toEqual({
      status: 'known',
      current: { customerRef: 'cus_test_1', renewsAt: null, cancelAtPeriodEnd: false },
    });
  });
});

describe('stopping a subscription', () => {
  const RENEWAL = new Date('2026-04-02T09:00:00Z');

  it('asks the provider to stop at the end of the period already paid for', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url: String(url), init });
      return {
        ok: true,
        status: 200,
        async json() {
          return {
            id: 'sub_test_1',
            customer: 'cus_test_1',
            status: 'active',
            cancel_at_period_end: true,
            current_period_end: Math.floor(RENEWAL.getTime() / 1000),
          };
        },
      };
    });

    const reading = await aProvider().cancelSubscription('sub_test_1');

    // The date the User keeps their plan for is the provider's, read back out of
    // what it then held rather than calculated here.
    expect(reading).toEqual({
      status: 'stopping',
      current: { customerRef: 'cus_test_1', renewsAt: RENEWAL, cancelAtPeriodEnd: true },
    });
    // Not `cancel_now`, and not a deletion: a cancellation that cut the period short
    // would be a different promise from the one the page beside it makes.
    const sent = new URLSearchParams(String(calls[0]?.init.body ?? ''));
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/subscriptions/sub_test_1');
    expect(sent.get('cancel_at_period_end')).toBe('true');
    expect(calls[0]?.init.headers).toMatchObject({ Authorization: `Bearer ${STRIPE_API_KEY}` });
  });

  it('says unavailable rather than throwing, so the page can tell the User', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 502, async json() { return {}; } }));

    expect(await aProvider().cancelSubscription('sub_test_1')).toEqual({
      status: 'unavailable',
    });
  });

  it('says the Subscription has already finished, rather than unreachable', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 404, async json() { return {}; } }));

    // The one distinction that reaches a person: the page writes "it will keep
    // charging as it is" for `unavailable`, so answering a subscription the provider
    // has already dropped that way would tell a User their money is still going.
    expect(await aProvider().cancelSubscription('sub_gone')).toEqual({
      status: 'already_ended',
    });
  });
});

describe('starting a hosted checkout', () => {
  it('asks for a subscription at the paid price, carrying the reference and the returns', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, async json() { return { id: 'cs_1', url: 'https://pay.test/cs_1' }; } };
    });

    const checkout = await aProvider().startCheckout({
      userId: 'user-1',
      email: 'iris@example.com',
      reference: REFERENCE,
      successUrl: 'https://app.brieflyy.test/upgrade?checkout=complete',
      cancelUrl: 'https://app.brieflyy.test/upgrade?checkout=cancelled',
    });

    expect(checkout).toEqual({ url: 'https://pay.test/cs_1' });
    const sent = new URLSearchParams(String(calls[0]?.init.body ?? ''));
    expect(calls[0]?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
    expect(sent.get('mode')).toBe('subscription');
    expect(sent.get('line_items[0][price]')).toBe(STRIPE_PAID_PRICE_ID);
    expect(sent.get('client_reference_id')).toBe(REFERENCE);
    expect(sent.get('customer_email')).toBe('iris@example.com');
  });

  it('throws rather than sending a User to a page that does not exist', async () => {
    vi.stubGlobal('fetch', async () => ({
      ok: true,
      async json() {
        return { id: 'cs_1' };
      },
    }));

    await expect(
      aProvider().startCheckout({
        userId: 'user-1',
        email: 'iris@example.com',
        reference: REFERENCE,
        successUrl: 'https://app.brieflyy.test/upgrade?checkout=complete',
        cancelUrl: 'https://app.brieflyy.test/upgrade?checkout=cancelled',
      }),
    ).rejects.toThrow(/no URL/);
  });

  it('throws when the provider refuses, so the caller can tell the User', async () => {
    vi.stubGlobal('fetch', async () => ({ ok: false, status: 429 }));

    await expect(
      aProvider().startCheckout({
        userId: 'user-1',
        email: 'iris@example.com',
        reference: REFERENCE,
        successUrl: 'https://app.brieflyy.test/upgrade?checkout=complete',
        cancelUrl: 'https://app.brieflyy.test/upgrade?checkout=cancelled',
      }),
    ).rejects.toThrow(/429/);
  });
});

describe('the provider as a deployment has configured it', () => {
  it('is nothing at all when no credential has been set', () => {
    expect(createStripePaymentProvider({ clock: clockAt(TIMESTAMP) })).toBeNull();
  });

  it.each([
    { what: 'the API key', config: { webhookSecret: 'whsec_x', priceId: 'price_x' } },
    { what: 'the signing secret', config: { secretKey: 'sk_x', priceId: 'price_x' } },
    { what: 'the price', config: { secretKey: 'sk_x', webhookSecret: 'whsec_x' } },
  ])('is nothing at all with only $what set', ({ config }) => {
    // `loadServerConfig` already refuses this at boot; answering here too means a
    // caller that assembled the values itself cannot build a provider that would
    // accept an event nobody can sign.
    expect(createStripePaymentProvider({ clock: clockAt(TIMESTAMP), ...config })).toBeNull();
  });

  it('is a provider once all three are set', () => {
    const provider = createStripePaymentProvider({
      clock: clockAt(TIMESTAMP),
      secretKey: STRIPE_API_KEY,
      webhookSecret: STRIPE_WEBHOOK_SECRET,
      priceId: STRIPE_PAID_PRICE_ID,
    });

    expect(provider?.providerName).toBe('stripe');
  });

  it('reads nothing a test could not have passed in itself', () => {
    // Every Stripe key in this repository lives in a file the test suites own: a
    // test file, or `src/testing/`, which the application never imports. Anything
    // else holding one would be a credential a test could read — and a test that
    // finds one here is the only thing standing between it and a committed key.
    const offenders: string[] = [];
    for (const file of sourceFiles(SRC)) {
      if (file.includes(`${join('src', 'testing')}`) || file.endsWith('.test.ts')) continue;
      if (/\b(?:sk|rk|whsec)_[A-Za-z0-9]{8,}/.test(readFileSync(file, 'utf8'))) {
        offenders.push(file.slice(SRC.length + 1));
      }
    }
    expect(offenders).toEqual([]);
  });
});

/** Every `.ts` file under `dir`, at any depth. */
function sourceFiles(dir: string): readonly string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}