import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { INITIAL_TOPIC_COUNT } from '../onboarding/onboarding-service.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';

async function makeTestApp(): Promise<{
  app: FastifyInstance;
  transport: ConsoleEmailTransport;
}> {
  resetDeterministic();
  const { db } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(new Date('2026-01-01T00:00:00Z')).clock,
    random: deterministicRandom,
  });
  return { app, transport };
}

describe('HTTP: /topics', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });

  afterEach(async () => {
    await app.close();
  });

  it('redirects to /signup when not authenticated', async () => {
    const resp = await app.inject({ method: 'GET', url: '/topics' });
    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/signup');
  });

  it('says so, rather than showing a list of nothing, to a User with no Topics', async () => {
    const { app: signedIn, cookie } = await signInFresh();
    try {
      const resp = await signedIn.inject({
        method: 'GET',
        url: '/topics',
        headers: { cookie },
      });
      expect(resp.statusCode).toBe(200);
      expect(resp.body).toContain("You haven't picked any topics yet");
      // The way out of an empty page is the whole point of it: a User who has
      // nothing has to be able to go and get something.
      expect(resp.body).toContain('href="/pick-topics"');
      // And no row pretending one of them exists.
      expect(resp.body).not.toContain('<ul class="topics">\n\n</ul>');
    } finally {
      await signedIn.close();
    }
  });

  it('lists each of the signed-in User\'s Topics, linked to its LivingBrief', async () => {
    // The page a User opens Brieflyy to see. The assertions that stood behind it
    // were all about the layout around it or about the tier, so the one thing the
    // page exists to do (each of their Topics is on it, and each one is a way into
    // its LivingBrief) had nothing of its own at this seam.
    const { app: signedIn, cookie } = await signInOnboarded(3);
    try {
      const resp = await signedIn.inject({
        method: 'GET',
        url: '/topics',
        headers: { cookie },
      });
      expect(resp.statusCode).toBe(200);

      const held = [...resp.body.matchAll(/<a href="\/topics\/([^"]+)">([^<]+)<\/a>/g)].map(
        (m) => ({ slug: m[1]!, title: m[2]! }),
      );
      expect(held).toHaveLength(3);
      // Every entry is a link into that Topic, so the count is not a list of
      // strings: a page that named three Topics and linked to none would pass a
      // test that only looked for the titles.
      for (const entry of held) {
        const brief = await signedIn.inject({
          method: 'GET',
          url: `/topics/${entry.slug}`,
          headers: { cookie },
        });
        expect(brief.statusCode, `${entry.slug} is listed but does not open`).toBe(200);
        expect(brief.body).toContain(entry.title);
      }
    } finally {
      await signedIn.close();
    }
  });

  it('leaves another User\'s Topics off the list', async () => {
    const { app: signedIn, transport, cookie } = await signInOnboarded();
    try {
      const before = await signedIn.inject({
        method: 'GET',
        url: '/topics',
        headers: { cookie },
      });
      const slugs = [...before.body.matchAll(/href="\/topics\/([^"]+)"/g)].map((m) => m[1]!);
      expect(slugs.length).toBeGreaterThan(0);

      // A second User, signed in through the same application, who has picked
      // nothing. The page they land on is empty, and the first User's Topics are
      // not in it.
      const other = await signInOn({ app: signedIn, transport, email: 'owen@example.com' });
      const after = await signedIn.inject({
        method: 'GET',
        url: '/topics',
        headers: { cookie: other },
      });
      expect(after.statusCode).toBe(200);
      expect(after.body).toContain("You haven't picked any topics yet");
      for (const slug of slugs) {
        expect(after.body, `${slug} leaked to another User`).not.toContain(
          `href="/topics/${slug}"`,
        );
      }
    } finally {
      await signedIn.close();
    }
  });
});

describe('HTTP: /topics/:slug', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    ({ app } = await makeTestApp());
  });

  afterEach(async () => {
    await app.close();
  });

  it('redirects to /signup when not authenticated', async () => {
    const resp = await app.inject({ method: 'GET', url: '/topics/world-news' });
    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/signup');
  });
});

/**
 * One address, signed in the way a person signs in: a magic link asked for, read
 * back out of the mail it produced, and opened.
 *
 * The mail is read rather than the row written because the seam these tests are
 * about is the route. A session inserted straight into the table would leave the
 * half of the path a User actually walks untested everywhere it is used.
 */
async function signInOn(input: {
  readonly app: FastifyInstance;
  readonly transport: ConsoleEmailTransport;
  readonly email: string;
}): Promise<string> {
  await input.app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: input.email },
  });
  // The last message, not the first: a second address on the same application
  // has a magic link of its own behind the first.
  const token = extractMagicLinkToken(input.transport.snapshot().at(-1)!.text);
  const verify = await input.app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const setCookie = verify.headers['set-cookie'];
  const setCookieText = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  // The session and the request token: a browser is handed a page before it can
  // submit a form, and every write checks the pair (ADR-0021).
  const { cookies } = await signedInCookies(input.app, setCookieText.split(';')[0]!);
  return cookies;
}

async function signInFresh(): Promise<{
  app: FastifyInstance;
  transport: ConsoleEmailTransport;
  cookie: string;
}> {
  const { app, transport } = await makeTestApp();
  return { app, transport, cookie: await signInOn({ app, transport, email: 'iris@example.com' }) };
}

