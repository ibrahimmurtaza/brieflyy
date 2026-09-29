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

async function signIn(
  email: string,
): Promise<{
  app: FastifyInstance;
  transport: ConsoleEmailTransport;
  cookie: string;
}> {
  const { app, transport } = await makeTestApp();
  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email },
  });
  const text = transport.snapshot()[0]!.text;
  const token = extractMagicLinkToken(text);
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const setCookie = verify.headers['set-cookie'];
  const setCookieText = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  const cookie = setCookieText.split(';')[0]!;
  return { app, transport, cookie };
}

async function signInFresh(): Promise<{
  app: FastifyInstance;
  transport: ConsoleEmailTransport;
  cookie: string;
}> {
  return signIn('iris@example.com');
}

/**
 * A second user in the *same* app and database. Two separate apps would each
 * get their own test database, so a cross-user test built that way proves
 * nothing about ownership scoping.
 */
async function signInSecond(
  app: FastifyInstance,
  transport: ConsoleEmailTransport,
  email: string,
): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email },
  });
  const text = transport.snapshot().at(-1)!.text;
  const token = extractMagicLinkToken(text);
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const setCookie = verify.headers['set-cookie'];
  const setCookieText = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  return setCookieText.split(';')[0]!;
}

/** Slugs of the topics the user currently holds, read off the manage page. */
function slugsOnPage(body: string): string[] {
  return [...body.matchAll(/name="slug" value="([^"]*)"/g)].map((m) => m[1]!);
}

async function firstSlug(
  app: FastifyInstance,
  cookie: string,
): Promise<string> {
  const page = await app.inject({
    method: 'GET',
    url: '/pick-topics',
    headers: { cookie },
  });
  expect(page.statusCode).toBe(200);
  const slug = slugsOnPage(page.body)[0];
  expect(slug).toBeDefined();
  return slug!;
}

async function removeFirstTopic(
  app: FastifyInstance,
  cookie: string,
): Promise<void> {
  const slug = await firstSlug(app, cookie);
  const response = await app.inject({
    method: 'POST',
    url: '/pick-topics/remove',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    payload: `slug=${encodeURIComponent(slug)}`,
  });
  expect(response.statusCode).toBe(302);
}

/**
 * The Directory template ids the User already holds, worked out by asking the
 * picker which cards it marks as added.
 *
 * Read from the page rather than from the database so the helper cannot disagree
 * with the rendering the assertions are about.
 */
async function templateIdsAlreadyHeld(
  app: FastifyInstance,
  cookie: string,
): Promise<string[]> {
  const page = await app.inject({
    method: 'GET',
    url: '/pick-topics',
    headers: { cookie },
  });
  expect(page.statusCode).toBe(200);
  return [...page.body.matchAll(/name="templateIds" value="([^"]+)"[^>]*disabled/g)].map(
    (m) => m[1]!,
  );
}

/** The slugs the User currently holds, from "Your topics" on the picker. */
async function slugsHeld(app: FastifyInstance, cookie: string): Promise<string[]> {
  return slugsOnPage(
    (
      await app.inject({ method: 'GET', url: '/pick-topics', headers: { cookie } })
    ).body,
  );
}

