import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { Article, EntityId, SourceId, StoryId, Tier } from '../domain/types.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import { makeArticle, makeCluster, makeTopic } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { createTestDb } from '../testing/test-db.js';

/** Noon on an ordinary day, so no window boundary lands on midnight. */
const NOW = new Date('2024-06-15T12:00:00Z');
const SOURCE = 'the-guardian' as SourceId;
const ENTITY = 'Acme Corp';

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly articleRepo: DrizzleArticleRepo;
  readonly clusterRepo: DrizzleClusterRepo;
  readonly entityRepo: DrizzleEntityRepo;
  readonly storyRepo: DrizzleStoryRepo;
  readonly topicRepo: DrizzleTopicRepo;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
}

/**
 * A signed-in User with one Topic, one Source, and articles that name an Entity.
 *
 * The Articles are dated so the numbers are recognisable: a steady trickle through
 * the baseline and a spike on the 14th, which is also the day the Cluster arrived.
 */
async function harness(): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(NOW).clock,
    random: deterministicRandom,
    devToolsEnabled: true,
  });
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
  const raw = verify.headers['set-cookie'];
  const sessionCookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  // The session and the request token: a browser is handed a page before it
  // can submit a form, and every write checks the pair (ADR-0021).
  const { cookies: cookie } = await signedInCookies(app, sessionCookie);

  const topicRepo = new DrizzleTopicRepo(db);
  const articleRepo = new DrizzleArticleRepo(db);
  const entityRepo = new DrizzleEntityRepo(db);
  const storyRepo = new DrizzleStoryRepo(db);
  const clusterRepo = new DrizzleClusterRepo(db);

  const userId = (driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
  await topicRepo.insert(
    makeTopic({ id: 'world-news', userId, title: 'World news', sourceIds: [SOURCE] }),
  );
  await topicRepo.insertTopicSource('world-news', SOURCE, 0);

  const entityId = `entity-${ENTITY.toLowerCase()}` as EntityId;
  await entityRepo.upsertByKey({
    id: entityId,
    entity: { name: ENTITY, key: ENTITY.toLowerCase(), kind: 'org' },
  });

  // Three Articles in the baseline naming the Entity, and eight on the 14th.
  const dated: readonly (readonly [string, string])[] = [
    ['base-1', '2024-06-01T09:00:00Z'],
    ['base-2', '2024-06-02T09:00:00Z'],
    ['base-3', '2024-06-03T09:00:00Z'],
    ...Array.from({ length: 8 }, (_, i) => [
      `spike-${i}`,
      `2024-06-14T${String(9 + (i % 8)).padStart(2, '0')}:00:00Z`,
    ] as const),
  ];
  for (const [id, when] of dated) {
    await insertArticle({
      id,
      publishedAt: new Date(when),
      entityId,
      articleRepo,
      storyRepo,
    });
  }
  // Quiet days inside the observation window, so the mean the spike is measured
  // against is not itself a spike.
  for (const [id, when] of [
    ['quiet-1', '2024-06-10T09:00:00Z'],
    ['quiet-2', '2024-06-11T09:00:00Z'],
  ] as const) {
    await insertArticle({
      id,
      publishedAt: new Date(when),
      entityId: null,
      articleRepo,
      storyRepo,
    });
  }

  await clusterRepo.insert(
    makeCluster({
      id: 'cluster-1',
      topicId: 'world-news',
      title: 'Acme unveils Foo',
      summary: 'Acme Corp unveiled a product called Foo, and the market has noticed.',
      createdAt: new Date('2024-06-14T10:00:00Z'),
      lastSeenAt: new Date('2024-06-14T18:00:00Z'),
      articleCount: 8,
    }),
    ['story-spike-0' as StoryId],
  );

  return { app, cookie, articleRepo, clusterRepo, entityRepo, storyRepo, topicRepo, driver };
}

