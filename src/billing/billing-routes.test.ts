import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
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
  stripeSignatureHeader,
  type SignedWebhook,
} from '../testing/stripe-webhook.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { StripePaymentProvider } from './stripe-payment-provider.js';
import { BILLING_WEBHOOK_PATH, CHECKOUT_PATH } from './paths.js';

const NOW = new Date('2026-03-01T12:00:00Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const HOSTED_CHECKOUT_URL = 'https://checkout.brieflyy.test/pay/cs_test_1';
const UUID_RE = /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

type Driver = ReturnType<typeof createTestDb>['driver'];

interface Harness {
  readonly app: FastifyInstance;
  /** The session and the request token: what a signed-in browser holds. */
  readonly cookie: string;
  readonly driver: Driver;
  /** Every request the application made to the payment provider, in order. */
  readonly providerCalls: { readonly url: string; readonly body: string }[];
}

/**
 * The application built the way `server.ts` builds it, with the real Stripe
 * PaymentProvider and only the HTTP call out to Stripe stubbed.
 *
 * The seam is the provider's own interface and the double here is the network:
 * everything above it — the reference minted, the signature verified, the tier
 * moved — is the code under test, which is what a test that stubbed the provider
 * itself would stop checking.
 */
async function buildHarness(
  input: { readonly configured?: boolean; readonly devToolsEnabled?: boolean } = {},
): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(NOW).clock;
  const providerCalls: { url: string; body: string }[] = [];

  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    providerCalls.push({ url: String(url), body: String(init.body ?? '') });
    return {
      ok: true,
      async json() {
        return { id: 'cs_test_1', url: HOSTED_CHECKOUT_URL };
      },
    };
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
  return { app, cookie: cookies, driver, providerCalls };
}

/** The first `count` Directory template ids, which is what the picker posts. */
async function templateIds(app: FastifyInstance, count: number): Promise<readonly string[]> {
  const resp = await app.inject({ method: 'GET', url: '/api/onboarding/templates' });
  return (resp.json() as { templates: { id: string }[] }).templates
    .slice(0, count)
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