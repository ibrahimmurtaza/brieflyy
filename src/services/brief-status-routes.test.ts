import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import type { Db } from '../db/client.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { DrizzleBriefJobRunRepo } from '../repos/brief-job-run-repo.js';
import { DrizzleBriefPlanRepo } from '../repos/brief-plan-repo.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleEmailDeliveryRepo } from '../repos/email-delivery-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import {
  makeBriefPlan,
  makeBriefSnapshot,
  makeEmailDelivery,
  makeTopic,
  makeUser,
} from '../testing/fixtures.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type { Clock } from '../domain/clock.js';
import type { TopicId } from '../domain/types.js';

interface TestApp {
  readonly app: FastifyInstance;
  readonly transport: ConsoleEmailTransport;
  readonly db: Db;
  readonly clock: Clock;
  readonly jobRuns: DrizzleBriefJobRunRepo;
  signIn(): Promise<string>;
  /** A User who signed up at `signedUpAt`, with no brief of any kind. */
  signUp(id: string, signedUpAt: Date): Promise<void>;
  /** One brief the transport took, `sentAt` after that User signed up. */
  sendBrief(userId: string, sentAt: Date): Promise<void>;
}

const NOW = new Date('2026-09-02T12:00:00Z');

async function buildApp(): Promise<TestApp> {
  resetDeterministic();
  const { db } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(NOW).clock;
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock,
    random: deterministicRandom,
  });

  async function signIn(): Promise<string> {
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'iris@example.com' },
    });
    const sent = transport.snapshot();
    const token = extractMagicLinkToken(sent[sent.length - 1]!.text);
    const verified = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    const raw = verified.headers['set-cookie'];
    const header = Array.isArray(raw) ? raw[0]! : raw!;
    return header.split(';')[0]!;
  }

  async function signUp(id: string, signedUpAt: Date): Promise<void> {
    await new DrizzleUserRepo(db).insert(makeUser({ id, createdAt: signedUpAt }));
  }

  async function sendBrief(userId: string, sentAt: Date): Promise<void> {
    const topicId = `topic-${userId}` as TopicId;
    await new DrizzleTopicRepo(db).insert(makeTopic({ id: topicId, userId }));
    await new DrizzleBriefPlanRepo(db).insert(
      makeBriefPlan({ id: `plan-${userId}`, topicId, userId, createdAt: sentAt }),
    );
    await new DrizzleBriefSnapshotRepo(db).insert(
      makeBriefSnapshot({
        id: `snapshot-${userId}`,
        briefPlanId: `plan-${userId}`,
        userId,
        topicId,
        createdAt: sentAt,
      }),
    );
    await new DrizzleEmailDeliveryRepo(db).insert(
      makeEmailDelivery({
        id: `delivery-${userId}`,
        userId,
        topicId,
        briefSnapshotId: `snapshot-${userId}`,
        sentAt,
      }),
    );
  }

  return {
    app,
    transport,
    db,
    clock,
    jobRuns: new DrizzleBriefJobRunRepo(db),
    signIn,
    signUp,
    sendBrief,
  };
}

