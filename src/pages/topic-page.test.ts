import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { makeCluster, makeTopic } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import type { SourceId, StoryId, TopicId } from '../domain/types.js';

const NOW = new Date('2026-09-02T12:00:00Z');

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly clusterRepo: DrizzleClusterRepo;
  readonly topicRepo: DrizzleTopicRepo;
  readonly sourceRepo: DrizzleSourceRepo;
  readonly storyRepo: DrizzleStoryRepo;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
}

/** A signed-in User with one Topic wired to two Sources. */
async function signInWithTopic(options: { readonly withSources?: boolean } = {}): Promise<Harness> {
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
  const setCookie = verify.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';')[0]!;

  const topicRepo = new DrizzleTopicRepo(db);
  const sourceRepo = new DrizzleSourceRepo(db);
  const userId = (driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
  await topicRepo.insert(makeTopic({ id: 'topic-1', userId, title: 'World news' }));

  if (options.withSources !== false) {
    for (const id of ['reuters', 'the-guardian'] as SourceId[]) {
      await sourceRepo.insert({
        id,
        slug: id,
        name: id === 'reuters' ? 'Reuters' : 'The Guardian',
        homepageUrl: `https://${id}.example.com`,
        feedUrl: null,
        lastPolledAt: null,
        lastSuccessAt: null,
      });
      await topicRepo.insertTopicSource('topic-1', id, 0);
    }
  }

  return {
    app,
    cookie,
    clusterRepo: new DrizzleClusterRepo(db),
    topicRepo,
    sourceRepo,
    storyRepo: new DrizzleStoryRepo(db),
    driver,
  };
}

/** Write a Story and an Article so a Cluster has a source Article to link to. */
async function givenStory(
  h: Harness,
  input: {
    readonly id: string;
    readonly sourceId?: SourceId;
    readonly title: string;
    readonly url?: string;
  },
): Promise<StoryId> {
  const storyId = input.id as StoryId;
  await h.storyRepo.insert({
    id: storyId,
    sourceId: input.sourceId ?? ('reuters' as SourceId),
    fingerprint: `fp-${input.id}`,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  });
  h.driver
    .prepare(
      `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, fingerprint, story_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      `article-${input.id}`,
      input.sourceId ?? 'reuters',
      `ext-${input.id}`,
      input.url ?? `https://example.com/${input.id}`,
      input.title,
      `${input.title} happened in full, according to people who were there.`,
      NOW.getTime(),
      NOW.getTime(),
      `fp-${input.id}`,
      storyId,
    );
  return storyId;
}

async function givenCluster(
  h: Harness,
  input: {
    readonly id: string;
    readonly storyId: string;
    readonly summary: string;
    readonly bullets?: readonly string[];
    readonly sourceIds: readonly string[];
    readonly state?: 'active' | 'archive';
  },
): Promise<void> {
  await h.clusterRepo.insert(
    makeCluster({
      id: input.id,
      topicId: 'topic-1',
      title: input.summary,
      summary: input.summary,
      bulletPoints: input.bullets ?? [],
      sourceIds: input.sourceIds,
      lastSeenAt: NOW,
      ...(input.state === undefined ? {} : { state: input.state }),
    }),
    [input.storyId as StoryId],
  );
}

function page(h: Harness, url: string) {
  return h.app.inject({
    method: 'GET',
    url,
    headers: { cookie: h.cookie },
  });
}

/**
 * The Source filter bar, or '' when the page has none.
 *
 * Scoped to the bar because `?source=` also appears in each Cluster's own
 * Source links, which are a different control and are meant to be offered even
 * when that Source is the one being filtered to.
 */
function filterBar(body: string): string {
  return /<p class="filter-bar">(.*?)<\/p>/s.exec(body)?.[1] ?? '';
}

