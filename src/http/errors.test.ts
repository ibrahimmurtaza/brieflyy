import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { PUBLIC_ROUTE_CONFIG } from './access.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';

/**
 * What an unexpected failure answers.
 *
 * Driven through the application as `createApp` builds it. The faults are
 * registered on the instance that factory returned rather than produced by a
 * dependency told to fail, because the thing under test is the handler that
 * instance carries: a throwing route is the smallest way to reach it without a
 * schema constraint or a fake driver arranged to break.
 */
interface TestHandle {
  readonly app: FastifyInstance;
  readonly transport: ConsoleEmailTransport;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
}

const SECRET = 'sqlite: no such column: accounts.emial';

async function makeTestApp(): Promise<TestHandle> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(new Date('2026-01-01T00:00:00Z')).clock,
    random: deterministicRandom,
  });

  app.get('/boom', PUBLIC_ROUTE_CONFIG, async () => {
    throw new Error(SECRET);
  });
  app.get('/api/boom', PUBLIC_ROUTE_CONFIG, async () => {
    throw new Error(SECRET);
  });
  // A refusal a handler raised itself, because the codes the `/api/` routes answer
  // with (`unauthorized`, `rate_limited`, `not_found`) are worth as codes rather
  // than as one word for every 4xx.
  app.get('/api/rate-limited', PUBLIC_ROUTE_CONFIG, async () => {
    throw Object.assign(new Error('quota exhausted'), { statusCode: 429 });
  });

  return { app, transport, driver };
}

/** The session cookie header for a User who has signed in by magic link. */
async function signedInCookie(handle: TestHandle): Promise<string> {
  const requested = await handle.app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  if (requested.statusCode !== 202) {
    throw new Error(`sign-up refused: ${requested.statusCode} ${requested.body}`);
  }
  const token = extractMagicLinkToken(
    handle.transport.snapshot().slice(-1)[0]!.text,
  );
  const verified = await handle.app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  if (verified.statusCode !== 302) {
    throw new Error(`link refused: ${verified.statusCode} ${verified.body}`);
  }
  const setCookie = verified.headers['set-cookie'];
  const list = Array.isArray(setCookie) ? setCookie : [String(setCookie)];
  const session = list.map((line) => line.split(';')[0]!).find((line) =>
    line.startsWith('brieflyy_session='),
  );
  if (!session) throw new Error('no session cookie');
  return session;
}

describe('an unexpected failure', () => {
  let handle: TestHandle;
  beforeEach(async () => {
    handle = await makeTestApp();
  });
  afterEach(async () => {
    await handle.app.close();
    handle.driver.close();
  });

  it('answers a page address with a page a User can read', async () => {
    const response = await handle.app.inject({ method: 'GET', url: '/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toContain('<h1>Something went wrong</h1>');
    expect(response.body).toContain('href="/signup"');
  });

  it('answers a JSON address with JSON', async () => {
    const response = await handle.app.inject({ method: 'GET', url: '/api/boom' });
    expect(response.statusCode).toBe(500);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toEqual({ error: 'internal_error' });
  });

  it('does not put the failure itself in front of the caller', async () => {
    for (const url of ['/boom', '/api/boom']) {
      const response = await handle.app.inject({ method: 'GET', url });
      expect(response.body).not.toContain(SECRET);
      expect(response.body).not.toContain('at Object.');
    }
  });

  it('leaves a client error the client made a client error', async () => {
    // A body Fastify could not parse is the caller's mistake, and answering 500
    // would say the application broke over it.
    const response = await handle.app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      headers: { 'content-type': 'application/json' },
      payload: '{"email":',
    });
    expect(response.statusCode).toBe(400);
    // A page telling the caller Brieflyy had failed would be untrue of a request
    // Brieflyy refused.
    expect(response.body).toContain('<h1>That request could not be completed</h1>');
    expect(response.body).not.toContain('Something went wrong');
  });

  it('names the client error a machine gets', async () => {
    const response = await handle.app.inject({ method: 'GET', url: '/api/rate-limited' });
    expect(response.statusCode).toBe(429);
    expect(response.json()).toEqual({ error: 'rate_limited' });
  });

  it('leaves a signed-in User the way out of the application', async () => {
    const cookie = await signedInCookie(handle);
    const response = await handle.app.inject({
      method: 'GET',
      url: '/boom',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(500);
    // The shell's navigation, which is how a signed-in User leaves any page they
    // are on, and the way back into the application rather than the sign-in page.
    expect(response.body).toContain('href="/topics"');
    expect(response.body).toContain('action="/auth/logout"');
    expect(response.body).toContain('iris@example.com');
  });
});