import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import type { MagicLinkRateLimits } from '../config.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from '../testing/test-clocks.js';

async function makeTestApp(opts?: {
  readonly rateLimits?: MagicLinkRateLimits;
}): Promise<{
  app: FastifyInstance;
  transport: ConsoleEmailTransport;
  driver: ReturnType<typeof createTestDb>['driver'];
  clock: TestClock;
}> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(new Date('2026-01-01T00:00:00Z'));
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: clock.clock,
    random: deterministicRandom,
    ...(opts?.rateLimits ? { magicLinkRateLimits: opts.rateLimits } : {}),
  });
  return { app, transport, driver, clock };
}

import { countRows } from '../testing/db.js';
import { extractMagicLinkToken as extractToken } from '../testing/email.js';

describe('HTTP: /auth/magic-link/request', () => {
  let app: FastifyInstance;
  let transport: ConsoleEmailTransport;
  let driver: ReturnType<typeof createTestDb>['driver'];
  beforeEach(async () => {
    const ctx = await makeTestApp();
    app = ctx.app;
    transport = ctx.transport;
    driver = ctx.driver;
  });
  afterEach(async () => {
    await app.close();
  });

  it('returns 202 and sends a magic link for a valid email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ email: 'iris@example.com' });
    expect(transport.snapshot()).toHaveLength(1);
  });

  it('answers a known address exactly as it answers an unknown one', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const token = extractToken(transport.snapshot()[0]!.text);
    await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });

    const known = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const unknown = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'stranger@example.com' },
    });

    expect(known.statusCode).toBe(unknown.statusCode);
    expect(Object.keys(known.json()).sort()).toEqual(Object.keys(unknown.json()).sort());
    expect(JSON.stringify(known.json()).replace(/iris/g, 'x')).toBe(
      JSON.stringify(unknown.json()).replace(/stranger/g, 'x'),
    );
  });

  it('does not say whether the address is new', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    expect(response.body).not.toMatch(/new|existing|sentTo/i);
  });

  it('creates no User and no Account until the link is verified', async () => {
    const requested = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    expect(requested.statusCode).toBe(202);
    expect(countRows(driver, 'users')).toBe(0);
    expect(countRows(driver, 'accounts')).toBe(0);

    const token = extractToken(transport.snapshot()[0]!.text);
    const verified = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    expect(verified.statusCode).toBe(302);
    expect(countRows(driver, 'users')).toBe(1);
    expect(countRows(driver, 'accounts')).toBe(1);
  });

  it('returns 400 for an invalid email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'not-an-email' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns 400 when email is missing', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: {},
    });
    expect(response.statusCode).toBe(400);
  });
});