async function insertArticle(input: {
  readonly id: string;
  readonly publishedAt: Date;
  readonly entityId: EntityId | null;
  readonly articleRepo: DrizzleArticleRepo;
  readonly storyRepo: DrizzleStoryRepo;
}): Promise<void> {
  const article: Article = {
    ...makeArticle({ id: input.id }),
    sourceId: SOURCE,
    publishedAt: input.publishedAt,
    ingestedAt: input.publishedAt,
    storyId: `story-${input.id}` as StoryId,
  };
  await input.storyRepo.insert({
    id: article.storyId as StoryId,
    signature: article.signature,
    firstSeenAt: input.publishedAt,
    lastSeenAt: input.publishedAt,
    published: { first: input.publishedAt, last: input.publishedAt },
  });
  await input.articleRepo.insert({
    article,
    entityIds: input.entityId === null ? [] : [input.entityId],
  });
}

/** Put the signed-in User on a tier, through the application's own switch. */
async function switchTier(h: Harness, tier: Tier): Promise<void> {
  await submitForm(h.app, h.cookie, '/dev/tier', { tier });
}

describe('GET /topics/:slug/trends', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  it('renders the chart, the entity list and the annotations', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('class="trend-chart"');
    expect(res.body).toContain('class="sparkline"');
    expect(res.body).toContain(ENTITY);
  });

  it('links each spike annotation to the Cluster that caused it', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    expect(res.body).toContain('href="/topics/world-news#cluster-cluster-1"');
    expect(res.body).toContain('Acme Corp unveiled a product called Foo');
  });

  it('links to a Cluster id the LivingBrief actually renders', async () => {
    // The annotation is only a link if the thing it points at exists. Asserted
    // here rather than trusted, because the two are rendered by different files.
    const res = await h.app.inject({
      method: 'GET',
      url: '/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    const fragment = /href="\/topics\/world-news#([^"]+)"/.exec(res.body)?.[1];
    expect(fragment).toBeTruthy();
    const brief = await h.app.inject({
      method: 'GET',
      url: '/topics/world-news',
      headers: { cookie: h.cookie },
    });
    expect(brief.body).toContain(`id="${fragment}"`);
  });

  it('is reachable from the LivingBrief', async () => {
    const brief = await h.app.inject({
      method: 'GET',
      url: '/topics/world-news',
      headers: { cookie: h.cookie },
    });
    expect(brief.body).toContain('href="/topics/world-news/trends"');
  });

  it('is reachable from the app shell', async () => {
    for (const url of ['/topics', '/discover', '/settings/briefs']) {
      const res = await h.app.inject({
        method: 'GET',
        url,
        headers: { cookie: h.cookie },
      });
      expect(res.body, `${url} cannot reach /trends`).toContain('href="/trends"');
    }
  });

  it('shows the aggregate rollup on the home dashboard', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: h.cookie },
    });
    expect(res.body).toContain('Across your topics');
    expect(res.body).toContain(ENTITY);
  });

  it('answers a Topic that is not this User\'s with a 404 that still has the shell', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/topics/nothing-here/trends',
      headers: { cookie: h.cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('Back to your topics');
  });

  it('sends an anonymous visitor to sign in', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/topics/world-news/trends' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/signup');
  });
});

/**
 * The across-your-topics page, at the HTTP seam.
 *
 * Everything this page renders was covered by calling the page function with a
 * hand-built rollup, which cannot say whether the route reaches it. That is the
 * whole of the gap the browser suite had to fill for it: this route had an
 * injected test for the per-Topic trends page above and none for this one, so a
 * render failure here would have failed nothing at all.
 */
describe('GET /trends', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('renders the rollup and a way into the Topic it came from', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/trends',
      headers: { cookie: h.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Trends');
    // The chart, named for a reader who cannot see it, with the numbers beside it.
    expect(res.body).toContain('<svg class="trend-chart"');
    expect(res.body).toContain('role="img"');
    expect(res.body).toContain(ENTITY);
    // And the way down into the per-Topic page, which is the only thing on this
    // page a User can act on.
    expect(res.body).toContain('href="/topics/world-news/trends"');
  });

  it('marks itself as the current page in the shell', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/trends',
      headers: { cookie: h.cookie },
    });
    expect(res.body).toMatch(/<a href="\/trends" aria-current="page">Trends<\/a>/);
  });

  it('sends an anonymous visitor to sign in', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/trends' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/signup');
  });
});

