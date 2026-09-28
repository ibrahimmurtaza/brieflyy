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
    // Nothing to submit: a form here would be a button that goes nowhere.
    expect(resp.body).not.toMatch(/<form/);
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