describe('HTTP: /auth/magic-link/request rate limit', () => {
  let app: FastifyInstance;
  let transport: ConsoleEmailTransport;
  let clock: TestClock;
  beforeEach(async () => {
    const ctx = await makeTestApp({
      rateLimits: {
        perAddress: { limit: 2, windowMs: 60_000 },
        perSource: { limit: 5, windowMs: 60_000 },
      },
    });
    app = ctx.app;
    transport = ctx.transport;
    clock = ctx.clock;
  });
  afterEach(async () => {
    await app.close();
  });

  function request(email: string, remoteAddress?: string) {
    return app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email },
      ...(remoteAddress ? { remoteAddress } : {}),
    });
  }

  it('refuses the request after the per-address limit, with 429 and a retry hint', async () => {
    expect((await request('iris@example.com')).statusCode).toBe(202);
    expect((await request('iris@example.com')).statusCode).toBe(202);

    const refused = await request('iris@example.com');

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'rate_limited' });
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    expect(transport.snapshot()).toHaveLength(2);
  });

  it('refuses the request after the per-source limit, across different addresses', async () => {
    for (let i = 0; i < 5; i++) {
      expect((await request(`user-${i}@example.com`)).statusCode).toBe(202);
    }

    const refused = await request('user-5@example.com');

    expect(refused.statusCode).toBe(429);
    expect(refused.json()).toEqual({ error: 'rate_limited' });
    expect(transport.snapshot()).toHaveLength(5);
  });

  it('counts each caller separately', async () => {
    for (let i = 0; i < 5; i++) {
      await request(`user-${i}@example.com`, '10.0.0.1');
    }
    expect((await request('user-5@example.com', '10.0.0.1')).statusCode).toBe(429);
    expect((await request('user-5@example.com', '10.0.0.2')).statusCode).toBe(202);
  });

  it('lets an address try again in the next window', async () => {
    await request('iris@example.com');
    await request('iris@example.com');
    expect((await request('iris@example.com')).statusCode).toBe(429);

    clock.advance(60_000);

    expect((await request('iris@example.com')).statusCode).toBe(202);
  });

  it('does not count a request for an invalid address against the limit', async () => {
    expect((await request('not-an-email')).statusCode).toBe(400);
    expect((await request('iris@example.com')).statusCode).toBe(202);
    expect((await request('iris@example.com')).statusCode).toBe(202);
    expect((await request('iris@example.com')).statusCode).toBe(429);
  });

  it('does not spend the per-source quota on requests the per-address limit refused', async () => {
    // 4 requests to one address: the first 2 pass and 2 are refused per address.
    await request('iris@example.com');
    await request('iris@example.com');
    expect((await request('iris@example.com')).statusCode).toBe(429);
    expect((await request('iris@example.com')).statusCode).toBe(429);

    // The per-source limit is 5, and only the 2 that were sent used it up.
    for (let i = 0; i < 3; i++) {
      expect((await request(`other-${i}@example.com`)).statusCode).toBe(202);
    }
  });
});

describe('HTTP: /auth/magic-link/verify', () => {
  let app: FastifyInstance;
  let transport: ConsoleEmailTransport;
  beforeEach(async () => {
    const ctx = await makeTestApp();
    app = ctx.app;
    transport = ctx.transport;
  });
  afterEach(async () => {
    await app.close();
  });

  it('redirects to onboarding and sets the session cookie on first verification', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const token = extractToken(transport.snapshot()[0]!.text);

    const response = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });

    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/onboarding/pick-topics');
    const setCookie = response.headers['set-cookie'];
    const setCookieText = Array.isArray(setCookie) ? setCookie.join(';') : (setCookie ?? '');
    expect(setCookieText).toMatch(/brieflyy_session=/);
    expect(setCookieText).toMatch(/HttpOnly/i);
  });

  it('returns an invalid-link HTML page when the token is unknown', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/auth/magic-link/verify?token=' + 'a'.repeat(64),
    });
    expect(response.statusCode).toBe(400);
    expect(response.headers['content-type']).toMatch(/text\/html/);
    expect(response.body).toContain('Invalid sign-in link');
  });

  it('returns 400 when the token is missing', async () => {
    const response = await app.inject({ method: 'GET', url: '/auth/magic-link/verify' });
    expect(response.statusCode).toBe(400);
  });

  it('returns an invalid-link HTML page on second use of a single-use token', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const token = extractToken(transport.snapshot()[0]!.text);

    const first = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    expect(first.statusCode).toBe(302);

    const second = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('already been used');
  });
});

describe('HTTP: /auth/magic-link/verify → authenticated session', () => {
  let app: FastifyInstance;
  let transport: ConsoleEmailTransport;
  beforeEach(async () => {
    const ctx = await makeTestApp();
    app = ctx.app;
    transport = ctx.transport;
  });
  afterEach(async () => {
    await app.close();
  });

  it('lets an authenticated user reach the onboarding page', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const token = extractToken(transport.snapshot()[0]!.text);

    const verify = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    expect(verify.statusCode).toBe(302);
    const rawCookie = verify.headers['set-cookie'];
    const setCookieText = Array.isArray(rawCookie) ? rawCookie[0]! : rawCookie!;
    const cookie = setCookieText.split(';')[0]!;

    const onboarding = await app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
      headers: { cookie },
    });
    expect(onboarding.statusCode).toBe(200);
    expect(onboarding.body).toContain('Pick your topics');
    expect(onboarding.body).toContain('iris@example.com');
  });
});

