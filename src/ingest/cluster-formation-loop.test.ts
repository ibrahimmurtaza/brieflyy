import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { makeTopic } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import type { FeedFetcher, RawFeed, RawFeedEntry } from '../ingest/feed-fetcher.js';
import type { TopicId } from '../domain/types.js';

const POLL_AT = new Date('2026-09-02T12:00:00Z');

/**
 * Two Sources carrying one story each: The Guardian covers Acme, the BBC covers
 * BrandX. Two Sources and two stories is the smallest shape that shows both
 * that unrelated stories split into separate Clusters and that a Cluster's
 * Source list is the union of the Sources its Articles came from.
 */
const ACME_BODY =
  'Acme Corp today unveiled a new AI product called Foo. Analysts said the launch changes the landscape for enterprise customers.';
const BRANDX_BODY =
  'BrandX Inc announced today that it acquired TinyCo for $2B. The deal closed on Tuesday.';

const FEEDS: Readonly<Record<string, RawFeed>> = {
  'https://www.theguardian.com/world/rss': {
    entries: [
      {
        externalId: 'g-a1',
        url: 'https://www.theguardian.com/acme-1',
        title: 'Acme Corp launches new AI product',
        body: ACME_BODY,
        publishedAt: new Date('2026-09-02T10:00:00Z'),
      },
      {
        externalId: 'g-a2',
        url: 'https://www.theguardian.com/acme-2',
        title: 'Acme Corp unveils new AI product',
        body: ACME_BODY,
        publishedAt: new Date('2026-09-02T10:20:00Z'),
      },
    ],
  },
  'https://feeds.bbci.co.uk/news/rss.xml': {
    entries: [
      {
        externalId: 'b-b1',
        url: 'https://www.bbc.co.uk/news/brandx-1',
        title: 'BrandX Inc acquires TinyCo',
        body: BRANDX_BODY,
        publishedAt: new Date('2026-09-02T10:40:00Z'),
      },
    ],
  },
};

class SeededFeedFetcher implements FeedFetcher {
  async fetch(url: string): Promise<RawFeed> {
    const feed = FEEDS[url];
    if (!feed) throw new Error(`unexpected feed url ${url}`);
    return feed;
  }
}

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
  readonly clock: ReturnType<typeof makeTestClock>;
}

/**
 * The whole path, with nothing but a tick in the middle: a signed-in User, a
 * Topic on two Sources, a feed, and no manual step that writes a Cluster.
 */
async function buildHarness(): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(POLL_AT);
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: clock.clock,
    random: deterministicRandom,
    feedFetcher: new SeededFeedFetcher(),
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
  const cookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;

  // The Directory seeds the Sources, so only the Topic has to be written here.
  const topicRepo = new DrizzleTopicRepo(db);
  const userId = (driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
  await topicRepo.insert(makeTopic({ id: 'topic-1', userId, title: 'World news' }));
  for (const id of ['the-guardian', 'bbc-news']) {
    await topicRepo.insertTopicSource('topic-1' as TopicId, id, 0);
  }

  return { app, cookie, driver, clock };
}

function count(h: Harness, table: string): number {
  return (
    h.driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
  ).n;
}

function rows<T>(h: Harness, sql: string): readonly T[] {
  return h.driver.prepare(sql).all() as readonly T[];
}

