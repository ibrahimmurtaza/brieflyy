import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { applyDirectorySeed } from '../directory/seed.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createDatabase, type Db } from '../db/client.js';
import { createTestDb } from '../testing/test-db.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { makeTopic, makeUser } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type { TopicId } from '../domain/types.js';
import type { FeedFetcher, RawFeed, RawFeedEntry } from '../ingest/feed-fetcher.js';
import { isSafeExternalUrl } from '../domain/url.js';

const POLL_AT = new Date('2026-09-02T12:00:00Z');

/**
 * A feed that is actively hostile: markup, a script tag, and a URL whose scheme
 * executes on click. Nothing here should reach a User as anything executable.
 */
const HOSTILE_FEED_XML = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
  <title>Hostile Wire</title>
  <item>
    <title>&lt;script&gt;alert('title')&lt;/script&gt; Acme Corp &amp; Co &lt;img src=x onerror=alert('title')&gt;</title>
    <link>javascript:alert('link')</link>
    <guid isPermaLink="false">hostile-1</guid>
    <pubDate>Wed, 02 Sep 2026 10:00:00 GMT</pubDate>
    <description>&lt;script&gt;alert('body')&lt;/script&gt;&lt;p onclick="alert(1)"&gt;Acme Corp shipped a thing today.&lt;/p&gt;&lt;iframe src="https://evil.example"&gt;&lt;/iframe&gt;</description>
  </item>
  <item>
    <title>Acme Corp shipped a second thing</title>
    <link>https://www.theguardian.com/world/acme-2"&gt;&lt;script&gt;alert('attr')&lt;/script&gt;</link>
    <guid isPermaLink="false">hostile-2</guid>
    <pubDate>Wed, 02 Sep 2026 11:00:00 GMT</pubDate>
    <description>Acme Corp shipped a second thing, with a body that is entirely harmless.</description>
  </item>
  <item>
    <title>BrandX acquires TinyCo</title>
    <link>data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==</link>
    <guid isPermaLink="false">hostile-3</guid>
    <pubDate>Wed, 02 Sep 2026 11:30:00 GMT</pubDate>
    <description>BrandX acquired TinyCo in a deal nobody expected.</description>
  </item>