async function setDeliveryTime(
  app: FastifyInstance,
  cookie: string,
  time: { hour: number; minute: number; timezone: string },
): Promise<void> {
  const response = await app.inject({
    method: 'POST',
    url: '/onboarding/delivery-time',
    headers: {
      cookie,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: `hour=${time.hour}&minute=${time.minute}&timezone=${encodeURIComponent(time.timezone)}`,
  });
  expect(response.statusCode).toBe(302);
}

async function fetchTemplateIds(
  app: FastifyInstance,
  cookie: string,
): Promise<string[]> {
  const api = await app.inject({
    method: 'GET',
    url: '/api/onboarding/templates',
    headers: { cookie },
  });
  expect(api.statusCode).toBe(200);
  const body = api.json() as { templates: { id: string; title: string }[] };
  return body.templates.map((t) => t.id);
}

describe('HTTP: GET /onboarding/pick-topics', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    resetDeterministic();
  });
  afterEach(async () => {
    await app.close();
  });

  it('redirects to /signup when not authenticated', async () => {
    ({ app } = await makeTestApp());
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/signup');
  });

  it('renders the Directory templates and the free-form field for an authenticated user', async () => {
    const { app: signedInApp, cookie } = await signInFresh();
    app = signedInApp;

    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Pick your topics');
    expect(response.body).toContain('name="templateIds"');
    expect(response.body).toContain('name="freeformTitle"');
    expect(response.body).toContain('iris@example.com');
    expect(response.body).toContain('Save topics');
  });

  it('shows the paywall message when the user already has three topics', async () => {
    const { app: signedInApp, cookie } = await signInFresh();
    app = signedInApp;
    const ids = await fetchTemplateIds(app, cookie);
    expect(ids.length).toBeGreaterThanOrEqual(3);

    const firstSubmit = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[0]}&templateIds=${ids[1]}&templateIds=${ids[2]}`,
    });
    expect(firstSubmit.statusCode).toBe(302);
    expect(firstSubmit.headers.location).toBe('/onboarding/delivery-time');

    const page = await app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('free-topic limit');
  });
});

describe('HTTP: GET /api/onboarding/templates', () => {
  let app: FastifyInstance;
  beforeEach(() => {
    resetDeterministic();
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns the seeded Directory templates', async () => {
    const { app: signedInApp, cookie } = await signInFresh();
    app = signedInApp;

    const response = await app.inject({
      method: 'GET',
      url: '/api/onboarding/templates',
      headers: { cookie },
    });

    expect(response.statusCode).toBe(200);
    const body = response.json() as {
      templates: { id: string; title: string; blurb: string }[];
    };
    expect(body.templates.length).toBeGreaterThanOrEqual(3);
    for (const t of body.templates) {
      expect(t.id.length).toBeGreaterThan(0);
      expect(t.title.length).toBeGreaterThan(0);
      expect(t.blurb.length).toBeGreaterThan(0);
    }
  });
});

describe('HTTP: POST /onboarding/pick-topics', () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    resetDeterministic();
    const ctx = await signInFresh();
    app = ctx.app;
    cookie = ctx.cookie;
  });
  afterEach(async () => {
    await app.close();
  });

  it('redirects to /onboarding/delivery-time on a valid three-template selection', async () => {
    const ids = await fetchTemplateIds(app, cookie);
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[0]}&templateIds=${ids[1]}&templateIds=${ids[2]}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/delivery-time');
  });

  it('accepts two templates plus a free-form topic', async () => {
    const ids = await fetchTemplateIds(app, cookie);
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[0]}&templateIds=${ids[1]}&freeformTitle=Fusion%20energy`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/delivery-time');
  });

  it('returns 400 with a human message when the count is wrong', async () => {
    const ids = await fetchTemplateIds(app, cookie);
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[0]}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/exactly 3/);
  });

  it('returns 400 when the same template is picked twice', async () => {
    const ids = await fetchTemplateIds(app, cookie);
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[0]}&templateIds=${ids[0]}&templateIds=${ids[1]}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/more than once/);
  });

  it('returns 400 when a template id is unknown', async () => {
    const ids = await fetchTemplateIds(app, cookie);
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[0]}&templateIds=tmpl_does_not_exist&templateIds=tmpl_also_bogus`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/not in the Directory/);
  });

  it('returns 402 with a paywall page when the user already has three topics', async () => {
    const ids = await fetchTemplateIds(app, cookie);
    const first = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[0]}&templateIds=${ids[1]}&templateIds=${ids[2]}`,
    });
    expect(first.statusCode).toBe(302);

    const second = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[3]}&templateIds=${ids[4]}&templateIds=${ids[5]}`,
    });
    expect(second.statusCode).toBe(402);
    expect(second.body).toMatch(/free-topic limit/);
    expect(second.body).toMatch(/Upgrade/);
    expect(second.body).toMatch(/href="\/upgrade"/);
    // The promise the paywall makes has to land somewhere. This used to 404.
    const upgrade = await app.inject({
      method: 'GET',
      url: '/upgrade',
      headers: { cookie },
    });
    expect(upgrade.statusCode).toBe(200);
    expect(upgrade.body).toMatch(/isn't connected yet|isn&#39;t connected yet/);
  });

  it('redirects to /signup when the user is not authenticated', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'templateIds=a&templateIds=b&templateIds=c',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/signup');
  });
});

describe('HTTP: GET /onboarding/delivery-time', () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    const ctx = await signInFresh();
    app = ctx.app;
    cookie = ctx.cookie;
  });
  afterEach(async () => {
    await app.close();
  });

  it('renders the form for signed-in users', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/delivery-time',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/Pick your delivery time/);
    expect(response.body).toMatch(/name="hour"/);
    expect(response.body).toMatch(/name="minute"/);
    expect(response.body).toMatch(/name="timezone"/);
  });

  it('offers Save and continue, and no change control, while no time is set yet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/delivery-time',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    // A prefilled suggestion is not a saved time, so there is nothing to state
    // and nothing to change: the form is the whole page.
    expect(response.body).not.toMatch(/arrives daily at/);
    expect(response.body).not.toMatch(/Change delivery time/);
    expect(response.body).toMatch(/>Save and continue<\/button>/);
    // The button no longer changes meaning, so nothing needs a script to do it.
    expect(response.body).not.toMatch(/data-initial-hour/);
    expect(response.body).not.toMatch(/<script/);
  });

  it('sends a user who already has a time to the settings screen, not onboarding', async () => {
    await setDeliveryTime(app, cookie, {
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/delivery-time',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/settings/delivery');
  });

  it('states the time already set and offers a change control on the settings screen', async () => {
    await setDeliveryTime(app, cookie, {
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/settings/delivery',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(
      /arrives daily at <strong>08:00<\/strong> \(America\/New_York\)/,
    );
    expect(response.body).toMatch(
      /<details class="change" id="change-delivery">/,
    );
    expect(response.body).toMatch(/<summary>Change delivery time<\/summary>/);
    expect(response.body).toMatch(/action="\/settings\/delivery"/);
    expect(response.body).toMatch(/>Save time<\/button>/);
    // The change control is a native disclosure, so it works without JavaScript.
    expect(response.body).not.toMatch(/<script/);
  });

  it('confirms a save on the settings screen and shows the new time', async () => {
    await setDeliveryTime(app, cookie, {
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    const saved = await app.inject({
      method: 'POST',
      url: '/settings/delivery',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=19&minute=30&timezone=America%2FNew_York',
    });
    expect(saved.statusCode).toBe(302);
    expect(saved.headers.location).toBe('/settings/delivery?saved=1');

    const after = await app.inject({
      method: 'GET',
      url: '/settings/delivery?saved=1',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.body).toMatch(/Time saved\./);
    expect(after.body).toMatch(/arrives daily at <strong>19:30<\/strong>/);
  });


  it('redirects to /signup when not authenticated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/delivery-time',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/signup');
  });
});

describe('HTTP: POST /onboarding/delivery-time', () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    const ctx = await signInFresh();
    app = ctx.app;
    cookie = ctx.cookie;
  });
  afterEach(async () => {
    await app.close();
  });

  it('redirects to /onboarding/welcome on a valid submission', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=8&minute=0&timezone=America%2FNew_York',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/welcome');
  });

  it('advances to welcome even when a time that was already set changes', async () => {
    await setDeliveryTime(app, cookie, {
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=19&minute=30&timezone=America%2FNew_York',
    });
    // No inference: this endpoint exists to finish onboarding, so it saves and
    // moves on. Editing an existing time is what the settings screen is for.
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/welcome');
  });

  it('advances rather than bouncing when the time is submitted unchanged', async () => {
    await setDeliveryTime(app, cookie, {
      hour: 8,
      minute: 0,
      timezone: 'America/New_York',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=8&minute=0&timezone=America%2FNew_York',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/welcome');
  });

  it('advances for a first pick even when it differs from the suggestion', async () => {
    // Nothing is stored, so there is no saved time to edit; every pick is a
    // first pick, and the screen says Continue.
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=19&minute=30&timezone=America%2FNew_York',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/welcome');
  });

  it('returns 400 with a human message for an out-of-range hour', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=99&minute=0&timezone=UTC',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/valid time/);
  });

  it('returns 400 with a human message for an unknown timezone', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=8&minute=0&timezone=Mars%2FOlympus',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/valid time/);
  });

  it('redirects to /signup when not authenticated', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'hour=8&minute=0&timezone=UTC',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/signup');
  });
});

describe('HTTP: GET /onboarding/welcome', () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    const ctx = await signInFresh();
    app = ctx.app;
    cookie = ctx.cookie;
  });
  afterEach(async () => {
    await app.close();
  });

  it('redirects to the picker if the user has no settings yet', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/welcome',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/delivery-time');
  });

  it('shows the confirmation after a delivery time is set', async () => {
    await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=8&minute=0&timezone=America%2FNew_York',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/welcome',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/You're set up/);
    expect(response.body).toMatch(/first brief arrives/i);
    expect(response.body).toMatch(/America\/New_York/);
  });
});

describe('HTTP: GET/POST /settings/delivery', () => {
  let app: FastifyInstance;
  let cookie: string;
  beforeEach(async () => {
    const ctx = await signInFresh();
    app = ctx.app;
    cookie = ctx.cookie;
  });
  afterEach(async () => {
    await app.close();
  });

  it('GET redirects to the picker when no delivery time is set', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/settings/delivery',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/delivery-time');
  });

  it('GET renders the settings form when a delivery time is set', async () => {
    await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=8&minute=0&timezone=America%2FNew_York',
    });
    const response = await app.inject({
      method: 'GET',
      url: '/settings/delivery',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/Delivery time/);
    expect(response.body).toMatch(/name="hour"/);
  });

  it('POST updates the delivery time and redirects to the settings page', async () => {
    await app.inject({
      method: 'POST',
      url: '/onboarding/delivery-time',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=8&minute=0&timezone=America%2FNew_York',
    });
    const response = await app.inject({
      method: 'POST',
      url: '/settings/delivery',
      headers: {
        cookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: 'hour=9&minute=30&timezone=Europe%2FLondon',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/settings/delivery?saved=1');

    const after = await app.inject({
      method: 'GET',
      url: '/settings/delivery?saved=1',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(200);
    expect(after.body).toMatch(/Time saved\./);
    expect(after.body).toMatch(/arrives daily at <strong>09:30<\/strong>/);
    expect(after.body).toMatch(/value="9"/);
    expect(after.body).toMatch(/value="30"/);
    expect(after.body).toMatch(/Europe\/London/);
  });
});

describe('HTTP: /pick-topics (managing topics after onboarding)', () => {
  let app: FastifyInstance;
  let transport: ConsoleEmailTransport;
  let cookie: string;
  let ids: string[];

  beforeEach(async () => {
    ({ app, transport, cookie } = await signInFresh());
    ids = await fetchTemplateIds(app, cookie);
    const picked = await app.inject({
      method: 'POST',
      url: '/onboarding/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `templateIds=${ids[0]}&templateIds=${ids[1]}&templateIds=${ids[2]}`,
    });
    expect(picked.statusCode).toBe(302);
    await setDeliveryTime(app, cookie, {
      hour: 8,
      minute: 0,
      timezone: 'Europe/London',
    });
  });

  afterEach(async () => {
    await app.close();
  });

  it('redirects a completed user away from the onboarding screen', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/pick-topics');
  });

  it('adds a topic when the user is below the cap', async () => {
    await removeFirstTopic(app, cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `templateIds=${ids[3]}`,
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/topics');

    const page = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(slugsOnPage(page.body)).toHaveLength(3);
  });

  it('refuses a fourth topic with the paywall', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `templateIds=${ids[3]}`,
    });
    expect(response.statusCode).toBe(402);
    expect(response.body).toMatch(/free-topic limit/);
  });

  it('disables the checkboxes when a free user is at the cap', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.body).toMatch(/You are using all 3 free topics/);
    expect(response.body).toMatch(/name="templateIds"[^>]*disabled/);
    expect(response.body).toMatch(/<button type="submit" disabled>Add topics<\/button>/);
  });

  it('leaves the checkboxes enabled below the cap, except for topics already held', async () => {
    await removeFirstTopic(app, cookie);
    const response = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(response.body).toMatch(/Pick up to 1 more topic/);
    // Two reasons a box can be disabled, and the page needs to tell them apart:
    // the User is at the cap, or they already hold that Topic. The second is
    // shown rather than hidden, so "Already added" is the only thing that
    // should carry a disabled box here.
    const disabled = [...response.body.matchAll(/name="templateIds" value="([^"]+)"[^>]*disabled/g)]
      .map((m) => m[1]);
    const held = new Set(await templateIdsAlreadyHeld(app, cookie));
    expect(disabled.sort()).toEqual([...held].sort());
    expect(response.body).toMatch(/Already added/);
  });

  it('does not offer a topic the user already holds, and says which ones', async () => {
    // The reported defect: ticking a Directory topic the User already had added
    // a second copy of it, suffixed so the two rows could coexist. Below the cap
    // first, so the only reason a box is disabled is that it is already held.
    await removeFirstTopic(app, cookie);
    const response = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    const held = await templateIdsAlreadyHeld(app, cookie);
    expect(held.length).toBe(2);
    expect((response.body.match(/Already added/g) ?? []).length).toBe(2);
    // And the other eight are still on offer.
    const offered = [...response.body.matchAll(/name="templateIds" value="([^"]+)"/g)]
      .map((m) => m[1]!)
      .filter((id) => !held.includes(id));
    expect(offered.length).toBeGreaterThanOrEqual(8);
  });

  it('refuses a posted topic the user already holds, rather than adding a second copy', async () => {
    await removeFirstTopic(app, cookie);
    const held = await templateIdsAlreadyHeld(app, cookie);
    const before = await slugsHeld(app, cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `templateIds=${held[0]}`,
    });

    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/already have one of those topics/);
    expect(await slugsHeld(app, cookie)).toEqual(before);
  });

  it('offers a remove control for each of the user topics', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(response.body).toMatch(/action="\/pick-topics\/remove"/);
    expect(response.body).toMatch(/Its past briefs are kept/);
  });

  it('does not offer a remove control during onboarding', async () => {
    const fresh = await signInFresh();
    try {
      const response = await fresh.app.inject({
        method: 'GET',
        url: '/onboarding/pick-topics',
        headers: { cookie: fresh.cookie },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).not.toMatch(/action="\/pick-topics\/remove"/);
    } finally {
      await fresh.app.close();
    }
  });

  it('frees a slot when a topic is removed, so a replacement can be added', async () => {
    const slug = await firstSlug(app, cookie);
    const remove = await app.inject({
      method: 'POST',
      url: '/pick-topics/remove',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `slug=${encodeURIComponent(slug)}`,
    });
    expect(remove.statusCode).toBe(302);
    expect(remove.headers.location).toBe('/pick-topics');

    const add = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `templateIds=${ids[3]}`,
    });
    expect(add.statusCode).toBe(302);

    const page = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(slugsOnPage(page.body)).toHaveLength(3);
  });

  it('will not remove a topic owned by another user', async () => {
    // Same app, same database: a different account, not a different world.
    const attackerCookie = await signInSecond(app, transport, 'mallory@example.com');
    const ownerSlug = await firstSlug(app, cookie);

    const response = await app.inject({
      method: 'POST',
      url: '/pick-topics/remove',
      headers: {
        cookie: attackerCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `slug=${encodeURIComponent(ownerSlug)}`,
    });
    expect(response.statusCode).toBe(404);

    // The owner still has all three.
    const page = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(slugsOnPage(page.body)).toHaveLength(3);
  });

  it('will not let a second user spend the owner’s free slots', async () => {
    const attackerCookie = await signInSecond(app, transport, 'mallory@example.com');

    const response = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: {
        cookie: attackerCookie,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `templateIds=${ids[3]}`,
    });
    // Mallory is a separate user with no topics, so she has all 3 slots.
    expect(response.statusCode).toBe(302);

    const page = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie: attackerCookie },
    });
    expect(slugsOnPage(page.body)).toHaveLength(1);

    // And the owner is unaffected.
    const ownerPage = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(slugsOnPage(ownerPage.body)).toHaveLength(3);
  });

  it('re-adds a topic that was removed, without tripping the unique index', async () => {
    // Template ids are their slugs, so removing a topic and picking the same
    // template again must reuse a slug that no active topic holds.
    const slug = ids[0]!;
    const remove = await app.inject({
      method: 'POST',
      url: '/pick-topics/remove',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `slug=${encodeURIComponent(slug)}`,
    });
    expect(remove.statusCode).toBe(302);

    const readd = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: `templateIds=${encodeURIComponent(slug)}`,
    });
    expect(readd.statusCode).toBe(302);

    const page = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    const slugs = slugsOnPage(page.body);
    expect(slugs).toHaveLength(3);
    // The unique index still spans the removed row, so the re-added topic
    // takes the next free slug rather than colliding.
    expect(slugs).toContain(`${slug}-2`);
  });

  it('re-adds a removed freeform topic without tripping the unique index', async () => {
    // Free a slot, then use it for a freeform topic.
    await removeFirstTopic(app, cookie);
    const added = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'freeformTitle=Fusion%20Energy',
    });
    expect(added.statusCode).toBe(302);

    // Now remove that freeform topic and pick the same title again.
    const remove = await app.inject({
      method: 'POST',
      url: '/pick-topics/remove',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'slug=fusion-energy',
    });
    expect(remove.statusCode).toBe(302);

    const readd = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'freeformTitle=Fusion%20Energy',
    });
    expect(readd.statusCode).toBe(302);

    const page = await app.inject({
      method: 'GET',
      url: '/pick-topics',
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(slugsOnPage(page.body)).toHaveLength(3);
  });

  it('rejects an empty selection on the manage form', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/pick-topics',
      headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toMatch(/Pick at least one topic/);
  });

  it('redirects to /signup when not authenticated', async () => {
    const response = await app.inject({ method: 'GET', url: '/pick-topics' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/signup');
  });
});
