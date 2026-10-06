import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { escapeHtml } from '../domain/html.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { PUBLIC_ROUTES, WRITE_GUARD_EXEMPTIONS } from '../http/access.js';
import { createTestDb } from '../testing/test-db.js';
import { countRows } from '../testing/db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import {
  STRIPE_API_KEY,
  STRIPE_PAID_PRICE_ID,
  STRIPE_WEBHOOK_SECRET,
  signedCheckoutCompleted,
  signedSubscriptionDeleted,
  stripeSignatureHeader,
  type SignedWebhook,
} from '../testing/stripe-webhook.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { StripePaymentProvider } from './stripe-payment-provider.js';
import {
  BILLING_CANCEL_PATH,
  BILLING_SETTINGS_PATH,
  BILLING_TOPICS_PATH,
  BILLING_WEBHOOK_PATH,
  CHECKOUT_PATH,
} from './paths.js';

const NOW = new Date('2026-03-01T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const HOSTED_CHECKOUT_URL = 'https://checkout.brieflyy.test/pay/cs_test_1';
const RENEWAL_SECONDS = Math.floor(new Date('2026-04-01T12:00:00Z').getTime() / 1000);
const RENEWAL = new Date('2026-04-01T12:00:00Z');
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

type Driver = ReturnType<typeof createTestDb>['driver'];

/** The provider's own shape for a subscription, which is what the stub answers with. */
interface ProviderSubscriptionShape {
  readonly customer: string | null;
  readonly status: string;
  readonly cancel_at_period_end: boolean;
  readonly current_period_end: number | null;
}

/**
 * The two halves of an HTTP answer the provider seam reads.
 *
 * Not a whole `Response`, because a stubbed provider that has to build one would be
 * a test full of fields that say nothing about billing — and the seam checks `ok`
 * and `status` and reads `json()`, so those are the three that have to be here.
 */
interface StubbedResponse {
  readonly ok: boolean;
  readonly status: number;
  json(): Promise<unknown>;
}

/**
 * Whether a request the application made is the provider saying one thing or
 * another.
 *
 * Looked for in the body rather than tracked separately, so the double's state
 * follows from what the provider was actually sent rather than from a flag a test
 * set. Parsed here and nowhere else in the file: nothing but the double's own
 * bookkeeping needs to know the provider's event names.
 */
function deliveryEventType(body: string): string | null {
  try {
    const parsed: unknown = JSON.parse(body);
    return typeof parsed === 'object' && parsed !== null
      ? ((parsed as { type?: unknown }).type as string | undefined) ?? null
      : null;
  } catch {
    return null;
  }
}

interface Harness {
  readonly app: FastifyInstance;
  /** The session and the request token: what a signed-in browser holds. */
  readonly cookie: string;
  readonly driver: Driver;
  /** Every request the application made to the payment provider, in order. */
  readonly providerCalls: { readonly url: string; readonly body: string }[];
  /** Tell the stubbed provider that it has stopped charging for the subscription. */
  theProviderHasStoppedCharging(): void;
  /**
   * Tell the stubbed provider that a new Checkout has started it charging again.
   *
   * The other half of `theProviderHasStoppedCharging`, and needed for the same
   * reason: a provider that had dropped a Subscription and then took a payment for
   * another one is holding the new one, so a read afterwards has something to
   * answer with. A double that stayed at "no such Subscription" would make every
   * page that reads the Subscription after a resubscribe claim it had ended.
   */
  theProviderHasStartedChargingAgain(): void;
  /**
   * Move the injected clock forward.
   *
   * Held because Topics are ordered by when they were created and a fixed clock
   * gives nine of them the same instant — at which point "which of these did the
   * User add most recently" is a question the fixtures cannot answer and a test
   * would be asserting on the tie-break instead.
   */
  advanceClock(ms: number): void;
  /**
   * The injected clock in seconds, which is what a provider signature is stamped
   * with: the provider checks a delivery against the clock it was built with, so a
   * test that has moved that clock has to sign with the new reading.
   */
  nowSeconds(): number;
}

/**
 * The application built the way `server.ts` builds it, with the real Stripe
 * PaymentProvider and only the HTTP call out to Stripe stubbed.
 *
 * The seam is the provider's own interface and the double here is the network:
 * everything above it — the reference minted, the signature verified, the tier
 * moved, the subscription read and stopped — is the code under test, which is what a
 * test that stubbed the provider itself would stop checking.
 *
 * `provider` is what the stubbed Stripe says about the subscription it holds, so a
 * test can make the provider unavailable or have stopped holding it without any of
 * the application changing.
 */
async function buildHarness(
  input: {
    readonly configured?: boolean;
    readonly devToolsEnabled?: boolean;
    readonly provider?: (current: ProviderSubscriptionShape) => StubbedResponse;
  } = {},
): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const testClock = makeTestClock(NOW);
  const clock = testClock.clock;
  const providerCalls: { url: string; body: string }[] = [];
  // What the stubbed provider currently holds, so a test can drive it through the
  // whole flow rather than by reaching past the application into the double. Null
  // once the provider has said the subscription is gone, which is what every read
  // afterwards answers with.
  const charging: ProviderSubscriptionShape = {
    customer: 'cus_test_1',
    status: 'active',
    cancel_at_period_end: false,
    current_period_end: RENEWAL_SECONDS,
  };
  let current: ProviderSubscriptionShape | null = { ...charging };

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const call = { url: String(url), body: String(init.body ?? '') };
    providerCalls.push(call);
    if (call.url.endsWith('/v1/checkout/sessions')) {
      return {
        ok: true,
        status: 200,
        async json() {
          return { id: 'cs_test_1', url: HOSTED_CHECKOUT_URL };
        },
      };
    }
    if (call.url.includes('/v1/subscriptions/')) {
      if (current === null) {
        return { ok: false, status: 404, async json() { return {}; } };
      }
      if ((init.method ?? 'GET') === 'POST') {
        current = { ...current, cancel_at_period_end: true };
      }
      if (input.provider !== undefined) return input.provider(current);
      return {
        ok: true,
        status: 200,
        async json() {
          return current;
        },
      };
    }
    throw new Error(`the payment provider was asked for ${call.url}, which no test expected`);
  });

  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock,
    random: deterministicRandom,
    devToolsEnabled: input.devToolsEnabled === true,
    paymentProvider:
      input.configured === false
        ? undefined
        : new StripePaymentProvider({
            secretKey: STRIPE_API_KEY,
            webhookSecret: STRIPE_WEBHOOK_SECRET,
            priceId: STRIPE_PAID_PRICE_ID,
            clock,
          }),
  });

  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(
      extractMagicLinkToken(transport.snapshot()[0]!.text),
    )}`,
  });
  const raw = verify.headers['set-cookie'];
  const sessionCookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  const { cookies } = await signedInCookies(app, sessionCookie);
  return {
    app,
    cookie: cookies,
    driver,
    providerCalls,
    advanceClock: (ms: number) => {
      testClock.advance(ms);
    },
    nowSeconds: () => Math.floor(testClock.clock.now().getTime() / 1000),
    theProviderHasStoppedCharging: () => {
      current = null;
    },
    theProviderHasStartedChargingAgain: () => {
      current = { ...charging };
    },
  };
}

/** `count` Directory template ids from `offset`, which is what the picker posts. */
async function templateIds(
  app: FastifyInstance,
  count: number,
  offset = 0,
): Promise<readonly string[]> {
  const resp = await app.inject({ method: 'GET', url: '/api/onboarding/templates' });
  return (resp.json() as { templates: { id: string }[] }).templates
    .slice(offset, offset + count)
    .map((t) => t.id);
}

/**
 * Start a Checkout, and answer with the reference the provider was actually told.
 *
 * Read out of the request rather than back out of the application, because the
 * reference is the provider's half of the conversation: a test that took the
 * application at its word for a value only Stripe will send back would not notice
 * if the two ever disagreed.
 */
async function startCheckout(h: Harness): Promise<string> {
  const resp = await submitForm(h.app, h.cookie, CHECKOUT_PATH);
  if (resp.statusCode !== 302) {
    throw new Error(`POST ${CHECKOUT_PATH} answered ${resp.statusCode}: ${resp.body}`);
  }
  const asked = h.providerCalls.at(-1);
  const reference = asked === undefined ? null : asked.body.match(/client_reference_id=([^&]+)/)?.[1];
  if (reference === null || reference === undefined) {
    throw new Error(`no Checkout was started: ${JSON.stringify(h.providerCalls)}`);
  }
  return decodeURIComponent(reference);
}

/** Post a signed request to the webhook the way the provider would. */
function postWebhook(h: Harness, signed: { readonly body: string; readonly signature: string }) {
  // The provider acts on its own event, so a delivery saying a Subscription has
  // gone makes the stubbed one stop holding it, and a delivery saying a Checkout
  // completed makes it start holding the new one. Watching for it here rather than
  // in the fetch double is because the provider does not reach the application over
  // HTTP — it is the other way round.
  const type = deliveryEventType(signed.body);
  if (type === 'customer.subscription.deleted') h.theProviderHasStoppedCharging();
  if (type === 'checkout.session.completed') h.theProviderHasStartedChargingAgain();
  return h.app.inject({
    method: 'POST',
    url: BILLING_WEBHOOK_PATH,
    headers: {
      'content-type': 'application/json',
      'stripe-signature': signed.signature,
    },
    payload: signed.body,
  });
}

describe('HTTP: starting a checkout', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
    vi.unstubAllGlobals();
  });

  it('offers a checkout on the upgrade page, in a form that can be submitted', async () => {
    const resp = await h.app.inject({
      method: 'GET',
      url: '/upgrade',
      headers: { cookie: h.cookie },
    });

    expect(resp.statusCode).toBe(200);
    // A button that goes nowhere is the failure this page used to have, so the
    // claim is about the form's action rather than about the word "checkout".
    expect(resp.body).toMatch(new RegExp(`<form[^>]*action="${CHECKOUT_PATH}"`));
    expect(resp.body).toContain('name="requestToken"');
  });

  it('sends the User to the hosted page the provider built', async () => {
    const resp = await submitForm(h.app, h.cookie, CHECKOUT_PATH);

    // A redirect rather than a page: the page the User pays on is not Brieflyy's
    // to render, and a form that answered with our own markup would be a second
    // place the price is written down.
    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe(HOSTED_CHECKOUT_URL);
    expect(h.providerCalls[0]?.url).toBe('https://api.stripe.com/v1/checkout/sessions');
  });

  it('tells the provider which User, which reference, and which return addresses', async () => {
    await submitForm(h.app, h.cookie, CHECKOUT_PATH);

    const sent = new URLSearchParams(h.providerCalls[0]?.body ?? '');
    expect(sent.get('customer_email')).toBe('iris@example.com');
    expect(sent.get('mode')).toBe('subscription');
    // Where the User lands afterwards has to be Brieflyy's own pages: the address
    // is part of what the provider is told, so a checkout that came back to a
    // stranger's site would be the provider obeying this application.
    expect(sent.get('success_url')).toBe('https://app.brieflyy.test/upgrade?checkout=complete');
    expect(sent.get('cancel_url')).toBe('https://app.brieflyy.test/upgrade?checkout=cancelled');
    // A reference Brieflyy minted, so the completed event names a User by
    // something only this application issued rather than by anything it believes.
    expect(sent.get('client_reference_id')).toMatch(UUID_RE);
  });

  it('sends the User to sign in rather than starting a checkout for nobody', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: CHECKOUT_PATH,
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/signup');
    expect(h.providerCalls).toEqual([]);
  });

  it('says plainly that it cannot take a payment rather than offering a button that is refused', async () => {
    // An instance that has configured no PaymentProvider, which is what a
    // deployment with no secret set looks like. The page must not offer a control
    // that cannot work, and the route — which still exists, for the same reason
    // the Google routes do — must refuse with a page naming what is missing rather
    // than a bare status.
    const bare = await buildHarness({ configured: false });
    try {
      const page = await bare.app.inject({
        method: 'GET',
        url: '/upgrade',
        headers: { cookie: bare.cookie },
      });
      expect(page.body).toMatch(/Billing isn&#39;t connected yet|isn't connected yet/);
      const main = page.body.match(/<main[^>]*>[\s\S]*<\/main>/)?.[0] ?? page.body;
      expect(main).not.toMatch(/<form/);

      const refused = await submitForm(bare.app, bare.cookie, CHECKOUT_PATH);
      expect(refused.statusCode).toBe(503);
      expect(refused.body).toMatch(/no payment provider configured/);
    } finally {
      await bare.app.close();
    }
  });
});

describe('HTTP: the billing webhook', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
    vi.unstubAllGlobals();
  });

  const get = (url: string) =>
    h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

  it('accepts a signed event with no session at all, and moves the User onto PaidTier', async () => {
    const reference = await startCheckout(h);

    const resp = await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
    );

    // No cookie, no request token, no Origin: the provider is not signed in and
    // cannot be, which is the whole reason the signature is the authorisation.
    expect(resp.statusCode).toBe(200);
    expect(resp.headers['set-cookie']).toBeUndefined();
    expect((await get('/topics')).body).toMatch(/Paid plan/);
  });

  it('opens up the trends history and the topic cap, on the pages that gate on them', async () => {
    // Watched on both sides of the event rather than after it: the paywalls are
    // shut first, and each is read from a surface showing something to a person.
    expect((await get('/trends')).body).toMatch(/Upgrade<\/a> for the full history/);
    expect(
      (
        await submitForm(h.app, h.cookie, '/pick-topics', {
          templateIds: await templateIds(h.app, 4),
        })
      ).statusCode,
    ).toBe(402);

    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
    );

    expect((await get('/trends')).body).toMatch(/The full history/);
    expect(
      (
        await submitForm(h.app, h.cookie, '/pick-topics', {
          templateIds: await templateIds(h.app, 6),
        })
      ).statusCode,
    ).toBe(302);
  });

  it('stores what the User is paying for, so a later read does not ask again', async () => {
    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
    );
    const callsAfterTheEvent = h.providerCalls.length;

    const stored = h.driver
      .prepare('SELECT user_id, provider, subscription_ref, customer_ref FROM subscriptions')
      .all() as {
      user_id: string;
      provider: string;
      subscription_ref: string;
      customer_ref: string;
    }[];
    expect(stored).toHaveLength(1);
    expect(stored[0]?.provider).toBe('stripe');
    // The provider's own names for what it is charging for, kept so naming it
    // later is a read rather than a round trip.
    expect(stored[0]?.subscription_ref).toBe('sub_test_1');
    expect(stored[0]?.customer_ref).toBe('cus_test_1');

    await get('/upgrade');
    await get('/topics');
    expect(h.providerCalls.length, 'a read went back to the payment provider').toBe(
      callsAfterTheEvent,
    );
  });
});

describe('HTTP: a payment event that has not been signed by the provider', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
    vi.unstubAllGlobals();
  });

  /**
   * Every way a delivery can fail to prove it came from the provider, in one place
   * so the claim "refused, and nothing written" is checked against all of them
   * rather than against whichever one was easiest to write.
   */
  const forged: readonly { readonly what: string; readonly tamper: (signed: SignedWebhook) => SignedWebhook }[] = [
    {
      what: 'signed with another secret',
      tamper: (signed) => ({
        body: signed.body,
        signature: stripeSignatureHeader(
          'whsec_a_secret_this_application_never_had',
          NOW_SECONDS,
          signed.body,
        ),
      }),
    },
    {
      what: 'carrying no signature at all',
      tamper: (signed) => ({ body: signed.body, signature: '' }),
    },
    {
      what: 'whose body was changed after it was signed',
      // The decisive one: the signature covers the bytes, so a body edited in
      // transit does not verify even though it is still valid JSON naming a
      // reference this application did issue. A check against a parsed object
      // would let this through.
      tamper: (signed) => ({
        body: signed.body.replace('cus_test_1', 'cus_somebody_else'),
        signature: signed.signature,
      }),
    },
    {
      what: 'carrying a timestamp from outside the tolerance',
      tamper: (signed) => ({
        body: signed.body,
        signature: stripeSignatureHeader(
          STRIPE_WEBHOOK_SECRET,
          NOW_SECONDS - 3600,
          signed.body,
        ),
      }),
    },
  ];

  for (const { what, tamper } of forged) {
    it(`refuses a delivery ${what}, and changes nothing`, async () => {
      const reference = await startCheckout(h);
      const signed = signedCheckoutCompleted({
        eventId: 'evt_forged',
        reference,
        timestamp: NOW_SECONDS,
      });

      const resp = await postWebhook(h, tamper(signed));

      expect(resp.statusCode, resp.body).toBe(400);
      // Nothing at all: not the tier, not the record of the event, not the
      // subscription. A refused delivery is not a pending one.
      expect(
        (await h.app.inject({ method: 'GET', url: '/topics', headers: { cookie: h.cookie } }))
          .body,
      ).toMatch(/Free plan/);
      expect(countRows(h.driver, 'payment_events')).toBe(0);
      expect(countRows(h.driver, 'subscriptions')).toBe(0);
    });
  }
});

describe('HTTP: the same payment event delivered twice', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness({ devToolsEnabled: true });
  });

  afterEach(async () => {
    await h.app.close();
    vi.unstubAllGlobals();
  });

  it('is recorded once, and acknowledged the second time', async () => {
    const reference = await startCheckout(h);
    const signed = signedCheckoutCompleted({
      eventId: 'evt_1',
      reference,
      timestamp: NOW_SECONDS,
    });

    const first = await postWebhook(h, signed);
    const second = await postWebhook(h, signed);

    // The second delivery is told it has been seen rather than refused: it is not
    // a forgery, it is the provider retrying, and a failure here would have it
    // keep coming back.
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.body).toBe('Already applied.');
    expect(countRows(h.driver, 'payment_events')).toBe(1);
    expect(countRows(h.driver, 'subscriptions')).toBe(1);
  });

  it('does not put a User back on the paid tier the second time round', async () => {
    const reference = await startCheckout(h);
    const signed = signedCheckoutCompleted({
      eventId: 'evt_1',
      reference,
      timestamp: NOW_SECONDS,
    });
    await postWebhook(h, signed);

    // The only way a User moves back down is the development switch, which writes
    // the same column the event wrote. A replay must not undo that: the grant is
    // the event, and the event happened once.
    await submitForm(h.app, h.cookie, '/dev/tier', { tier: 'free' });
    expect(
      (await h.app.inject({ method: 'GET', url: '/topics', headers: { cookie: h.cookie } }))
        .body,
    ).toMatch(/Free plan/);

    await postWebhook(h, signed);

    expect(
      (await h.app.inject({ method: 'GET', url: '/topics', headers: { cookie: h.cookie } }))
        .body,
    ).toMatch(/Free plan/);
  });
});

describe('HTTP: the subscription settings surface', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
    vi.unstubAllGlobals();
  });

  const get = (url: string) =>
    h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

  /** The inside of a page, without the header's sign-out form on every page. */
  const main = (body: string) => body.match(/<main[^>]*>[\s\S]*<\/main>/)?.[0] ?? body;

  /** Pay, through the two doors a real payment comes through. */
  async function aPaidUser(): Promise<void> {
    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
    );
  }

  it('is reachable from the shell, and marks itself as where the User is', async () => {
    const page = await get(BILLING_SETTINGS_PATH);

    // Reachable from anywhere rather than only from the paywall: a User who wants
    // to stop paying should not have to go looking for a way to be charged first.
    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(
      new RegExp(`<a href="${BILLING_SETTINGS_PATH}" aria-current="page"`),
    );
  });

  it('answers a User with no stored billing state, rather than failing', async () => {
    // Most Users arrive here having never paid, so this is the page's commonest
    // answer and it has to be a whole one rather than an error.
    const page = await get(BILLING_SETTINGS_PATH);

    expect(page.statusCode).toBe(200);
    expect(page.body).toMatch(/Free plan/);
    expect(page.body).toMatch(/no paid subscription on this account/i);
    // No cancellation to offer, which is why there is no form in the page itself.
    expect(main(page.body)).not.toMatch(/<form/);
  });

  it('states the plan, the renewal date and the status for a User who is paying', async () => {
    await aPaidUser();

    const page = await get(BILLING_SETTINGS_PATH);

    expect(page.body).toMatch(/You are on the paid plan/);
    // Read out of what the provider said rather than worked out from when the
    // subscription started, which is the whole reason the page can name a date.
    expect(page.body).toMatch(/Next charge on Wed, 1 Apr at 12:00 \(UTC\)/);
  });

  it('offers a cancellation that reaches the provider, and says what it did', async () => {
    await aPaidUser();

    const submitted = await submitForm(h.app, h.cookie, BILLING_CANCEL_PATH);
    const asked = h.providerCalls.at(-1);
    expect(asked?.url).toBe('https://api.stripe.com/v1/subscriptions/sub_test_1');
    // The one field that decides whether this stops the next charge rather than
    // ending the period the User has already paid for.
    expect(new URLSearchParams(asked?.body ?? '').get('cancel_at_period_end')).toBe('true');
    expect(submitted.statusCode).toBe(302);

    const page = await get(submitted.headers.location as string);
    expect(page.body).toMatch(/next charge has been stopped/i);
  });

  it('keeps the User on the paid plan until the period they paid for is up', async () => {
    await aPaidUser();
    await submitForm(h.app, h.cookie, BILLING_CANCEL_PATH);

    // Checked on two surfaces, because they are two separate facts: the page says
    // the plan runs to a date, and the header every other page carries still has to
    // say the User is paying until then.
    expect((await get(BILLING_SETTINGS_PATH)).body).toMatch(/runs until Wed, 1 Apr at 12:00/);
    expect((await get('/topics')).body).toMatch(/Paid plan/);
  });

  it('says the next charge will not happen, and asks for no second cancellation', async () => {
    await aPaidUser();
    const submitted = await submitForm(h.app, h.cookie, BILLING_CANCEL_PATH);

    const page = await get(submitted.headers.location as string);
    expect(page.body).toMatch(/no charge after that date/i);
    // A control that would ask the provider the same question twice is a control
    // that cannot do anything the first one did not.
    expect(main(page.body)).not.toMatch(/<form/);
  });

  it('says nothing has changed when the provider could not be reached', async () => {
    const offline = await buildHarness({
      provider: () => ({ ok: false, status: 503, async json() { return {}; } }),
    });
    try {
      const reference = await startCheckout(offline);
      await postWebhook(
        offline,
        signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
      );

      const submitted = await submitForm(offline.app, offline.cookie, BILLING_CANCEL_PATH);
      const page = await offline.app.inject({
        method: 'GET',
        url: submitted.headers.location as string,
        headers: { cookie: offline.cookie },
      });

      // The half of a cancellation that fails silently is the dangerous one: a
      // Subscription recorded as stopped while the provider goes on charging it.
      expect(page.body).toMatch(/could not reach the payment provider/i);
      expect(page.body).toMatch(/has not been changed and will keep charging/i);
      expect(
        offline.driver.prepare('SELECT status FROM subscriptions').all(),
      ).toEqual([{ status: 'active' }]);
    } finally {
      await offline.app.close();
    }
  });

  it('offers no cancellation at all on an instance that has lost its payment provider', async () => {
    const bare = await buildHarness({ configured: false });
    try {
      // A deployment that had Stripe configured and has since lost it: the payment
      // was taken, and the row recording it outlives the credential. Written in
      // rather than arrived at, because no provider means no Checkout to complete
      // one with — and this is the only state in which the application holds a
      // Subscription it cannot act on.
      bare.driver.prepare(`UPDATE users SET tier = 'paid'`).run();
      bare.driver
        .prepare(
          `INSERT INTO subscriptions (id, user_id, provider, subscription_ref, customer_ref, started_at, status, renews_at, cancelled_at)
           VALUES ('sub_row', (SELECT id FROM users LIMIT 1), 'stripe', 'sub_test_1', 'cus_test_1', ?, 'active', ?, NULL)`,
        )
        .run(NOW.getTime(), RENEWAL.getTime());

      const page = await bare.app.inject({
        method: 'GET',
        url: BILLING_SETTINGS_PATH,
        headers: { cookie: bare.cookie },
      });

      // The same rule the checkout and the Google button follow (ADR-0019): a
      // control that could not work is worse than a sentence saying why. The
      // Subscription is still stated — it is still what happened — but nothing is
      // offered on its behalf.
      expect(page.body).toMatch(/Paid plan/);
      expect(page.body).toMatch(/no payment provider set up/i);
      const inside = page.body.match(/<main[^>]*>[\s\S]*<\/main>/)?.[0] ?? page.body;
      expect(inside).not.toMatch(/<form/);
    } finally {
      await bare.app.close();
    }
  });

  it('says a Subscription has ended when the provider has stopped holding it', async () => {
    // The page reads the Subscription, and the Subscription is what the provider's
    // answer changes. The *tier* is deliberately not moved by a page read, and the
    // other two halves of this describe do that — so the page must not claim a tier
    // here. "On the free plan now" under a header that still reads `users.tier` and
    // says "Paid plan" is two sources disagreeing inside one viewport.
    const gone = await buildHarness({
      provider: () => ({ ok: false, status: 404, async json() { return {}; } }),
    });
    try {
      const reference = await startCheckout(gone);
      await postWebhook(
        gone,
        signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
      );

      const page = await gone.app.inject({
        method: 'GET',
        url: BILLING_SETTINGS_PATH,
        headers: { cookie: gone.cookie },
      });
      expect(page.body).toMatch(/Your paid plan has ended/);
      expect(page.body).toMatch(/no charge/i);
      // The header still states the tier, and the tier has not moved: one source,
      // stated once.
      expect(page.body).toMatch(/Paid plan/);
      expect(page.body).not.toMatch(/on the free plan now/);
      expect(gone.driver.prepare('SELECT status FROM subscriptions').all()).toEqual([
        { status: 'ended' },
      ]);
    } finally {
      await gone.app.close();
    }
  });

  it('says what it is showing is as last recorded when the provider cannot be asked', async () => {
    const offline = await buildHarness({
      provider: () => ({ ok: false, status: 503, async json() { return {}; } }),
    });
    try {
      const reference = await startCheckout(offline);
      await postWebhook(
        offline,
        signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
      );

      const page = await offline.app.inject({
        method: 'GET',
        url: BILLING_SETTINGS_PATH,
        headers: { cookie: offline.cookie },
      });
      // A stale renewal date presented as a current one is a wrong claim rather
      // than a stale one, so the page says which of the two it is showing.
      expect(page.body).toMatch(/could not be reached just now/i);
      expect(page.body).toMatch(/this is what we last recorded/i);
    } finally {
      await offline.app.close();
    }
  });
});

describe('HTTP: a subscription ending', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
    vi.unstubAllGlobals();
  });

  it('is taken from a signed event, with no session at all', async () => {
    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
    );
    expect((await h.app.inject({ method: 'GET', url: '/topics', headers: { cookie: h.cookie } }))
      .body).toMatch(/Paid plan/);

    const resp = await postWebhook(
      h,
      signedSubscriptionDeleted({ eventId: 'evt_2', timestamp: NOW_SECONDS }),
    );

    // The provider is not signed in and cannot be, which is the whole reason the
    // signature is the authorisation — the same argument the payment itself has.
    expect(resp.statusCode).toBe(200);
    expect(resp.headers['set-cookie']).toBeUndefined();
    // On a surface the User reads, not only in the log: the tier the header names is
    // what every paywall in the application reads.
    expect((await h.app.inject({ method: 'GET', url: '/topics', headers: { cookie: h.cookie } }))
      .body).toMatch(/Free plan/);
    expect((await h.app.inject({ method: 'GET', url: BILLING_SETTINGS_PATH, headers: { cookie: h.cookie } }))
      .body).toMatch(/has ended/i);
  });

  it('is refused when the signature does not hold, and changes nothing', async () => {
    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
    );

    const resp = await postWebhook(
      h,
      signedSubscriptionDeleted({
        eventId: 'evt_2',
        timestamp: NOW_SECONDS,
        secret: 'whsec_a_secret_this_application_never_had',
      }),
    );

    // The route that moves a User down is held to the same bar as the one that
    // moves them up: a signature checked after the payload has been read would let
    // anybody with a subscription id take a paid User's plan away.
    expect(resp.statusCode).toBe(400);
    expect((await h.app.inject({ method: 'GET', url: '/topics', headers: { cookie: h.cookie } }))
      .body).toMatch(/Paid plan/);
    expect(countRows(h.driver, 'payment_events')).toBe(1);
  });

  it('is acknowledged rather than refused for a subscription this instance never held', async () => {
    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
    );

    const resp = await postWebhook(
      h,
      signedSubscriptionDeleted({
        eventId: 'evt_2',
        timestamp: NOW_SECONDS,
        subscriptionRef: 'sub_somebody_else',
      }),
    );

    // Not a failure: the signature held, this is simply about another account, and
    // a 5xx would have Stripe retrying for days something no retry can fix.
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toBe('Ignored.');
    expect((await h.app.inject({ method: 'GET', url: '/topics', headers: { cookie: h.cookie } }))
      .body).toMatch(/Paid plan/);
  });
});

describe('a paid User who is holding more Topics than the free cap allows', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
    vi.unstubAllGlobals();
  });

  const get = (url: string) =>
    h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });

  /**
   * Pay, hold nine Topics, cancel, and let the period they paid for run out.
   *
   * The whole journey through the doors a real one comes through, because the state
   * this ticket is about cannot be reached any other way: it is a User whose cap
   * dropped while their Topics did not, and only a Subscription ending does that.
   * The clock is moved between the two batches so the Topics have distinct creation
   * times and "the ones added most recently" is a fact rather than a tie-break.
   */
  async function paidWithNineTopics(): Promise<void> {
    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_1', reference, timestamp: NOW_SECONDS }),
    );

    const first = await templateIds(h.app, 5);
    const added = await submitForm(h.app, h.cookie, '/pick-topics', { templateIds: first });
    if (added.statusCode !== 302) {
      throw new Error(`the first batch answered ${added.statusCode}: ${added.body}`);
    }
    h.advanceClock(DAY_MS);
    const second = await templateIds(h.app, 4, 5);
    const rest = await submitForm(h.app, h.cookie, '/pick-topics', { templateIds: second });
    if (rest.statusCode !== 302) {
      throw new Error(`the second batch answered ${rest.statusCode}: ${rest.body}`);
    }
  }

  /**
   * The subscription ending: the provider's own event, and the tier moving down.
   *
   * The event id is the argument because one provider event is one grant and the
   * second delivery of the same id is refused as a replay (ADR-0023) — so a User who
   * stops paying twice needs two events, and a test that reused one would be
   * asserting that the replay path moved a tier.
   */
  async function theSubscriptionEnds(eventId = 'evt_2'): Promise<void> {
    await submitForm(h.app, h.cookie, BILLING_CANCEL_PATH);
    const resp = await postWebhook(
      h,
      signedSubscriptionDeleted({ eventId, timestamp: h.nowSeconds() }),
    );
    expect(resp.statusCode, resp.body).toBe(200);
  }

  /** The Topics they still hold, oldest first, as the pages list them. */
  function heldTopics(): readonly { readonly title: string; readonly slug: string }[] {
    return h.driver
      .prepare(
        'SELECT title, slug FROM topics WHERE removed_at IS NULL ORDER BY created_at, id',
      )
      .all() as { title: string; slug: string }[];
  }

  /** The same, as the titles the pages name them with. */
  const topicsTheyHold = (): readonly string[] => heldTopics().map((t) => t.title);

  it('is over the cap, which is what puts them on the free tier with nine Topics', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    // The premise, checked rather than assumed: the cap moved and the Topics did not.
    expect(
      h.driver.prepare('SELECT tier FROM users LIMIT 1').get(),
    ).toEqual({ tier: 'free' });
    expect(await topicsTheyHold()).toHaveLength(9);
  });

  it('is told how many of their Topics are over the cap, before anything is removed', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    const page = await get(BILLING_SETTINGS_PATH);

    // Checked on the page rather than in a log because this is the claim to a
    // person: 6 of 9 are past a cap of 3, and the page says so in numbers before it
    // asks anything.
    expect(page.body).toMatch(/hold 9 topics and the free plan holds 3/);
    expect(page.body).toMatch(/6 of them are over the cap/);
    expect(await topicsTheyHold()).toHaveLength(9);
  });

  it('is shown which Topics keep working and which stop, and offered the choice', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    const page = await get(BILLING_SETTINGS_PATH);

    // Every one of the nine is named, so the split is between two things the User
    // can read rather than between a number and a rule. Escaped because that is how
    // a page renders a title, and one of the Directory's own is "Labour & jobs".
    const titles = heldTopics().map((topic) => topic.title);
    expect(titles).toHaveLength(9);
    for (const title of titles) expect(page.body).toContain(escapeHtml(title));
    // Three ticked: the ones added last. The other six are named in the same list,
    // unticked, which is what "stops being emailed" means on this page.
    expect(
      [...page.body.matchAll(/name="keep" value="[^"]+" checked/g)],
    ).toHaveLength(3);
    expect(page.body).toMatch(/every topic you leave unticked stops being emailed/i);
  });

  it('offers the answer as a submission the guard can check, not a link', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    const page = await get(BILLING_SETTINGS_PATH);

    expect(page.body).toMatch(
      new RegExp(`<form method="post" action="${BILLING_TOPICS_PATH}"`),
    );
    expect(page.body).toMatch(/name="requestToken"/);
  });

  it('keeps every Topic when they do nothing, and refuses a new one with the reason', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    // Doing nothing: pages read, no submission made.
    await get(BILLING_SETTINGS_PATH);
    await get('/topics');
    expect(await topicsTheyHold()).toHaveLength(9);

    // And the refusal says why, rather than the cap number as though that were the
    // problem. Six are past it, none of them has been touched, and the decision is
    // one page away.
    const refused = await submitForm(h.app, h.cookie, '/pick-topics', {
      templateIds: await templateIds(h.app, 2, 40),
    });
    expect(refused.statusCode).toBe(402);
    expect(refused.body).toMatch(/6 of them are over the cap/);
    expect(refused.body).toMatch(/Nothing has been removed/);
    expect(refused.body).toContain(`href="${BILLING_SETTINGS_PATH}"`);
    expect(await topicsTheyHold()).toHaveLength(9);
  });

  it('is refused a new Topic on the surfaces that warn about it too', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    for (const url of ['/topics', '/pick-topics', '/discover']) {
      const page = await get(url);
      // The reason, on each of the three that carry it before a refusal rather than
      // after one.
      expect(page.body, `${url} does not say why`).toMatch(/6 of them are over the cap/);
      expect(page.body, `${url} does not point at the decision`).toContain(
        `href="${BILLING_SETTINGS_PATH}"`,
      );
      // And the upgrade page is not offered as the answer: somebody over the cap has
      // already been offered the paid plan and taken it once. Checked against the
      // callout rather than against a phrase, so rewording the at-cap sentence below
      // it cannot make this pass vacuously.
      const paywalls = page.body.match(/<div class="callout callout--paywall">[\s\S]*?(?=<div class="callout|<h2|<ul|<form|$)/g) ?? [];
      expect(paywalls.length, `${url} shows no cap refusal`).toBeGreaterThan(0);
      for (const callout of paywalls) {
        expect(callout, `${url} still offers the upgrade page`).not.toMatch(
          `href="/upgrade"`,
        );
      }
    }
  });

  it('removes exactly the Topics they did not keep, and records the answer', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    const before = heldTopics();
    const page = await get(BILLING_SETTINGS_PATH);
    const kept = [...page.body.matchAll(/name="keep" value="([^"]+)" checked/g)].map(
      (m) => m[1]!,
    );
    expect(kept).toHaveLength(3);

    const answered = await submitForm(h.app, h.cookie, BILLING_TOPICS_PATH, { keep: kept });
    expect(answered.statusCode).toBe(302);

    // The three ticked survive and the six do not, and nothing else moved.
    expect(topicsTheyHold()).toEqual(
      before.filter((topic) => kept.includes(topic.slug)).map((topic) => topic.title),
    );

    // Recorded, with both halves of the answer, so the decision is a fact afterwards
    // rather than something only the state implies.
    const recorded = h.driver
      .prepare('SELECT cap, held, kept_topic_ids, stopped_topic_ids FROM topic_reductions')
      .all() as { cap: number; held: number; kept_topic_ids: string; stopped_topic_ids: string }[];
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.cap).toBe(3);
    expect(recorded[0]?.held).toBe(9);
    expect(JSON.parse(recorded[0]?.kept_topic_ids ?? '[]')).toHaveLength(3);
    expect(JSON.parse(recorded[0]?.stopped_topic_ids ?? '[]')).toHaveLength(6);
  });

  it('says what it did, and is asked nothing more', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();
    const page = await get(BILLING_SETTINGS_PATH);
    const kept = [...page.body.matchAll(/name="keep" value="([^"]+)" checked/g)].map(
      (m) => m[1]!,
    );

    const answered = await submitForm(h.app, h.cookie, BILLING_TOPICS_PATH, { keep: kept });
    const after = await get(answered.headers.location as string);

    expect(after.body).toMatch(/answer has been applied/i);
    expect(after.body).toMatch(/slots in the free plan are free/i);
    // No second question: they are within the cap, so the block is gone.
    expect(after.body).not.toMatch(/name="keep"/);
  });

  it('honours an answer that disagrees with what the page suggested', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    const before = heldTopics();

    // The three oldest, which is the opposite of what the ticked boxes proposed.
    await submitForm(h.app, h.cookie, BILLING_TOPICS_PATH, {
      keep: before.slice(0, 3).map((topic) => topic.slug),
    });

    expect(topicsTheyHold()).toEqual(before.slice(0, 3).map((topic) => topic.title));
  });

  it('changes nothing when the answer ticked nothing at all', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    const answered = await submitForm(h.app, h.cookie, BILLING_TOPICS_PATH, {});

    // A submission whose boxes all arrived empty is not an instruction to remove
    // every Topic the User has, and the page says so rather than showing an error.
    expect(answered.statusCode).toBe(302);
    expect(await topicsTheyHold()).toHaveLength(9);
    const after = await get(answered.headers.location as string);
    expect(after.body).toMatch(/nothing was changed/i);
    expect(after.body).toMatch(/name="keep"/);
  });

  it('changes nothing when the answer ticked more than the free plan holds', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();

    const before = heldTopics();
    const answered = await submitForm(h.app, h.cookie, BILLING_TOPICS_PATH, {
      keep: before.slice(0, 4).map((topic) => topic.slug),
    });

    // Dropping one of the four to fit would be this application making the decision
    // the User was asked for.
    expect(await topicsTheyHold()).toHaveLength(9);
    const after = await get(answered.headers.location as string);
    expect(after.body).toMatch(/more topics than the free plan holds/);
    expect(after.body).toMatch(/nothing has been removed/i);
  });

  it('gives every Topic back to one who pays again before answering', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();
    expect(await topicsTheyHold()).toHaveLength(9);

    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_3', reference, timestamp: h.nowSeconds() }),
    );

    // All nine, still working: nothing was ever removed, so there was nothing to get
    // back, and a plan with no cap asks no question.
    expect(await topicsTheyHold()).toHaveLength(9);
    const page = await get(BILLING_SETTINGS_PATH);
    expect(page.body).toMatch(/You are on the paid plan/);
    expect(page.body).not.toMatch(/name="keep"/);
    // And no answer was recorded for a question they never answered.
    expect(countRows(h.driver, 'topic_reductions')).toBe(0);
  });

  it('asks again of one who pays, stops paying a second time, and never answered', async () => {
    await paidWithNineTopics();
    await theSubscriptionEnds();
    const reference = await startCheckout(h);
    await postWebhook(
      h,
      signedCheckoutCompleted({ eventId: 'evt_3', reference, timestamp: h.nowSeconds() }),
    );
    await theSubscriptionEnds('evt_4');

    // The same nine Topics and the same question, asked fresh from the state rather
    // than replayed from anything stored the first time.
    const page = await get(BILLING_SETTINGS_PATH);
    expect(page.body).toMatch(/hold 9 topics and the free plan holds 3/);
    expect([...page.body.matchAll(/name="keep" value="[^"]+" checked/g)]).toHaveLength(3);
    expect(await topicsTheyHold()).toHaveLength(9);
  });
});

describe('the webhook route declares itself', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
    vi.unstubAllGlobals();
  });

  it('is on the public allowlist, because the provider is not signed in', () => {
    expect(PUBLIC_ROUTES.has(`POST ${BILLING_WEBHOOK_PATH}`)).toBe(true);
  });

  it('registers as public rather than reaching for a session it will never have', () => {
    const registered = h.app.routeManifest.find((r) => r.url === BILLING_WEBHOOK_PATH);
    expect(registered?.access).toBe('public');
  });

  it('is named as a write the cross-site guard cannot sit in front of, with a reason', () => {
    // The check itself is `write-guard.test.ts`'s, which fails the build for a
    // reason under twenty characters. What this asserts is that this particular
    // route is one of the named ones — the guard cannot be trusted by a reader of
    // the billing code alone to be covering the one public write that moves a
    // User's tier.
    expect(WRITE_GUARD_EXEMPTIONS.get(`POST ${BILLING_WEBHOOK_PATH}`)).toMatch(
      /signature over the raw body/,
    );
  });
});