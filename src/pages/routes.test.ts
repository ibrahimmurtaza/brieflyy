import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
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

async function signInFresh(): Promise<{ app: FastifyInstance; cookie: string }> {
  const { app, transport } = await makeTestApp();
  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  const token = extractMagicLinkToken(transport.snapshot()[0]!.text);
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const setCookie = verify.headers['set-cookie'];
  const setCookieText = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return { app, cookie: setCookieText.split(';')[0]! };
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

  it('says billing is not connected instead of faking a checkout', async () => {
    const resp = await app.inject({
      method: 'GET',
      url: '/upgrade',
      headers: { cookie },
    });
    expect(resp.body).toMatch(/Billing isn&#39;t connected yet|isn't connected yet/);
    // Nothing to submit: a form in the page's own content would be a button that
    // goes nowhere. The invariant is scoped to `<main>` because the shared header
    // carries the sign-out form, and sign-out is not a checkout.
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

  /** A signed-in User past onboarding, so none of these redirect on arrival. */
  async function signInOnboarded(): Promise<{ app: FastifyInstance; cookie: string }> {
    const made = await signInFresh();
    await made.app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: { cookie: made.cookie },
      payload: { templateIds: await firstTemplateIds(made.app, 3) },
    });
    await made.app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie: made.cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=8&minute=0&timezone=UTC',
    });
    return made;
  }

  async function firstTemplateIds(app: FastifyInstance, count: number): Promise<string[]> {
    const resp = await app.inject({ method: 'GET', url: '/api/onboarding/templates' });
    return (resp.json() as { templates: { id: string }[] }).templates
      .slice(0, count)
      .map((t) => t.id);
  }

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
