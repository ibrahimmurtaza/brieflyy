import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { PUBLIC_ROUTES, type RegisteredRoute } from './access.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type { FeedFetcher, RawFeed } from '../ingest/feed-fetcher.js';

class EmptyFeedFetcher implements FeedFetcher {
  async fetch(_url: string): Promise<RawFeed> {
    return { entries: [] };
  }
}

let app: FastifyInstance;
let routes: readonly RegisteredRoute[];

beforeAll(async () => {
  resetDeterministic();
  const { db } = createTestDb();
  app = await createApp({
    db,
    emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(new Date('2026-01-01T00:00:00Z')).clock,
    random: deterministicRandom,
    feedFetcher: new EmptyFeedFetcher(),
  });
  routes = app.routeManifest;
});

afterAll(async () => {
  await app.close();
});

const label = (route: RegisteredRoute): string => `${route.method} ${route.url}`;

/** The routes the application declares, without Fastify's generated HEAD twins. */
const declared = (): readonly RegisteredRoute[] => routes.filter((r) => !r.autoHead);

/**
 * Ask a route for something without a session, substituting its path parameters.
 * Only the declared routes are probed: a generated HEAD twin is answered by the
 * GET beside it, which is probed in its own right.
 */
async function probeAnonymously(route: RegisteredRoute): Promise<{
  status: number;
  location: string | undefined;
}> {
  const url = route.url.replace(/:[A-Za-z0-9_]+/g, 'probe');
  const res =
    route.method === 'POST'
      ? await app.inject({
          method: 'POST',
          url,
          payload: '',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
        })
      : await app.inject({ method: 'GET', url });
  return { status: res.statusCode, location: res.headers.location as string | undefined };
}

describe('route access guard', () => {
  it('enumerates the routes the application registers', () => {
    expect(declared().length).toBeGreaterThan(15);
  });

  it('records the HEAD route Fastify generates for every GET as a shadow of it', () => {
    const shadows = routes.filter((r) => r.autoHead);
    expect(shadows.length).toBeGreaterThan(0);
    for (const shadow of shadows) {
      const shadowed = declared().find(
        (r) => r.url === shadow.url && r.method !== 'HEAD' && r.access === shadow.access,
      );
      expect(shadowed, `${label(shadow)} shadows nothing`).toBeDefined();
    }
  });

  it('registers the ingest admin routes in the manifest', () => {
    expect(declared().map(label)).toEqual(
      expect.arrayContaining([
        'GET /api/ingest/status',
        'GET /admin/ingest',
        'POST /api/ingest/tick',
      ]),
    );
  });

  it('declares an access level for every route', () => {
    expect(routes.filter((r) => r.access === null).map(label)).toEqual([]);
  });

  it('keeps the public surface to the declared allowlist', () => {
    const reachedWithoutASession = declared()
      .filter((r) => r.access === 'public')
      .map(label)
      .sort();
    expect(reachedWithoutASession).toEqual([...PUBLIC_ROUTES].sort());
  });

  it('registers every route the public allowlist names', () => {
    const labels = new Set(declared().map(label));
    expect([...PUBLIC_ROUTES].filter((entry) => !labels.has(entry)).sort()).toEqual([]);
  });

  it('declares the admin surface as authenticated, not public', () => {
    const admin = declared().filter(
      (r) => r.url.startsWith('/admin') || r.url.startsWith('/api/ingest'),
    );
    expect(admin.length).toBe(3);
    expect(admin.every((r) => r.access === 'authenticated')).toBe(true);
  });

  it('refuses an anonymous request to every route outside the public allowlist', async () => {
    const guarded = declared().filter((r) => r.access !== 'public');
    expect(guarded.length).toBeGreaterThan(0);

    const served: string[] = [];
    for (const route of guarded) {
      const { status, location } = await probeAnonymously(route);
      const refused =
        status === 401 || (status === 302 && location === '/signup');
      if (!refused) served.push(`${label(route)} answered ${status} ${location ?? ''}`.trim());
    }
    expect(served).toEqual([]);
  });
});
