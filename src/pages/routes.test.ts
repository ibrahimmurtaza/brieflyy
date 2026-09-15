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