describe('the tier, enforced by the server', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  it('leaves the whole history out of the response a free User receives', async () => {
    await switchTier(h, 'free');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    expect(res.statusCode).toBe(200);
    const body = JSON.parse(res.body) as {
      window: { baselineStart: string };
      volumeOverTime: readonly { date: string }[];
    };
    // The window still says what was measured; the series is what is protected.
    expect(body.window.baselineStart).toBe('2024-05-09T12:00:00.000Z');
    expect(body.volumeOverTime.map((p) => p.date)).toEqual([
      '2024-06-13',
      '2024-06-14',
      '2024-06-15',
    ]);
    expect(res.body).not.toContain('2024-06-01');
  });

  it('gives a paid User the whole history in the same response', async () => {
    await switchTier(h, 'paid');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    const body = JSON.parse(res.body) as {
      volumeOverTime: readonly { date: string }[];
    };
    expect(body.volumeOverTime).toHaveLength(38);
    expect(body.volumeOverTime.map((p) => p.date)).toContain('2024-06-01');
  });

  it('answers an anonymous visitor to the JSON route with a 401, not a sign-in page', async () => {
    // The JSON surface answers a machine. Redirecting it to /signup would hand a
    // caller an HTML sign-in form and a 200-family status code for a request it
    // could never have been allowed.
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['content-type']).toContain('application/json');
  });

  it('keeps a free User\'s entity list inside the three days it may see', async () => {
    await switchTier(h, 'free');
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    const body = JSON.parse(res.body) as {
      entities: readonly {
        canonicalName: string;
        lift: number | null;
        baselineMentions: number | null;
        daily: readonly { date: string }[];
      }[];
    };
    const acme = body.entities.find((e) => e.canonicalName === ENTITY);
    expect(acme?.daily.map((d) => d.date)).toEqual([
      '2024-06-13',
      '2024-06-14',
      '2024-06-15',
    ]);
    // And the figures that came out of a thirty-day baseline are not in the
    // response at all, rather than being there for anyone to read.
    expect(acme?.lift).toBeNull();
    expect(acme?.baselineMentions).toBeNull();
  });

  it('does not put the free User\'s history in the page markup either', async () => {
    await switchTier(h, 'free');
    const res = await h.app.inject({
      method: 'GET',
      url: '/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    // 2024-06-01 is a baseline day. It is in neither the series nor the table, and
    // the annotation for it is not printed either.
    expect(res.body).not.toContain('2024-06-01');
    expect(res.body).toContain('2024-06-14');
  });

  it('reads the tier off the User, not off anything the request carries', async () => {
    await switchTier(h, 'free');
    const free = await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    // Nothing a caller can put in the request asks for more history.
    await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends?historyDays=38&tier=paid',
      headers: { cookie: h.cookie },
    });
    const again = await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    expect(again.body).toBe(free.body);
  });
});

describe('the trends view and the cadence behind it', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await harness();
  });

  it('serves the stored trend rather than measuring again on every request', async () => {
    const rowCount = () =>
      (h.driver.prepare(`SELECT COUNT(*) AS n FROM topic_trends`).get() as { n: number }).n;

    await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    const afterFirst = rowCount();
    await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    expect(afterFirst).toBe(1);
    expect(rowCount()).toBe(1);
  });

  it('writes the trend once, for the hourly job to replace', async () => {
    await h.app.inject({
      method: 'GET',
      url: '/api/topics/world-news/trends',
      headers: { cookie: h.cookie },
    });
    const row = h.driver.prepare(`SELECT computed_at FROM topic_trends`).get() as {
      computed_at: number;
    };
    expect(row.computed_at).toBe(NOW.getTime());
  });
});