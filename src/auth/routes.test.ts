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

describe('HTTP: /auth/magic-link/request', () => {
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

  it('returns 202 and sends a magic link for a valid email', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json() as { email: string; sentTo: string };
    expect(body.email).toBe('iris@example.com');
    expect(body.sentTo).toBe('new');

    expect(transport.snapshot()).toHaveLength(1);
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

  function extractToken(text: string): string {
    const m = text.match(/\btoken=([^\s&]+)/);
    if (!m) throw new Error('token missing');
    return decodeURIComponent(m[1]!);
  }

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

  function extractToken(text: string): string {
    const m = text.match(/\btoken=([^\s&]+)/);
    if (!m) throw new Error('token missing');
    return decodeURIComponent(m[1]!);
  }

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

  function extractToken(text: string): string {
    const m = text.match(/\btoken=([^\s&]+)/);
    if (!m) throw new Error('token missing');
    return decodeURIComponent(m[1]!);
  }

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