async function firstTemplateIds(app: FastifyInstance, count: number): Promise<string[]> {
  const resp = await app.inject({ method: 'GET', url: '/api/onboarding/templates' });
  return (resp.json() as { templates: { id: string }[] }).templates
    .slice(0, count)
    .map((t) => t.id);
}

/**
 * A signed-in User past onboarding, so none of the pages redirect them away on
 * arrival.
 *
 * At module scope rather than inside one describe because three suites need it,
 * and a helper that has to be copied to be reachable from each is a helper whose
 * copies can drift apart.
 */
async function signInOnboarded(
  count = INITIAL_TOPIC_COUNT,
): Promise<{
  app: FastifyInstance;
  transport: ConsoleEmailTransport;
  cookie: string;
}> {
  const made = await signInFresh();
  await submitForm(
    made.app,
    made.cookie,
    '/onboarding/pick-topics',
    { templateIds: await firstTemplateIds(made.app, count) },
  );
  await submitForm(
    made.app,
    made.cookie,
    '/onboarding/delivery-time',
    'hour=8&minute=0&timezone=UTC',
  );
  return made;
}

describe('HTTP: /upgrade', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    ({ app, cookie } = await signInFresh());
  });

  afterEach(async () => {
    await app.close();
  });

  it('is a real page, not a 404', async () => {
    const resp = await app.inject({
      method: 'GET',
      url: '/upgrade',
      headers: { cookie },
    });
    expect(resp.statusCode).toBe(200);
    expect(resp.body).toMatch(/Upgrade to paid/);
  });

  it('offers no checkout on an instance that cannot take a payment', async () => {
    const resp = await app.inject({
      method: 'GET',
      url: '/upgrade',
      headers: { cookie },
    });
    expect(resp.body).toMatch(/Billing isn&#39;t connected yet|isn't connected yet/);
    // Nothing to submit: a form in the page's own content would be a button that
    // goes nowhere. The invariant is scoped to `<main>` because the shared header
    // carries the sign-out form, and sign-out is not a checkout. It holds because
    // this application has no PaymentProvider configured, which is the condition
    // the sentence above states — where one is configured, `src/billing/` has the
    // form and the case where it is submitted.
    const main = resp.body.match(/<main[^>]*>[\s\S]*<\/main>/)?.[0] ?? resp.body;
    expect(main).not.toMatch(/<form/);
  });

  it('states what paid includes and how many topics the user is using', async () => {
    const resp = await app.inject({
      method: 'GET',
      url: '/upgrade',
      headers: { cookie },
    });
    expect(resp.body).toMatch(/unlimited topics/);
    expect(resp.body).toMatch(/\$15 \/ month/);
    expect(resp.body).toMatch(/you are using 0 topics/);
  });

  it('redirects to /signup when not authenticated', async () => {
    const resp = await app.inject({ method: 'GET', url: '/upgrade' });
    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/signup');
  });
});

/**
 * Every screen a signed-in User can land on, and what it has to be able to reach
 * from.
 *
 * Five separate navigation implementations used to coexist, and two of the gaps
 * they left were silent: `/archive/search` had no way out of the application at
 * all, and when the per-page navigation was replaced with a shared shell, the
 * "Manage topics" link on `/topics` and on the LivingBrief went with it, leaving
 * `/pick-topics` reachable only from the empty state and the paywall. A User
 * who already had topics and was under the cap could not add or remove one, and
 * no assertion failed. This is the test that would have failed.
 */
describe('HTTP: navigation', () => {
  let app: FastifyInstance;
  let cookie: string;

  const get = (url: string) =>
    app.inject({ method: 'GET', url, headers: { cookie } });

  beforeEach(async () => {
    ({ app, cookie } = await signInOnboarded());
  });

  afterEach(async () => {
    await app.close();
  });

  const REACHABLE: readonly (readonly [string, string])[] = [
    ['/topics', '/pick-topics'],
    ['/pick-topics', '/topics'],
    ['/settings/delivery', '/pick-topics'],
    ['/onboarding/welcome', '/pick-topics'],
    ['/upgrade', '/topics'],
    ['/archive/search', '/topics'],
  ];

  for (const [url, target] of REACHABLE) {
    it(`${url} offers a way to ${target === '/topics' ? 'leave' : 'reach ' + target}`, async () => {
      const resp = await get(url);
      expect(resp.statusCode, `${url} answered ${resp.statusCode}`).toBe(200);
      const hrefs = [...resp.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
      expect(hrefs, `${url} cannot reach ${target}`).toContain(target);
    });
  }

  it('the LivingBrief offers the same way back as the topic list', async () => {
    // The slug is whatever the picker assigned, so it is read off the list.
    const resp = await get('/topics');
    const slug = [...resp.body.matchAll(/href="\/topics\/([^"]+)"/g)][0]?.[1];
    expect(slug, 'the fixture User has no topic to open').toBeDefined();

    const brief = await get(`/topics/${slug!}`);
    expect(brief.statusCode).toBe(200);
    const hrefs = [...brief.body.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
    expect(hrefs, 'the LivingBrief cannot reach /pick-topics').toContain('/pick-topics');
    expect(hrefs, 'the LivingBrief cannot reach /topics').toContain('/topics');
  });
});