describe('HTTP: /auth/magic-link/verify → post-signin redirect', () => {
  let app: FastifyInstance;
  let transport: ConsoleEmailTransport;
  let driver: ReturnType<typeof createTestDb>['driver'];
  beforeEach(async () => {
    const ctx = await makeTestApp();
    app = ctx.app;
    transport = ctx.transport;
    driver = ctx.driver;
  });
  afterEach(async () => {
    await app.close();
  });

  async function signIn(): Promise<{ location: string; cookie: string }> {
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const snapshot = transport.snapshot();
    const token = extractToken(snapshot[snapshot.length - 1]!.text);
    const response = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    expect(response.statusCode).toBe(302);
    const raw = response.headers['set-cookie'];
    const setCookieText = Array.isArray(raw) ? raw.join(';') : (raw ?? '');
    return {
      location: String(response.headers.location),
      cookie: setCookieText.split(';')[0]!,
    };
  }

  function setOnboardingState(state: string): void {
    driver.prepare(`UPDATE users SET onboarding_state = ?`).run(state);
  }

  it('sends a brand-new user to topic selection', async () => {
    const { location, cookie } = await signIn();
    expect(location).toBe('/onboarding/pick-topics');
    expect(cookie).toMatch(/^brieflyy_session=/);
  });

  it('sends a user who has picked topics to the delivery-time step', async () => {
    await signIn();
    setOnboardingState('topics_picked');

    const { location } = await signIn();
    expect(location).toBe('/onboarding/delivery-time');
  });

  it('sends a fully set-up user straight to their topics', async () => {
    await signIn();
    setOnboardingState('delivery_set');

    const { location } = await signIn();
    expect(location).toBe('/topics');
  });

  it('sends a completed user to their topics', async () => {
    await signIn();
    setOnboardingState('completed');

    const { location } = await signIn();
    expect(location).toBe('/topics');
  });
});

describe('HTTP: /auth/logout', () => {
  let app: FastifyInstance;
  let transport: ConsoleEmailTransport;
  beforeEach(async () => {
    const ctx = await makeTestApp();
    app = ctx.app;
    transport = ctx.transport;
  });
  afterEach(async () => {
    await app.close();
  });

  it('ends the session: subsequent requests to gated pages redirect to /signup', async () => {
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const token = extractToken(transport.snapshot()[0]!.text);

    const verify = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    const rawVerifyCookie = verify.headers['set-cookie'];
    const setCookieText = Array.isArray(rawVerifyCookie) ? rawVerifyCookie[0]! : rawVerifyCookie!;
    const cookie = setCookieText.split(';')[0]!;

    const before = await app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
      headers: { cookie },
    });
    expect(before.statusCode).toBe(200);

    const logout = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { cookie },
    });
    expect(logout.statusCode).toBe(302);
    expect(logout.headers.location).toBe('/');

    const clearedCookie = logout.headers['set-cookie'] ?? '';
    expect(clearedCookie).toMatch(/brieflyy_session=;/);

    const after = await app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
      headers: { cookie },
    });
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toBe('/signup');
  });

  it('accepts an empty form-urlencoded body like a real browser submits', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
  });

  it('redirects to / even when there is no session', async () => {
    const response = await app.inject({ method: 'POST', url: '/auth/logout' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/');
  });
});

describe('HTTP: pages', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    const ctx = await makeTestApp();
    app = ctx.app;
  });
  afterEach(async () => {
    await app.close();
  });

  it('renders the signup form on GET /signup', async () => {
    const response = await app.inject({ method: 'GET', url: '/signup' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Sign in to Brieflyy');
    expect(response.body).toContain('id="email"');
  });

  it('redirects /onboarding/pick-topics to /signup when not authenticated', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
    });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/signup');
  });

  it('redirects / to /signup', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(302);
    expect(response.headers.location).toBe('/signup');
  });
});