describe('HTTP: /topics/:slug as a LivingBrief', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('shows an empty Topic as empty rather than pretending it has Clusters', async () => {
    const resp = await page(h, '/topics/topic-1');

    expect(resp.statusCode).toBe(200);
    expect(resp.body).toContain('No stories yet for this topic');
    expect(resp.body).toContain('0 active clusters');
  });

  it('shows each Active Cluster with its one-liner and its bullets', async () => {
    const storyId = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId,
      summary: 'Acme Corp unveiled an AI product called Foo at a conference today.',
      bullets: [
        'The launch changes the landscape for enterprise customers.',
        'Analysts had expected the launch in the spring.',
      ],
      sourceIds: ['reuters'],
    });

    const resp = await page(h, '/topics/topic-1');

    expect(resp.statusCode).toBe(200);
    expect(resp.body).toContain('Acme Corp unveiled an AI product called Foo');
    expect(resp.body).toContain('The launch changes the landscape');
    expect(resp.body).toContain('Analysts had expected the launch in the spring.');
    expect(resp.body).toContain('1 active cluster');
    expect(resp.body).not.toContain('No stories yet for this topic');
  });

  it('leaves Archived Clusters out of the LivingBrief', async () => {
    const storyId = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId,
      summary: 'An active thing that is happening now.',
      sourceIds: ['reuters'],
    });
    await givenCluster(h, {
      id: 'cluster-2',
      storyId,
      summary: 'An archived thing that stopped moving.',
      sourceIds: ['reuters'],
      state: 'archive',
    });

    const resp = await page(h, '/topics/topic-1');

    expect(resp.body).toContain('An active thing that is happening now.');
    expect(resp.body).not.toContain('An archived thing that stopped moving.');
    expect(resp.body).toContain('1 active cluster');
  });

  it('says a Topic has Clusters but none Active, rather than showing the empty state', async () => {
    const storyId = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId,
      summary: 'An archived thing that stopped moving.',
      sourceIds: ['reuters'],
      state: 'archive',
    });

    const resp = await page(h, '/topics/topic-1');

    expect(resp.body).not.toContain('No stories yet for this topic');
    expect(resp.body).toContain('0 active clusters');
  });

  it('links each Cluster to the Articles it was formed from', async () => {
    const storyId = await givenStory(h, {
      id: 's1',
      title: 'Acme Corp unveils Foo',
      url: 'https://www.reuters.com/acme-foo',
    });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId,
      summary: 'Acme Corp unveiled Foo today.',
      sourceIds: ['reuters'],
    });

    const resp = await page(h, '/topics/topic-1');

    expect(resp.body).toContain('href="https://www.reuters.com/acme-foo"');
    expect(resp.body).toContain('Acme Corp unveils Foo');
  });

  it('filters the Clusters by Source, and offers a way back out of the filter', async () => {
    const reutersStory = await givenStory(h, {
      id: 's1',
      sourceId: 'reuters' as SourceId,
      title: 'Acme Corp unveils Foo',
    });
    const guardianStory = await givenStory(h, {
      id: 's2',
      sourceId: 'the-guardian' as SourceId,
      title: 'BrandX Inc buys TinyCo',
    });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId: reutersStory,
      summary: 'A Reuters story about Acme Corp.',
      sourceIds: ['reuters'],
    });
    await givenCluster(h, {
      id: 'cluster-2',
      storyId: guardianStory,
      summary: 'A Guardian story about BrandX Inc.',
      sourceIds: ['the-guardian'],
    });

    const filtered = await page(h, '/topics/topic-1?source=reuters');

    expect(filtered.body).toContain('A Reuters story about Acme Corp.');
    expect(filtered.body).not.toContain('A Guardian story about BrandX Inc.');
    expect(filtered.body).toContain('1 active cluster');
  });

  it('says the filter matched nothing rather than that the Topic is empty', async () => {
    const storyId = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId,
      summary: 'A Reuters story about Acme Corp.',
      sourceIds: ['reuters'],
    });

    const filtered = await page(h, '/topics/topic-1?source=the-guardian');

    expect(filtered.statusCode).toBe(200);
    expect(filtered.body).not.toContain('No stories yet for this topic');
    expect(filtered.body).toContain('No clusters match');
    // And a way back to the unfiltered LivingBrief.
    expect(filtered.body).toMatch(/href="\/topics\/topic-1"/);
  });

  it('says the filter hid everything rather than that the Topic is empty', async () => {
    const storyId = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId,
      summary: 'A Reuters story about Acme Corp.',
      sourceIds: ['reuters'],
    });

    const hidden = await page(h, '/topics/topic-1?hide=cluster-1');

    expect(hidden.statusCode).toBe(200);
    expect(hidden.body).not.toContain('No stories yet for this topic');
    expect(hidden.body).toContain('No clusters match');
  });

  it('says nothing about filters on a page that is showing its Clusters', async () => {
    const storyId = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId,
      summary: 'A Reuters story about Acme Corp.',
      sourceIds: ['reuters'],
    });
    await givenCluster(h, {
      id: 'cluster-2',
      storyId,
      summary: 'A second story about BrandX Inc.',
      sourceIds: ['the-guardian'],
    });

    const resp = await page(h, '/topics/topic-1');

    // Two Clusters are on the page, so nothing has been filtered out and the
    // page must not claim otherwise.
    expect(resp.body).not.toContain('No clusters match');
    expect(resp.body).not.toContain('No stories yet');
  });

  it('counts only the Clusters its way-out link can actually bring back', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    const s2 = await givenStory(h, {
      id: 's2',
      sourceId: 'the-guardian',
      title: 'BrandX Inc talks to nobody',
    });
    const s3 = await givenStory(h, { id: 's3', title: 'Cement Co results surprise' });
    await givenCluster(h, { id: 'cluster-1', storyId: s1, summary: 'Reuters one.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-2', storyId: s2, summary: 'Guardian one.', sourceIds: ['the-guardian'] });
    await givenCluster(h, { id: 'cluster-3', storyId: s3, summary: 'Reuters two.', sourceIds: ['reuters'] });
    // The User hides one Cluster from this Topic for good, then filters to a
    // Source that matches nothing.
    await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/feedback',
      headers: { cookie: h.cookie },
      payload: { clusterId: 'cluster-1', type: 'hide_source', scope: 'this_topic' },
    });

    const filtered = await page(h, '/topics/topic-1?source=the-guardian&hide=cluster-2');

    // Three Clusters are Active, but a Feedback hide removes one of them for
    // good, so the link can only promise the other two. Counting the Active set
    // would have said "Show all 3".
    expect(filtered.body).toContain('Show all 2 active clusters');
    expect(filtered.body).not.toContain('Show all 3 active clusters');
  });

  it('does not offer a way out when Feedback alone is hiding everything', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await givenCluster(h, { id: 'cluster-1', storyId: s1, summary: 'Reuters one.', sourceIds: ['reuters'] });
    await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/feedback',
      headers: { cookie: h.cookie },
      payload: { clusterId: 'cluster-1', type: 'hide_source', scope: 'this_topic' },
    });

    const filtered = await page(h, '/topics/topic-1?source=the-guardian');

    // A "Show all 0 active clusters" link would be a dead end: clearing the
    // query string does not bring back a Cluster the User hid for good.
    expect(filtered.body).not.toContain('No clusters match the current filter');
    expect(filtered.body).not.toContain('Show all 0');
    expect(filtered.body).toContain('you hid all 1 active cluster');
  });

  it('drops the filter it is already applying rather than offering it again', async () => {
    const reutersStory = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    const guardianStory = await givenStory(h, {
      id: 's2',
      sourceId: 'the-guardian',
      title: 'BrandX Inc talks to nobody',
    });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId: reutersStory,
      summary: 'A Reuters story about Acme Corp.',
      sourceIds: ['reuters'],
    });
    await givenCluster(h, {
      id: 'cluster-2',
      storyId: guardianStory,
      summary: 'A Guardian story about BrandX Inc.',
      sourceIds: ['the-guardian'],
    });

    const filtered = await page(h, '/topics/topic-1?source=reuters');
    const bar = filterBar(filtered.body);

    // The Source being filtered to links back to everything rather than to
    // itself. The other Source stays on offer even though its Cluster is
    // filtered out, because the bar is built from the unfiltered set: every
    // link there is one that can still show something.
    expect(bar).toContain('?source=the-guardian');
    expect(bar).not.toContain('?source=reuters');
    expect(bar).toContain('href="/topics/topic-1"');
    // And the filter really did remove the Guardian Cluster from the brief.
    expect(filtered.body).not.toContain('A Guardian story about BrandX Inc.');
    expect(filtered.body).toContain('A Reuters story about Acme Corp.');
  });

  it('shows the Cluster window the Topic is set to, and lets the User change it', async () => {
    const resp = await page(h, '/topics/topic-1');

    expect(resp.body).toContain('Cluster window');
    expect(resp.body).toMatch(/name="windowDays"[^>]*value="7"/);
    expect(resp.body).toMatch(/action="\/topics\/topic-1\/cluster-window"/);
  });
});

