import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
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

async function signInFresh(): Promise<{
  app: FastifyInstance;
  transport: ConsoleEmailTransport;
  cookie: string;
}> {
  const { app, transport } = await makeTestApp();
  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  const text = transport.snapshot()[0]!.text;
  const tokenMatch = text.match(/\btoken=([^\s&]+)/);
  if (!tokenMatch) throw new Error('token missing');
  const token = decodeURIComponent(tokenMatch[1]!);
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const setCookie = verify.headers['set-cookie'];
  const setCookieText = Array.isArray(setCookie) ? setCookie[0]! : setCookie!;
  const cookie = setCookieText.split(';')[0]!;
  return { app, transport, cookie };
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
