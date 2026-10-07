import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { createDatabase, type Db } from '../db/client.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { createTestDb } from '../testing/test-db.js';
import { makeTopic } from '../testing/fixtures.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type { Clock } from '../domain/clock.js';
import type { TopicId } from '../domain/types.js';
import type { RawFeedEntry } from './feed-fetcher.js';
import { BreakableFeedFetcher } from './test-constants.js';

const BODY_A =
  'Acme Corp today unveiled a new AI product called Foo, analysts said. The launch changes the landscape for enterprise customers worldwide.';

const ENTRIES: readonly RawFeedEntry[] = [
  {
    externalId: 'r-1',
    url: 'https://www.theguardian.com/world/r-1',
    title: 'Acme Corp launches new AI product',
    body: BODY_A,
    publishedAt: new Date('2026-09-02T10:00:00Z'),
  },
];

interface TestApp {
  readonly app: FastifyInstance;
  readonly transport: ConsoleEmailTransport;
  readonly db: Db;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
  readonly clock: Clock;
  signIn(email?: string): Promise<string>;
  /** The id of the single signed-in user, or null before sign-up. */
  userId(): string | null;
  articleCount(): number;
  /** Make one registry Source's feed fail, so a cycle leaves it backing off. */
  breakFeed(feedUrl: string, error: string): void;
}

async function buildApp(): Promise<TestApp> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(new Date('2026-09-02T12:00:00Z')).clock;
  const fetcher = new BreakableFeedFetcher({ entries: ENTRIES });
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock,
    random: deterministicRandom,
    feedFetcher: fetcher,
  });

  async function signIn(email = 'iris@example.com'): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email },
    });
    const sent = transport.snapshot();
    const token = extractMagicLinkToken(sent[sent.length - 1]!.text);
    const verified = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    const raw = verified.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0]! : raw!;
    // The pair, because the tick is a write like any other: a caller that has not
    // been handed a page cannot submit it (ADR-0022).
    const { cookies } = await signedInCookies(app, header.split(';')[0]!);
    return cookies;
  }

  function userId(): string | null {
    const row = driver.prepare(`SELECT id FROM users LIMIT 1`).get() as
      | { id: string }
      | undefined;
    return row?.id ?? null;
  }

  function articleCount(): number {
    return (driver.prepare(`SELECT COUNT(*) AS n FROM articles`).get() as { n: number }).n;
  }

  return {
    app,
    transport,
    db,
    driver,
    clock,
    signIn,
    userId,
    articleCount,
    breakFeed: (feedUrl, error) => fetcher.breakFeed(feedUrl, error),
  };
}

/** The registry feed URL for the Guardian, which is what `attachTopicWithSource` polls. */
const GUARDIAN_FEED_URL = 'https://www.theguardian.com/world/rss';

/** Give the signed-in user a topic fed by a registry Source, so a tick has work to do. */
async function attachTopicWithSource(ctx: TestApp): Promise<void> {
  const userId = ctx.userId();
  if (!userId) throw new Error('sign in before attaching a topic');
  const topicRepo = new DrizzleTopicRepo(createDatabase({ driver: ctx.driver }));
  await topicRepo.insert(makeTopic({ id: 't', userId }));
  await topicRepo.insertTopicSource('t' as TopicId, 'the-guardian', 0);
}

/**
 * Sign in, put the Guardian on a Topic and break its feed, so the next cycle
 * leaves a Source serving a backoff behind it.
 */
async function breakTheGuardian(ctx: TestApp): Promise<string> {
  const cookie = await ctx.signIn();
  await attachTopicWithSource(ctx);
  ctx.breakFeed(GUARDIAN_FEED_URL, 'upstream 503');
  return cookie;
}

describe('ingest admin routes', () => {
  let ctx: TestApp;
  beforeEach(async () => {
    ctx = await buildApp();
  });
  afterEach(async () => {
    await ctx.app.close();
  });

  it('registers the ingest routes', () => {
    const urls = ctx.app.routeManifest.map((r) => `${r.method} ${r.url}`);
    expect(urls).toEqual(
      expect.arrayContaining([
        'GET /api/ingest/status',
        'GET /admin/ingest',
        'POST /api/ingest/tick',
      ]),
    );
  });

  it('rejects an anonymous GET /api/ingest/status with 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/ingest/status' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects an anonymous GET /admin/ingest with 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/ingest' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('Ingest scheduler');
  });

  it('rejects an anonymous POST /api/ingest/tick with 401 and runs no cycle', async () => {
    const res = await ctx.app.inject({ method: 'POST', url: '/api/ingest/tick' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
    expect(ctx.articleCount()).toBe(0);
  });

  it('serves the status to a signed-in user', async () => {
    const cookie = await ctx.signIn();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/ingest/status',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      running: boolean;
      sources: { sourceId: string; lastPolledAt: string | null }[];
    };
    expect(body.running).toBe(false);
    expect(body.sources.map((s) => s.sourceId)).toContain('the-guardian');
    expect(body.sources.every((s) => s.lastPolledAt === null)).toBe(true);
  });

  it('runs a cycle for a signed-in user and reports the report', async () => {
    const cookie = await ctx.signIn();
    await attachTopicWithSource(ctx);

    const res = await submitForm(ctx.app, cookie, '/api/ingest/tick');
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      cycleId: string;
      totals: { inserted: number; merged: number };
      sources: { sourceId: string; success: boolean }[];
    };
    expect(body.cycleId).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.totals.inserted + body.totals.merged).toBe(1);
    expect(body.sources[0]?.sourceId).toBe('the-guardian');
    expect(body.sources[0]?.success).toBe(true);
  });

  it('renders the admin dashboard to a signed-in user', async () => {
    const cookie = await ctx.signIn();
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/ingest',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Ingest scheduler');
  });

  it('says the status is the reason a Source is not being polled', async () => {
    const cookie = await breakTheGuardian(ctx);
    await submitForm(ctx.app, cookie, '/api/ingest/tick');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/ingest/status',
      headers: { cookie },
    });
    const body = res.json() as {
      sources: {
        sourceId: string;
        servingBackoff: boolean;
        nextAttemptAt: string | null;
        consecutiveFailures: number;
        lastError: string | null;
      }[];
    };
    const guardian = body.sources.find((s) => s.sourceId === 'the-guardian');
    // An operator looking at a Source whose last poll is a while back has to be
    // able to tell a feed being held off from a scheduler that has stopped, and
    // the reason has to be in the answer rather than something to infer.
    expect(guardian?.servingBackoff).toBe(true);
    expect(guardian?.consecutiveFailures).toBe(1);
    expect(guardian?.lastError).toBe('upstream 503');
    expect(guardian?.nextAttemptAt).not.toBeNull();

    // A Source that has never run says so, rather than carrying a date it has
    // not earned and reading as one that is late.
    const quanta = body.sources.find((s) => s.sourceId === 'quanta-magazine');
    expect(quanta?.servingBackoff).toBe(false);
    expect(quanta?.nextAttemptAt).toBeNull();
  });

  it('names the backoff on the dashboard, so the reading is on the page', async () => {
    const cookie = await breakTheGuardian(ctx);
    await submitForm(ctx.app, cookie, '/api/ingest/tick');

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/ingest',
      headers: { cookie },
    });
    expect(res.body).toContain('Backoff');
    expect(res.body).toContain('backing off');
    expect(res.body).toContain('upstream 503');
  });
});