</channel></rss>`;

const SAFE_ENTRY: RawFeedEntry = {
  externalId: 'safe-1',
  url: 'https://www.theguardian.com/world/safe-1',
  title: 'A perfectly ordinary headline',
  body: 'An entirely unremarkable paragraph about something that happened.',
  publishedAt: new Date('2026-09-02T09:00:00Z'),
};

class StaticFeedFetcher implements FeedFetcher {
  constructor(private readonly feed: RawFeed) {}
  async fetch(_url: string): Promise<RawFeed> {
    return this.feed;
  }
}

/**
 * What "nothing executable" actually means for a rendered document.
 *
 * Asserting that the string `onerror` is absent would be wrong: the payload is
 * expected to survive as escaped, visible text, because a feed is allowed to
 * say things. What must not survive is anything a browser would act on: a tag, an
 * event-handler attribute inside a tag, or a link to a scheme that runs.
 */
function assertNothingExecutable(html: string): void {
  expect(html, 'a script tag reached the output').not.toMatch(/<script/i);
  expect(html, 'an iframe reached the output').not.toMatch(/<iframe/i);
  expect(html, 'a live event handler reached the output').not.toMatch(
    /<[a-z][^>]*\son[a-z]+\s*=/i,
  );
  expect(html, 'a javascript: link reached the output').not.toMatch(
    /href=["']\s*javascript:/i,
  );
  expect(html, 'a data: link reached the output').not.toMatch(/href=["']\s*data:/i);
  expect(html, 'a vbscript: link reached the output').not.toMatch(
    /href=["']\s*vbscript:/i,
  );
  // And the payload is still there, escaped, rather than silently dropped.
  expect(html, 'the hostile payload was dropped rather than escaped').toContain(
    '&lt;script&gt;',
  );
}

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
  readonly topicSlug: string;
  /** The one transport the application was built with, magic links included. */
  readonly transport: ConsoleEmailTransport;
}

async function buildApp(): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(POLL_AT).clock,
    random: deterministicRandom,
    feedFetcher: new StaticFeedFetcher({ entries: [SAFE_ENTRY] }),
  });

  const sent0 = transport.snapshot();
  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  const all = transport.snapshot();
  const token = extractMagicLinkToken(all[sent0.length]!.text);
  const verified = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const raw = verified.headers['set-cookie'];
  const sessionCookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  // The session and the request token: a browser is handed a page before it can
  // submit a form, and every write checks the pair (ADR-0021).
  const { cookies } = await signedInCookies(app, sessionCookie);

  const userId = (
    driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }
  ).id;
  const topicRepo = new DrizzleTopicRepo(createDatabase({ driver }));
  await topicRepo.insert(
    makeTopic({ id: 'topic-1', userId, title: 'World news', sourceIds: ['the-guardian'] }),
  );
  await topicRepo.insertTopicSource('topic-1' as TopicId, 'the-guardian', 0);

  return { app, cookie: cookies, driver, topicSlug: 'topic-1', transport };
}

describe('the ingest loop running end to end', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await buildApp();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const tick = () => submitForm(harness.app, harness.cookie, '/api/ingest/tick');

  const count = (table: string): number =>
    (
      harness.driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as {
        n: number;
      }
    ).n;

  it('fills the database from a feed without any manual trigger beyond the process running', async () => {
    const report = await tick();
    expect(report.statusCode).toBe(200);
    const body = report.json() as {
      totals: { inserted: number; merged: number };
      sources: { sourceId: string; success: boolean }[];
    };
    expect(body.sources.map((s) => s.sourceId)).toEqual(['the-guardian']);
    expect(body.sources[0]?.success).toBe(true);
    expect(body.totals.inserted + body.totals.merged).toBe(1);
    expect(count('articles')).toBe(1);
    expect(count('stories')).toBe(1);
  });

  it('leaves the Articles and Stories of a Topic queryable in the database', async () => {
    await tick();
    const typedDb = createDatabase({ driver: harness.driver });

    const articles = await new DrizzleArticleRepo(typedDb).listBySourceIdsInWindow({
      sourceIds: ['the-guardian'],
      windowStart: new Date(0),
    });
    expect(articles.map((a) => a.title)).toEqual(['A perfectly ordinary headline']);

    const stories = await new DrizzleStoryRepo(typedDb).listBySourceIdsInWindow({
      sourceIds: ['the-guardian'],
      windowStart: new Date(0),
    });
    expect(stories).toHaveLength(1);
    expect(stories[0]?.articleCount).toBe(1);
    // The Story the Article belongs to is the same one, which is what makes the
    // pair queryable as a unit.
    expect(articles[0]?.storyId).toBe(stories[0]?.id);
  });

  it('records the last successful run per Source where the status view reads it', async () => {
    await tick();
    const status = await harness.app.inject({
      method: 'GET',
      url: '/api/ingest/status',
      headers: { cookie: harness.cookie },
    });
    const body = status.json() as {
      sources: {
        sourceId: string;
        lastPolledAt: string | null;
        lastSuccessAt: string | null;
      }[];
    };
    const guardian = body.sources.find((s) => s.sourceId === 'the-guardian');
    expect(guardian?.lastPolledAt).toBe(POLL_AT.toISOString());
    expect(guardian?.lastSuccessAt).toBe(POLL_AT.toISOString());

    const dashboard = await harness.app.inject({
      method: 'GET',
      url: '/admin/ingest',
      headers: { cookie: harness.cookie },
    });
    expect(dashboard.body).toContain(POLL_AT.toISOString());
  });

  it('refuses the status view to a caller with no session', async () => {
    for (const url of ['/api/ingest/status', '/admin/ingest']) {
      const res = await harness.app.inject({ method: 'GET', url });
      expect(res.statusCode, url).toBe(401);
    }
  });

  it('polls only the Sources the Topics name', async () => {
    const report = await tick();
    const body = report.json() as { sources: { sourceId: string }[] };
    // The registry holds twenty Sources; this User has one Topic on one of them.
    expect(body.sources).toHaveLength(1);
    expect(body.sources[0]?.sourceId).toBe('the-guardian');
  });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (predicate()) return true;
    await sleep(20);
  }
  return false;
}

function waitForRows(
  driver: Harness['driver'],
  table: string,
  atLeast: number,
  timeoutMs: number,
): Promise<boolean> {
  return waitFor(() => {
    const row = driver
      .prepare(`SELECT COUNT(*) AS n FROM ${table}`)
      .get() as { n: number } | undefined;
    return (row?.n ?? 0) >= atLeast;
  }, timeoutMs);
}

/**
 * A User with one Topic on a real registry Source, written before the
 * application exists so the loop's very first cycle has something to poll.
 */
async function seedTopicOnRealFeed(db: Db): Promise<void> {
  await applyDirectorySeed(db);
  const userRepo = new DrizzleUserRepo(db);
  await userRepo.insert(makeUser({ id: 'u1' }));
  const topicRepo = new DrizzleTopicRepo(db);
  await topicRepo.insert(
    makeTopic({ id: 'topic-1', userId: 'u1' as never, sourceIds: ['the-guardian'] }),
  );
  await topicRepo.insertTopicSource('topic-1' as TopicId, 'the-guardian', 0);
}

describe('the loop started by the application itself', () => {
  it('runs without anything calling the tick endpoint', async () => {
    resetDeterministic();
    const { db, driver } = createTestDb();
    await seedTopicOnRealFeed(db);

    const app = await createApp({
      db,
      emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
      appBaseUrl: 'https://app.brieflyy.test',
      cookieSecure: false,
      clock: makeTestClock(POLL_AT).clock,
      random: deterministicRandom,
      feedFetcher: new StaticFeedFetcher({ entries: [SAFE_ENTRY] }),
      // What the server entrypoint passes: the loop runs for the life of the app.
      ingestAutoStart: true,
      ingestConfig: { intervalMs: 1, backoffBaseMs: 1, backoffMaxMs: 2 },
    });

    try {
      const got = await waitForRows(driver, 'articles', 1, 10_000);
      expect(got, 'the loop never ingested on its own').toBe(true);
      const polled = (
        driver
          .prepare(`SELECT last_polled_at FROM sources WHERE id = 'the-guardian'`)
          .get() as { last_polled_at: number | null }
      ).last_polled_at;
      expect(polled).toBe(POLL_AT.getTime());
    } finally {
      await app.close();
    }
  });

  it('waits for an in-flight cycle when the application closes', async () => {
    // This is the guarantee the signal handler leans on: closing the app must not
    // abandon a cycle halfway through writing Articles, because the caller
    // closes the database as soon as close() resolves.
    resetDeterministic();
    const { db, driver } = createTestDb();
    await seedTopicOnRealFeed(db);

    const gate: { release: (() => void) | null } = { release: null };
    const app = await createApp({
      db,
      emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
      appBaseUrl: 'https://app.brieflyy.test',
      cookieSecure: false,
      clock: makeTestClock(POLL_AT).clock,
      random: deterministicRandom,
      feedFetcher: {
        async fetch(): Promise<RawFeed> {
          await new Promise<void>((resolve) => {
            gate.release = resolve;
          });
          return { entries: [SAFE_ENTRY] };
        },
      },
      ingestAutoStart: true,
      ingestConfig: { intervalMs: 1, backoffBaseMs: 1, backoffMaxMs: 2 },
    });

    // Wait for the loop to reach the feed.
    const reached = await waitFor(() => gate.release !== null, 10_000);
    expect(reached, 'the loop never started a cycle').toBe(true);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((r) => setImmediate(r));
    expect(closed, 'close() resolved while a cycle was still in flight').toBe(false);

    gate.release!();
    await closing;

    expect(closed).toBe(true);
    const articles = (
      driver.prepare(`SELECT COUNT(*) AS n FROM articles`).get() as { n: number }
    ).n;
    expect(articles, 'the cycle close() waited for did not land').toBe(1);
  });

  it('closes promptly even though the interval is long', async () => {
    // The default interval is half an hour. A stop that only set a flag would
    // leave the process alive for that long after a signal.
    resetDeterministic();
    const { db } = createTestDb();
    const app = await createApp({
      db,
      emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
      appBaseUrl: 'https://app.brieflyy.test',
      cookieSecure: false,
      clock: makeTestClock(POLL_AT).clock,
      random: deterministicRandom,
      feedFetcher: new StaticFeedFetcher({ entries: [SAFE_ENTRY] }),
      ingestAutoStart: true,
      ingestConfig: {
        intervalMs: 30 * 60 * 1000,
        backoffBaseMs: 1000,
        backoffMaxMs: 2000,
      },
    });

    const startedAt = Date.now();
    await app.close();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });
});

describe('hostile feed content', () => {
  let harness: Harness;

  beforeEach(async () => {
    resetDeterministic();
    const { db, driver } = createTestDb();
    const transport = new ConsoleEmailTransport({ logger: () => {} });
    const app = await createApp({
      db,
      emailTransport: transport,
      appBaseUrl: 'https://app.brieflyy.test',
      cookieSecure: false,
      clock: makeTestClock(POLL_AT).clock,
      random: deterministicRandom,
      // The real parser, fed real hostile XML rather than pre-parsed entries.
      feedFetcher: {
        async fetch(): Promise<RawFeed> {
          const { parseRss } = await import('../ingest/rss-parser.js');
          return parseRss(HOSTILE_FEED_XML);
        },
      },
    });
    const sent0 = transport.snapshot();
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email: 'mallory@example.com' },
    });
    const all = transport.snapshot();
    const token = extractMagicLinkToken(all[sent0.length]!.text);
    const verified = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
    });
    const raw = verified.headers['set-cookie'];
    const sessionCookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
    const { cookies } = await signedInCookies(app, sessionCookie);
    const userId = (
      driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }
    ).id;
    const topicRepo = new DrizzleTopicRepo(createDatabase({ driver }));
    await topicRepo.insert(
      makeTopic({
        id: 'topic-1',
        userId,
        title: 'World news',
        sourceIds: ['the-guardian'],
      }),
    );
    await topicRepo.insertTopicSource('topic-1' as TopicId, 'the-guardian', 0);
    harness = { app, cookie: cookies, driver, topicSlug: 'topic-1', transport };
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('stores no URL that a click would execute', async () => {
    await submitForm(harness.app, harness.cookie, '/api/ingest/tick');
    const rows = harness.driver
      .prepare(`SELECT external_id, url FROM articles`)
      .all() as { external_id: string; url: string }[];

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(
        row.url === '' || isSafeExternalUrl(row.url),
        `${row.external_id} stored ${JSON.stringify(row.url)}`,
      ).toBe(true);
    }
  });

  it('keeps the hostile entries, so their text still reaches the pipeline', async () => {
    await submitForm(harness.app, harness.cookie, '/api/ingest/tick');
    const rows = harness.driver
      .prepare(`SELECT title, body FROM articles ORDER BY external_id`)
      .all() as { title: string; body: string }[];
    // A feed is allowed to say something. What it is not allowed to do is have
    // that something run, so the text is kept and the markup is not.
    expect(rows).toHaveLength(3);
    expect(rows.some((r) => r.title.includes('alert'))).toBe(true);
    for (const row of rows) {
      expect(row.body, row.title).not.toMatch(/<[a-z/]/i);
      expect(row.body, row.title).not.toMatch(/on[a-z]+\s*=/i);
    }
  });

  it('reaches the page with nothing executable on it', async () => {
    await submitForm(harness.app, harness.cookie, '/api/ingest/tick');
    // Give the Clusters something to render from, since that is what the page
    // shows, and let a Cluster carry the hostile text through.
    const clusterRepo = new DrizzleClusterRepo(
      createDatabase({ driver: harness.driver }),
    );
    const storyRow = harness.driver
      .prepare(`SELECT id FROM stories LIMIT 1`)
      .get() as { id: string };
    const article = harness.driver
      .prepare(`SELECT title, body FROM articles ORDER BY external_id LIMIT 1`)
      .get() as { title: string; body: string };
    await clusterRepo.insert(
      {
        id: 'cluster-hostile' as never,
        topicId: 'topic-1',
        title: article.title,
        summary: article.body,
        bulletPoints: [article.title, article.body],
        createdAt: POLL_AT,
        lastSeenAt: POLL_AT,
        articleCount: 3,
        velocity: 1,
        sourceIds: ['the-guardian'],
        state: 'active',
      },
      [storyRow.id as never],
    );

    const page = await harness.app.inject({
      method: 'GET',
      url: `/topics/${harness.topicSlug}`,
      headers: { cookie: harness.cookie },
    });
    expect(page.statusCode).toBe(200);
    assertNothingExecutable(page.body);
    // The page rendered the hostile entry rather than dropping the Topic's
    // content on the floor.
    expect(page.body).toContain('active cluster');
    // And no link to nowhere: an Article with no usable URL shows its title
    // rather than an href that reloads the page the User is on.
    expect(page.body).not.toMatch(/href=""/);
  });

  it('reaches the email with nothing executable in it', async () => {
    await submitForm(harness.app, harness.cookie, '/api/ingest/tick');
    const article = harness.driver
      .prepare(`SELECT title, body, url FROM articles ORDER BY external_id LIMIT 1`)
      .get() as { title: string; body: string; url: string };
    const clusterRepo = new DrizzleClusterRepo(
      createDatabase({ driver: harness.driver }),
    );
    const storyRow = harness.driver
      .prepare(`SELECT id FROM stories LIMIT 1`)
      .get() as { id: string };
    await clusterRepo.insert(
      {
        id: 'cluster-hostile' as never,
        topicId: 'topic-1',
        title: article.title,
        summary: article.body,
        bulletPoints: [article.body, article.title],
        createdAt: POLL_AT,
        lastSeenAt: POLL_AT,
        articleCount: 3,
        velocity: 1,
        sourceIds: ['the-guardian'],
        state: 'active',
      },
      [storyRow.id as never],
    );

    // The delivered email rather than a hand-built document: the brief a User
    // receives is the one that has to survive hostile feed content, and the
    // plain-text half is checked too because it is the copy a client that
    // ignores HTML is left with.
    await submitForm(harness.app, harness.cookie, '/topics/topic-1/send-brief');
    const delivered = harness.transport.snapshot().at(-1);
    expect(delivered?.subject).toBe('World news - Brieflyy');
    assertNothingExecutable(delivered?.html ?? '');
    // The text half is held to the link rule and not the tag rule, and the
    // difference is the point of it: a feed wrote those characters, so they are
    // quoted back as the visible text they are, and a client showing this part
    // is showing text rather than interpreting it. What would still be a defect
    // here is a link out to a scheme that runs on click.
    expect(delivered?.text).not.toMatch(/(^|\s)javascript:/i);
    expect(delivered?.text).not.toMatch(/(^|\s)data:/i);
  });
});
