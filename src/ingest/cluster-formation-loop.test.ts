import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildAppHarness, type AppHarness } from '../testing/app-harness.js';
import { makeTopic } from '../testing/fixtures.js';
import { WIRE_COPIES } from '../testing/story-fixtures.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import type { RawFeed, RawFeedEntry } from '../ingest/feed-fetcher.js';
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

/**
 * The three things a test in this file does: run a cycle, read a Topic as the
 * User sees it, and ask the database directly. One definition of each rather than
 * a copy per `describe`, so a change to how a cycle is triggered is one edit.
 */
function tick(h: AppHarness) {
  return h.app.inject({
    method: 'POST',
    url: '/api/ingest/tick',
    headers: { cookie: h.cookie },
  });
}

function brief(h: AppHarness, slug = 'topic-1', query = '') {
  return h.app.inject({
    method: 'GET',
    url: `/topics/${slug}${query}`,
    headers: { cookie: h.cookie },
  });
}

function rows<T>(
  h: AppHarness,
  sql: string,
  ...params: readonly unknown[]
): readonly T[] {
  return h.driver.prepare(sql).all(...(params as unknown[])) as readonly T[];
}

describe('a Topic filling with Clusters from one ingest cycle', () => {
  let h: AppHarness;

  beforeEach(async () => {
    h = await buildAppHarness({ feeds: FEEDS, now: POLL_AT });
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('groups the Stories into Clusters as part of the cycle', async () => {
    const resp = await tick(h);
    expect(resp.statusCode).toBe(200);

    // Three Articles across two Sources, deduped into two Stories, grouped into
    // two Clusters — with no step between the tick and the Clusters.
    expect(h.count('articles')).toBe(3);
    expect(h.count('stories')).toBe(2);
    expect(h.count('clusters')).toBe(2);
    expect(h.count('cluster_stories')).toBe(2);
  });

  it('shows the User their Clusters without them doing anything else', async () => {
    await tick(h);

    const page = await brief(h);

    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('2 active clusters');
    expect(page.body).not.toContain('No stories yet for this topic');
    // Each Cluster is headed by a sentence from one of its Articles, and both
    // stories are represented.
    expect(page.body).toContain('Acme Corp today unveiled a new AI product called Foo.');
    expect(page.body).toContain('BrandX Inc announced today that it acquired TinyCo');
  });

  it('gives each Cluster bullets and links to its Articles', async () => {
    await tick(h);

    const page = await brief(h);

    expect(page.body).toContain('The deal closed on Tuesday.');
    expect(page.body).toContain('https://www.theguardian.com/acme-1');
    expect(page.body).toContain('https://www.bbc.co.uk/news/brandx-1');
  });

  it('lists both Sources, and lets the User narrow to one of them', async () => {
    await tick(h);

    const page = await brief(h);
    expect(page.body).toContain('The Guardian');
    expect(page.body).toContain('BBC News');

    const filtered = await brief(h, 'topic-1', '?source=the-guardian');
    expect(filtered.body).toContain('Acme Corp today unveiled a new AI product called Foo.');
    expect(filtered.body).not.toContain('BrandX Inc announced today');
  });

  it('gives every Cluster a velocity of Stories per unit time, not a whole number', async () => {
    await tick(h);

    const clusters = rows<{ velocity: number; state: string }>(h,
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
    await tick(h);
    const firstIds = rows<{ id: string }>(
      h,
      `SELECT id FROM clusters ORDER BY id`,
    ).map((r) => r.id);

    h.clock.advance(30 * 60 * 1000);
    await tick(h);
    const secondIds = rows<{ id: string }>(
      h,
      `SELECT id FROM clusters ORDER BY id`,
    ).map((r) => r.id);

    expect(secondIds).toEqual(firstIds);
    expect(h.count('clusters')).toBe(2);
  });

  it('reaches the archive as the Stories age out of the window', async () => {
    await tick(h);
    expect(h.count('clusters')).toBe(2);

    // Nine days on, the Articles are outside the seven-day window, so there is
    // nothing left to form and the Clusters stop being Active.
    h.clock.advance(9 * 24 * 60 * 60 * 1000);
    await tick(h);

    const states = rows<{ state: string }>(h, `SELECT state FROM clusters`);
    expect(states.every((r) => r.state === 'archive')).toBe(true);

    const page = await brief(h);
    expect(page.body).not.toContain('No stories yet for this topic');
    expect(page.body).toContain('been archived');
  });

  it('narrows what it forms when the User shortens the window', async () => {
    await tick(h);
    expect(h.count('clusters')).toBe(2);

    const saved = await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/cluster-window',
      headers: { cookie: h.cookie },
      payload: { windowDays: '1' },
    });
    expect(saved.statusCode).toBe(302);

    // Both stories are still inside a one-day window, so the count holds; what
    // changes is the window the next cycle forms against, and the page says so.
    await tick(h);
    const topic = rows<{ cluster_window_days: number }>(h,
      `SELECT cluster_window_days FROM topics WHERE id = 'topic-1'`,
    );
    expect(topic[0]?.cluster_window_days).toBe(1);

    const page = await brief(h);
    expect(page.body).toMatch(/name="windowDays"[^>]*value="1"/);
  });
});

/**
 * The same news, carried by two outlets, each with its own rewrites of it.
 *
 * These are entries from the same fixture the dedup is measured against, taken
 * from different ends of it, so the two feeds share no headline and no sentence:
 * what puts them in one Story is the signature comparison and nothing else.
 */
function syndicated(
  prefix: string,
  urlPrefix: string,
  copies: readonly number[],
  at: string,
): readonly RawFeedEntry[] {
  return copies.map((copy, i) => ({
    externalId: `${prefix}-${i}`,
    url: `${urlPrefix}/${prefix}-${i}`,
    title: WIRE_COPIES[copy]!.headline,
    body: WIRE_COPIES[copy]!.body,
    publishedAt: new Date(new Date(at).getTime() + i * 10 * 60_000),
  }));
}

const SYNDICATED_FEEDS: Readonly<Record<string, RawFeed>> = {
  'https://www.theguardian.com/world/rss': {
    entries: syndicated('g', 'https://www.theguardian.com/acme', [0, 5], '2026-09-02T10:00:00Z'),
  },
  'https://feeds.bbci.co.uk/news/rss.xml': {
    entries: syndicated('b', 'https://www.bbc.co.uk/news/acme', [11, 19], '2026-09-02T10:30:00Z'),
  },
};

describe('one story two outlets reported', () => {
  let h: AppHarness;

  beforeEach(async () => {
    h = await buildAppHarness({ feeds: SYNDICATED_FEEDS, now: POLL_AT });
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('is one Story, not one per outlet', async () => {
    const resp = await tick(h);
    expect(resp.statusCode).toBe(200);

    // Four Articles across two outlets, one of them nothing like the others in
    // wording, and a single Story holding all of them.
    expect(h.count('articles')).toBe(4);
    expect(h.count('stories')).toBe(1);

    const story = rows<{ id: string }>(h, `SELECT id FROM stories`)[0]!;
    const inStory = rows<{ n: number; sources: string }>(
      h,
      `SELECT COUNT(*) AS n, GROUP_CONCAT(DISTINCT source_id) AS sources
       FROM articles WHERE story_id = ?`,
      story.id,
    )[0]!;
    expect(inStory.n).toBe(4);
    // The Story names every outlet in it rather than the one that was polled
    // first, and there is no column left that could say otherwise.
    expect(inStory.sources.split(',').sort()).toEqual(['bbc-news', 'the-guardian']);
  });

  it('is one Cluster carrying both outlets', async () => {
    await tick(h);

    expect(h.count('clusters')).toBe(1);
    const cluster = rows<{ source_ids: string; article_count: number }>(
      h,
      `SELECT source_ids, article_count FROM clusters`,
    )[0]!;
    expect(cluster.source_ids.split(',').sort()).toEqual(['bbc-news', 'the-guardian']);
    expect(cluster.article_count).toBe(4);
  });

  it('shows the User both outlets and a link into each of their copies', async () => {
    await tick(h);

    const page = await brief(h);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('The Guardian');
    expect(page.body).toContain('BBC News');
    expect(page.body).toContain('https://www.theguardian.com/acme/g-0');
    expect(page.body).toContain('https://www.bbc.co.uk/news/acme/b-0');
  });

  it('keeps the Cluster when the User narrows to one of the two outlets', async () => {
    await tick(h);

    const filtered = await brief(h, 'topic-1', '?source=the-guardian');
    // The filter narrows which Clusters are shown, not what is inside one: both
    // outlets reported this story, so it is the Guardian's Cluster and the
    // Guardian's copy is in it. Each link still says which outlet wrote it.
    expect(filtered.body).toContain('https://www.theguardian.com/acme/g-0');
    expect(filtered.body).toContain('BBC News:');
  });
});

describe('one story two outlets reported, on a Topic that follows one of them', () => {
  let h: AppHarness;

  beforeEach(async () => {
    // Two Topics on one User, which is the shape the leak takes: the same
    // syndicated story is ingested because one Topic follows both outlets, and
    // the other Topic follows only one of them.
    h = await buildAppHarness({
      feeds: SYNDICATED_FEEDS,
      now: POLL_AT,
      sources: ['the-guardian', 'bbc-news'],
    });
    const userId = (
      h.driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }
    ).id;
    const topicRepo = new DrizzleTopicRepo(h.db);
    await topicRepo.insert(makeTopic({ id: 'topic-2', userId, title: 'Guardian only' }));
    await topicRepo.insertTopicSource('topic-2' as TopicId, 'the-guardian', 0);
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('is one Story for the User, and only the followed outlet in the one Topic', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/api/ingest/tick',
      headers: { cookie: h.cookie },
    });
    expect(resp.statusCode).toBe(200);

    // One Story across both outlets, for both Topics: which outlets reported
    // something is a fact about the reporting and not about who follows whom.
    expect(h.count('articles')).toBe(4);
    expect(h.count('stories')).toBe(1);

    const clusters = h.driver
      .prepare(`SELECT topic_id, source_ids, article_count FROM clusters ORDER BY topic_id`)
      .all() as { topic_id: string; source_ids: string; article_count: number }[];
    expect(clusters).toHaveLength(2);
    expect(clusters.find((c) => c.topic_id === 'topic-1')?.source_ids).toBe(
      'bbc-news,the-guardian',
    );
    // The other User's copy of the same story was ingested for a different
    // Topic, and quoting it here would put a Source this User never added into
    // their brief, into their article list, and into the source filter they are
    // offered.
    expect(clusters.find((c) => c.topic_id === 'topic-2')).toEqual({
      topic_id: 'topic-2',
      source_ids: 'the-guardian',
      article_count: 2,
    });

    const page = await h.app.inject({
      method: 'GET',
      url: '/topics/topic-2',
      headers: { cookie: h.cookie },
    });
    expect(page.body).toContain('The Guardian');
    expect(page.body).toContain('https://www.theguardian.com/acme/g-0');
    expect(page.body).not.toContain('BBC News');
    expect(page.body).not.toContain('https://www.bbc.co.uk/news/acme/b-0');
    expect(page.body).not.toContain('source=bbc-news');
  });
});