describe('brief status routes', () => {
  let ctx: TestApp;

  beforeEach(async () => {
    ctx = await buildApp();
  });

  afterEach(async () => {
    await ctx.app.close();
  });

  it('registers the brief status routes', () => {
    const urls = ctx.app.routeManifest.map((r) => `${r.method} ${r.url}`);
    expect(urls).toEqual(
      expect.arrayContaining(['GET /api/briefs/status', 'GET /admin/briefs']),
    );
  });

  it('rejects an anonymous GET /api/briefs/status with 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/api/briefs/status' });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects an anonymous GET /admin/briefs with 401', async () => {
    const res = await ctx.app.inject({ method: 'GET', url: '/admin/briefs' });
    expect(res.statusCode).toBe(401);
    expect(res.body).not.toContain('Daily brief job');
  });

  it('reports a job that has not run yet as not running', async () => {
    const cookie = await ctx.signIn();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/briefs/status',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    // A pass that ran and found nobody due is not the same fact as a pass that
    // never ran, so the first one it can report is "no pass yet".
    expect(res.json()).toMatchObject({
      running: false,
      lastRunAt: null,
      sentCount: 0,
      failureCount: 0,
      recentRuns: [],
    });
  });

  it('serves the recorded pass to a signed-in user', async () => {
    const cookie = await ctx.signIn();
    await ctx.jobRuns.insert({
      id: 'run-1',
      startedAt: new Date('2026-09-02T12:00:00Z'),
      finishedAt: new Date('2026-09-02T12:00:04Z'),
      sentCount: 7,
      failureCount: 1,
      generation: { writtenClusters: 21, calls: 24, discardedBullets: 2 },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/briefs/status',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      lastRunAt: '2026-09-02T12:00:00.000Z',
      sentCount: 7,
      failureCount: 1,
      // Survives the round trip through the row, which is the only place a pass
      // is kept: a count that only lived in memory would be zero by the time
      // anybody looked at it.
      generation: { writtenClusters: 21, calls: 24, discardedBullets: 2 },
    });
    expect((res.json() as { recentRuns: unknown[] }).recentRuns).toHaveLength(1);
  });

  it('reports the written path as not having run, rather than not reporting it', async () => {
    // A pass from a deployment with no credential configured, and one from a
    // feature that has stopped working, both have to be readable. Zero of each is
    // the first; the second is calls without written Clusters, which is why the
    // two are counted separately.
    const cookie = await ctx.signIn();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/briefs/status',
      headers: { cookie },
    });

    expect(res.json()).toMatchObject({
      generation: { writtenClusters: 0, calls: 0, discardedBullets: 0 },
    });
  });

  it('names the transport the briefs go out by', async () => {
    const cookie = await ctx.signIn();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/briefs/status',
      headers: { cookie },
    });

    expect((res.json() as { provider: string }).provider).toBe('console');
  });

  it('separates the newest pass in the facts from every pass in the table', async () => {
    // Two passes, with different numbers, because a dashboard whose facts and
    // rows were reading the same pass by accident would look exactly right with
    // one row and be wrong with twenty. The facts answer "how did the last pass
    // go"; the table answers "what has been happening".
    const cookie = await ctx.signIn();
    await ctx.jobRuns.insert({
      id: 'run-older',
      startedAt: new Date('2026-09-02T11:00:00Z'),
      finishedAt: new Date('2026-09-02T11:00:02Z'),
      sentCount: 2,
      failureCount: 0,
      generation: { writtenClusters: 2, calls: 2, discardedBullets: 0 },
    });
    await ctx.jobRuns.insert({
      id: 'run-newer',
      startedAt: new Date('2026-09-02T12:00:00Z'),
      finishedAt: new Date('2026-09-02T12:00:04Z'),
      sentCount: 7,
      failureCount: 1,
      generation: { writtenClusters: 5, calls: 7, discardedBullets: 3 },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/briefs',
      headers: { cookie },
    });

    // The facts are the newest pass, and the newest pass is the one that wrote
    // five of seven Clusters and threw three bullets away.
    const facts = res.body.slice(0, res.body.indexOf('<h2>'));
    expect(facts).toContain('2026-09-02T12:00:00.000Z');
    expect(facts).toContain('<dd>7</dd>');
    expect(facts).toContain('<dd>5</dd>');
    expect(facts).toContain('<dd>3</dd>');
    // The table is every pass, so the older one's numbers are in the document
    // even though they are not in the facts.
    expect(res.body).toContain('2026-09-02T11:00:00.000Z');
    expect(res.body).toContain('<td>2</td>');
  });

  it('renders the dashboard to a signed-in user', async () => {
    const cookie = await ctx.signIn();
    await ctx.jobRuns.insert({
      id: 'run-1',
      startedAt: new Date('2026-09-02T12:00:00Z'),
      finishedAt: new Date('2026-09-02T12:00:04Z'),
      sentCount: 7,
      failureCount: 1,
      generation: { writtenClusters: 21, calls: 24, discardedBullets: 2 },
    });

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/briefs',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/html/);
    expect(res.body).toContain('Daily brief job');
    expect(res.body).toContain('2026-09-02T12:00:00.000Z');
    expect(res.body).toContain('<td>7</td>');
    expect(res.body).toContain('<td>1</td>');
    // What writing the pass cost, as facts and in the table. The point of the
    // page is that an operator can see the written path working; a sent count
    // says nothing about it either way.
    expect(res.body).toContain('Clusters written');
    expect(res.body).toContain('Write calls');
    expect(res.body).toContain('Bullets discarded');
    expect(res.body).toContain('<td>21</td>');
    expect(res.body).toContain('<td>24</td>');
    expect(res.body).toContain('<td>2</td>');
  });

  it('renders a job that has never run without inventing a pass', async () => {
    const cookie = await ctx.signIn();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/briefs',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<em>never</em>');
  });

  it('counts the Users a first brief arrived for, and how many there are to count', async () => {
    // Two Users, one of them served inside a day of signing up and one of them
    // served three days in. The second is why the count is reported beside the
    // number of Users rather than on its own: 1 of what is the reading, and 1 on
    // its own is a number nobody can act on.
    const cookie = await ctx.signIn();
    const signedUpAt = new Date('2026-08-30T09:00:00Z');
    await ctx.signUp('user-early', signedUpAt);
    await ctx.signUp('user-late', signedUpAt);
    await ctx.sendBrief('user-early', new Date('2026-08-30T18:00:00Z'));
    await ctx.sendBrief('user-late', new Date('2026-09-02T09:00:00Z'));

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/briefs/status',
      headers: { cookie },
    });

    // Three Users: the one who just signed in through the magic link, and the two
    // above.
    expect((res.json() as { activation: unknown }).activation).toEqual({
      activated: 1,
      signedUp: 3,
      windowHours: 24,
    });
  });

  it('says the window it measured the activation count over', async () => {
    // A count of Users is only a fact about a window, and a number with the
    // window left out of it is one an operator has to guess at.
    const cookie = await ctx.signIn();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/briefs/status',
      headers: { cookie },
    });

    const activation = (res.json() as { activation: { windowHours: number } }).activation;
    expect(activation.windowHours).toBe(24);
  });

  it('reports no activated User for an installation that has served none', async () => {
    // Zero of each rather than nothing at all: an installation where every User
    // signed up and none has been served is a different thing from an
    // installation with no Users.
    const cookie = await ctx.signIn();

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/api/briefs/status',
      headers: { cookie },
    });

    expect((res.json() as { activation: unknown }).activation).toMatchObject({
      activated: 0,
      signedUp: 1,
    });
  });

  it('renders the activation count on the dashboard, and reads nothing else as it', async () => {
    // The page's other numbers are one pass's, and a User's first brief is not a
    // pass — so the label has to say which it is, or the same "1" on this page
    // reads as both.
    const cookie = await ctx.signIn();
    await ctx.jobRuns.insert({
      id: 'run-1',
      startedAt: new Date('2026-09-02T12:00:00Z'),
      finishedAt: new Date('2026-09-02T12:00:04Z'),
      sentCount: 7,
      failureCount: 1,
      generation: { writtenClusters: 21, calls: 24, discardedBullets: 2 },
    });
    const signedUpAt = new Date('2026-08-30T09:00:00Z');
    await ctx.signUp('user-early', signedUpAt);
    await ctx.sendBrief('user-early', new Date('2026-08-30T18:00:00Z'));

    const res = await ctx.app.inject({
      method: 'GET',
      url: '/admin/briefs',
      headers: { cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Users whose first brief arrived within 24 hours of signing up');
    expect(res.body).toContain('Users signed up');
    // Two Users: the one signed in through the magic link and the one above. The
    // pass's own numbers are untouched by any of it.
    expect(res.body).toMatch(/Users signed up<\/dt><dd>2<\/dd>/);
    expect(res.body).toMatch(
      /Users whose first brief arrived within 24 hours of signing up<\/dt><dd>1<\/dd>/,
    );
  });
});