describe('a Topic filling with Clusters from one ingest cycle', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await buildHarness();
  });

  afterEach(async () => {
    await h.app.close();
  });

  const tick = () =>
    h.app.inject({
      method: 'POST',
      url: '/api/ingest/tick',
      headers: { cookie: h.cookie },
    });

  const brief = () =>
    h.app.inject({
      method: 'GET',
      url: '/topics/topic-1',
      headers: { cookie: h.cookie },
    });

  it('groups the Stories into Clusters as part of the cycle', async () => {
    const resp = await tick();
    expect(resp.statusCode).toBe(200);

    // Three Articles across two Sources, deduped into two Stories, grouped into
    // two Clusters — with no step between the tick and the Clusters.
    expect(count(h, 'articles')).toBe(3);
    expect(count(h, 'stories')).toBe(2);
    expect(count(h, 'clusters')).toBe(2);
    expect(count(h, 'cluster_stories')).toBe(2);
  });

  it('shows the User their Clusters without them doing anything else', async () => {
    await tick();

    const page = await brief();

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('2 active clusters');
    expect(page.body).not.toContain('No stories yet for this topic');
    // Each Cluster is headed by a sentence from one of its Articles, and both
    // stories are represented.
    expect(page.body).toContain('Acme Corp today unveiled a new AI product called Foo.');
    expect(page.body).toContain('BrandX Inc announced today that it acquired TinyCo');
  });

  it('gives each Cluster bullets and links to its Articles', async () => {
    await tick();

    const page = await brief();

    expect(page.body).toContain('The deal closed on Tuesday.');
    expect(page.body).toContain('https://www.theguardian.com/acme-1');
    expect(page.body).toContain('https://www.bbc.co.uk/news/brandx-1');
  });

  it('lists both Sources, and lets the User narrow to one of them', async () => {
    await tick();

    const page = await brief();
    expect(page.body).toContain('The Guardian');
    expect(page.body).toContain('BBC News');

    const filtered = await h.app.inject({
      method: 'GET',
      url: '/topics/topic-1?source=the-guardian',
      headers: { cookie: h.cookie },
    });
    expect(filtered.body).toContain('Acme Corp today unveiled a new AI product called Foo.');
    expect(filtered.body).not.toContain('BrandX Inc announced today');
  });

  it('gives every Cluster a velocity of Stories per unit time, not a whole number', async () => {
    await tick();

    const clusters = rows<{ velocity: number; state: string }>(
      h,
      `SELECT velocity, state FROM clusters`,
    );
    for (const cluster of clusters) {
      // One Story, first seen two hours before the cycle finished, so the rate
      // is the day-long floor rather than the count of one.
      expect(cluster.velocity).toBeCloseTo(1, 6);
      expect(cluster.state).toBe('active');
    }
  });

  it('does not pile up a fresh copy of every Cluster on each cycle', async () => {
    await tick();
    const firstIds = rows<{ id: string }>(h, `SELECT id FROM clusters ORDER BY id`).map(
      (r) => r.id,
    );

    h.clock.advance(30 * 60 * 1000);
    await tick();
    const secondIds = rows<{ id: string }>(h, `SELECT id FROM clusters ORDER BY id`).map(
      (r) => r.id,
    );

    expect(secondIds).toEqual(firstIds);
    expect(count(h, 'clusters')).toBe(2);
  });

  it('reaches the archive as the Stories age out of the window', async () => {
    await tick();
    expect(count(h, 'clusters')).toBe(2);

    // Nine days on, the Articles are outside the seven-day window, so there is
    // nothing left to form and the Clusters stop being Active.
    h.clock.advance(9 * 24 * 60 * 60 * 1000);
    await tick();

    const states = rows<{ state: string }>(h, `SELECT state FROM clusters`);
    expect(states.every((r) => r.state === 'archive')).toBe(true);

    const page = await brief();
    expect(page.body).not.toContain('No stories yet for this topic');
    expect(page.body).toContain('been archived');
  });

  it('narrows what it forms when the User shortens the window', async () => {
    await tick();
    expect(count(h, 'clusters')).toBe(2);

    const saved = await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/cluster-window',
      headers: { cookie: h.cookie },
      payload: { windowDays: '1' },
    });
    expect(saved.statusCode).toBe(302);

    // Both stories are still inside a one-day window, so the count holds; what
    // changes is the window the next cycle forms against, and the page says so.
    await tick();
    const topic = rows<{ cluster_window_days: number }>(
      h,
      `SELECT cluster_window_days FROM topics WHERE id = 'topic-1'`,
    );
    expect(topic[0]?.cluster_window_days).toBe(1);

    const page = await brief();
    expect(page.body).toMatch(/name="windowDays"[^>]*value="1"/);
  });
});