describe('HTTP: /topics/:slug/cluster-window', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('stores the window the User asked for', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/cluster-window',
      headers: { cookie: h.cookie },
      payload: { windowDays: '3' },
    });

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/topics/topic-1');
    const topic = await h.topicRepo.getById('topic-1' as TopicId);
    expect(topic?.clusterWindowDays).toBe(3);
  });

  it('narrowing the window changes what the LivingBrief then shows', async () => {
    const recent = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    const old = await givenStory(h, { id: 's2', title: 'BrandX Inc buys TinyCo' });
    await h.driver
      .prepare(`UPDATE stories SET first_seen_at = ?, last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime() - 5 * 24 * 3600 * 1000, NOW.getTime() - 5 * 24 * 3600 * 1000, old);
    await givenCluster(h, {
      id: 'cluster-1',
      storyId: recent,
      summary: 'A story from this week.',
      sourceIds: ['reuters'],
    });
    await givenCluster(h, {
      id: 'cluster-2',
      storyId: old,
      summary: 'A story from last week.',
      sourceIds: ['reuters'],
    });

    const resp = await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/cluster-window',
      headers: { cookie: h.cookie },
      payload: { windowDays: '2' },
    });
    expect(resp.statusCode).toBe(302);

    // The stored window is what the page reports, and the Clusters the pipeline
    // would form from it are a subset of what it was forming.
    const shown = await page(h, '/topics/topic-1');
    expect(shown.body).toMatch(/name="windowDays"[^>]*value="2"/);
  });

  it('clamps a window that would cluster nothing, rather than accepting it', async () => {
    await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/cluster-window',
      headers: { cookie: h.cookie },
      payload: { windowDays: '0' },
    });

    const topic = await h.topicRepo.getById('topic-1' as TopicId);
    expect(topic?.clusterWindowDays).toBe(1);
  });

  it('falls back to the default when the number is not a number', async () => {
    await h.topicRepo.setClusterWindowDays('topic-1' as TopicId, 4);

    const resp = await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/cluster-window',
      headers: { cookie: h.cookie },
      payload: { windowDays: 'soon' },
    });

    expect(resp.statusCode).toBe(302);
    const topic = await h.topicRepo.getById('topic-1' as TopicId);
    expect(topic?.clusterWindowDays).toBe(7);
  });

  it('redirects to /signup when not authenticated', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/cluster-window',
      payload: { windowDays: '3' },
    });
    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/signup');
  });
});

describe('HTTP: /topics/:slug on a Topic with no Sources', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic({ withSources: false });
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('still shows the empty state rather than failing', async () => {
    const resp = await page(h, '/topics/topic-1');

    expect(resp.statusCode).toBe(200);
    expect(resp.body).toContain('No stories yet for this topic');
  });
});
