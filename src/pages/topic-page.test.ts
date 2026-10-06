import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { REQUEST_TOKEN_FIELD } from '../config.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { requestTokenOf, signedInCookies, submitForm } from '../testing/forms.js';
import { makeBriefPlan, makeCluster, makeTopic } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleBriefPlanRepo } from '../repos/brief-plan-repo.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import type { SourceId, StoryId, TopicId } from '../domain/types.js';

const NOW = new Date('2026-09-02T12:00:00Z');

interface Harness {
  readonly app: FastifyInstance;
  /** The session and the request token: what a signed-in browser holds. */
  readonly cookie: string;
  readonly clusterRepo: DrizzleClusterRepo;
  readonly topicRepo: DrizzleTopicRepo;
  readonly sourceRepo: DrizzleSourceRepo;
  readonly storyRepo: DrizzleStoryRepo;
  readonly planRepo: DrizzleBriefPlanRepo;
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
  const sessionCookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';')[0]!;
  // The session and the request token: a browser is handed a page before it
  // can submit a form, and every write checks the pair (ADR-0021).
  const { cookies: cookie } = await signedInCookies(app, sessionCookie);

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

  // The request token every POST form on the LivingBrief echoes back. Read out
  // of a real page rather than taken from the cookie, because the point of the
  // guard is that the two have to agree: a page that stopped carrying it would
  // refuse every submission made from it.
  const firstPage = await app.inject({
    method: 'GET',
    url: '/topics/topic-1',
    headers: { cookie },
  });
  const pageToken = new RegExp(`name="${REQUEST_TOKEN_FIELD}" value="([^"]+)"`).exec(
    firstPage.body,
  )?.[1];
  if (pageToken !== requestTokenOf(cookie)) {
    throw new Error('the LivingBrief does not echo the token its cookie names');
  }

  return {
    app,
    cookie,
    clusterRepo: new DrizzleClusterRepo(db),
    topicRepo,
    sourceRepo,
    storyRepo: new DrizzleStoryRepo(db),
    planRepo: new DrizzleBriefPlanRepo(db),
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
    signature: EMPTY_SIGNATURE,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    published: { first: NOW, last: NOW }
  });
  h.driver
    .prepare(
      `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, signature, story_id)
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
      '{}',
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

  it('names the hidden Sources when a Topic has nothing left because of them', async () => {
    // The empty state has to name the cause. A User who hid every Source this
    // Topic followed would otherwise be told to wait for the next ingest, which
    // is running perfectly well.
    const s1 = await givenStory(h, { id: 's1', title: 'Reuters one' });
    const s2 = await givenStory(h, {
      id: 's2',
      sourceId: 'the-guardian' as SourceId,
      title: 'Guardian one',
    });
    await givenCluster(h, { id: 'cluster-1', storyId: s1, summary: 'Reuters one.', sourceIds: ['reuters'] });
    await givenCluster(h, {
      id: 'cluster-2',
      storyId: s2,
      summary: 'Guardian one.',
      sourceIds: ['the-guardian'],
    });

    for (const sourceId of ['reuters', 'the-guardian']) {
      await submitForm(h.app, h.cookie, '/topics/topic-1/feedback', {
        clusterId: 'cluster-1',
        type: 'hide_source',
        sourceId,
        scope: 'this_topic',
      });
    }

    const resp = await page(h, '/topics/topic-1');

    expect(resp.body).toContain('because you hid');
    expect(resp.body).toContain('Reuters');
    expect(resp.body).toContain('The Guardian');
    expect(resp.body).not.toContain('No stories yet for this topic');
    // And nothing to click, because there is nothing the link could bring back.
    expect(resp.body).not.toContain('Show all');
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

  it('counts the Clusters its way-out link can bring back, having told it which to dismiss', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    const s2 = await givenStory(h, { id: 's2', title: 'BrandX Inc talks to nobody' });
    await givenCluster(h, { id: 'cluster-1', storyId: s1, summary: 'Reuters one.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-2', storyId: s2, summary: 'Reuters two.', sourceIds: ['reuters'] });

    // Two Active Clusters, both dismissed by this request, so nothing is showing.
    const filtered = await page(h, '/topics/topic-1?hide=cluster-1,cluster-2');

    // Dropping the query string brings both back, so the link can promise both.
    expect(filtered.body).toContain('No clusters match the current filter');
    expect(filtered.body).toContain('Show all 2 active clusters');
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

  it('shows the Clusters of the latest BriefPlan in the plan\'s order', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Newer story' });
    const s2 = await givenStory(h, { id: 's2', title: 'Older story' });
    await givenCluster(h, { id: 'cluster-new', storyId: s1, summary: 'The newer one.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-old', storyId: s2, summary: 'The older one.', sourceIds: ['reuters'] });
    await h.driver
      .prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime(), 'cluster-new');
    await h.driver
      .prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime() - 86_400_000, 'cluster-old');

    await h.planRepo.insert(
      makeBriefPlan({
        id: 'plan-1',
        topicId: 'topic-1',
        userId: await firstUserId(h),
        clusterIds: ['cluster-old', 'cluster-new'],
      }),
    );

    const body = (await page(h, '/topics/topic-1')).body;

    expect(body.indexOf('The older one.')).toBeLessThan(body.indexOf('The newer one.'));
  });

  it('names a Cluster that arrived since the last plan as not yet planned', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Planned story' });
    const s2 = await givenStory(h, { id: 's2', title: 'New story' });
    await givenCluster(h, { id: 'cluster-planned', storyId: s1, summary: 'The planned one.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-new', storyId: s2, summary: 'The one that is new.', sourceIds: ['reuters'] });

    await h.planRepo.insert(
      makeBriefPlan({
        id: 'plan-1',
        topicId: 'topic-1',
        userId: await firstUserId(h),
        clusterIds: ['cluster-planned'],
      }),
    );

    const body = (await page(h, '/topics/topic-1')).body;

    expect(body).toContain('not yet planned');
    expect(body).toContain('The one that is new.');
    // The planned Cluster is still there, as an article.
    expect(body).toContain('The planned one.');
  });

  it('says which state the page is in when the Topic has no stored plan', async () => {
    const storyId = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId,
      summary: 'Acme Corp unveiled an AI product called Foo.',
      sourceIds: ['reuters'],
    });

    const body = (await page(h, '/topics/topic-1')).body;

    expect(body).toContain('No brief has been planned');
    expect(body).toContain('Acme Corp unveiled an AI product called Foo.');
  });

  it('does not name a Cluster as not yet planned when a hidden Source removed it', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Planned story' });
    const s2 = await givenStory(h, { id: 's2', title: 'Reuters only' });
    await givenCluster(h, { id: 'cluster-planned', storyId: s1, summary: 'The planned one.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-new', storyId: s2, summary: 'The one that is new.', sourceIds: ['reuters'] });

    await h.planRepo.insert(
      makeBriefPlan({
        id: 'plan-1',
        topicId: 'topic-1',
        userId: await firstUserId(h),
        clusterIds: ['cluster-planned'],
      }),
    );
    await submitForm(h.app, h.cookie, '/topics/topic-1/feedback', {
      clusterId: 'cluster-planned',
      type: 'hide_source',
      sourceId: 'reuters',
      scope: 'this_topic',
    });

    const body = (await page(h, '/topics/topic-1')).body;

    expect(body).not.toContain('The one that is new.');
    expect(body).not.toContain('not yet planned');
  });

  it('does not claim a Cluster is missing when one the plan names has gone', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Planned story' });
    await givenCluster(h, { id: 'cluster-live', storyId: s1, summary: 'The live one.', sourceIds: ['reuters'] });
    await givenCluster(h, {
      id: 'cluster-gone',
      storyId: s1,
      summary: 'The gone one.',
      sourceIds: ['reuters'],
      state: 'archive',
    });

    await h.planRepo.insert(
      makeBriefPlan({
        id: 'plan-1',
        topicId: 'topic-1',
        userId: await firstUserId(h),
        clusterIds: ['cluster-gone', 'cluster-live'],
      }),
    );

    const body = (await page(h, '/topics/topic-1')).body;

    expect(body).toContain('The live one.');
    expect(body).not.toContain('The gone one.');
    expect(body).not.toContain('No stories yet');
  });
});

describe('HTTP: /topics/:slug/feedback', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  /** One Cluster with one Story and one Article from `sourceId`. */
  async function givenOneCluster(
    input: { readonly id: string; readonly sourceId?: SourceId; readonly summary: string },
  ): Promise<void> {
    const storyId = await givenStory(h, {
      id: `${input.id}-story`,
      title: `${input.id} headline`,
      ...(input.sourceId ? { sourceId: input.sourceId } : {}),
    });
    await givenCluster(h, {
      id: input.id,
      storyId,
      summary: input.summary,
      sourceIds: [input.sourceId ?? 'reuters'],
    });
  }

  function giveFeedback(payload: Record<string, string>) {
    return submitForm(h.app, h.cookie, '/topics/topic-1/feedback', payload);
  }

  /** The `aria-pressed` state of one signal button on the page. */
  function pressed(body: string, type: string): string | null {
    const button = new RegExp(
      `<button[^>]*name="type" value="${type}"[^>]*aria-pressed="(true|false)"`,
    ).exec(body);
    return button?.[1] ?? null;
  }

  /** The `aria-pressed` state of the Hide-source button on the page. */
  function hidePressed(body: string): string | null {
    return /<button[^>]*aria-pressed="(true|false)"[^>]*>Hide source</.exec(body)?.[1] ?? null;
  }

  it('shows every signal as un-pressed before anything has been said', async () => {
    await givenOneCluster({ id: 'cluster-1', summary: 'A story with no opinion attached.' });

    const body = (await page(h, '/topics/topic-1')).body;

    for (const type of ['thumbs_up', 'thumbs_down', 'more_like_this', 'less_like_this']) {
      expect(pressed(body, type)).toBe('false');
    }
    expect(hidePressed(body)).toBe('false');
  });

  for (const type of ['thumbs_up', 'thumbs_down', 'more_like_this', 'less_like_this'] as const) {
    it(`shows ${type} as active on the Cluster it was given for`, async () => {
      await givenOneCluster({ id: 'cluster-1', summary: 'A story the User has an opinion about.' });

      await giveFeedback({ clusterId: 'cluster-1', type });
      const body = (await page(h, '/topics/topic-1')).body;

      expect(pressed(body, type)).toBe('true');
    });
  }

  it('shows the change when a signal is replaced, rather than both buttons lit', async () => {
    await givenOneCluster({ id: 'cluster-1', summary: 'A story the User changed their mind about.' });

    await giveFeedback({ clusterId: 'cluster-1', type: 'thumbs_up' });
    await giveFeedback({ clusterId: 'cluster-1', type: 'thumbs_down' });
    const body = (await page(h, '/topics/topic-1')).body;

    expect(pressed(body, 'thumbs_down')).toBe('true');
    expect(pressed(body, 'thumbs_up')).toBe('false');
  });

  it('marks a Cluster whose signals have all been replaced as saying nothing', async () => {
    await givenOneCluster({ id: 'cluster-1', summary: 'A story the User changed their mind about.' });

    await giveFeedback({ clusterId: 'cluster-1', type: 'more_like_this' });
    await giveFeedback({ clusterId: 'cluster-1', type: 'less_like_this' });
    const body = (await page(h, '/topics/topic-1')).body;

    expect(pressed(body, 'less_like_this')).toBe('true');
    expect(pressed(body, 'more_like_this')).toBe('false');
  });

  it('applies the signal to the page it redirects to, without a second request from the User', async () => {
    await givenOneCluster({ id: 'cluster-1', summary: 'A story the User liked.' });

    const resp = await giveFeedback({ clusterId: 'cluster-1', type: 'thumbs_up' });

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/topics/topic-1');
    expect(pressed((await page(h, '/topics/topic-1')).body, 'thumbs_up')).toBe('true');
  });

  it('records one event when the same button is pressed twice', async () => {
    await givenOneCluster({ id: 'cluster-1', summary: 'A story the User liked twice.' });

    await giveFeedback({ clusterId: 'cluster-1', type: 'thumbs_up' });
    await giveFeedback({ clusterId: 'cluster-1', type: 'thumbs_up' });

    const events = h.driver
      .prepare(`SELECT feedback_type FROM feedback_events WHERE user_id = (SELECT id FROM users LIMIT 1)`)
      .all() as { feedback_type: string }[];
    expect(events).toHaveLength(1);
  });

  it('refuses a hide whose scope is neither of the two, rather than narrowing it', async () => {
    await givenOneCluster({ id: 'cluster-1', summary: 'A story from Reuters.' });

    const resp = await giveFeedback({
      clusterId: 'cluster-1',
      type: 'hide_source',
      sourceId: 'reuters',
      scope: 'everything',
    });

    // Silently storing it as `this_topic` would be a User asking to stop seeing an
    // outlet everywhere and being given one Topic's worth of it instead.
    expect(resp.statusCode).toBe(400);
    expect(resp.body).toContain('this topic or to all your topics');
    expect(h.driver.prepare(`SELECT * FROM feedback_events`).all()).toEqual([]);
  });

  it('refuses a signal type that is not one of the five', async () => {
    await givenOneCluster({ id: 'cluster-1', summary: 'A story.' });

    const resp = await giveFeedback({ clusterId: 'cluster-1', type: 'shrug' });

    expect(resp.statusCode).toBe(400);
    expect(resp.body).toContain('not one of the signals');
    const events = h.driver.prepare(`SELECT * FROM feedback_events`).all();
    expect(events).toEqual([]);
  });

  it('refuses feedback on a Cluster from another Topic', async () => {
    // A second Topic of the same User, with its own Cluster: the route resolves
    // the slug against the signed-in User and then has to check the Cluster is on
    // that Topic, or a User can leave a signal on any Cluster whose id they guess.
    await h.topicRepo.insert(
      makeTopic({ id: 'topic-2', userId: await firstUserId(h) }),
    );
    for (const [position, sourceId] of ['reuters', 'the-guardian'].entries()) {
      await h.topicRepo.insertTopicSource('topic-2', sourceId as string, position);
    }
    const s1 = await givenStory(h, { id: 's1', title: 'Acme Corp unveils Foo' });
    await h.clusterRepo.insert(
      makeCluster({
        id: 'cluster-2' as never,
        topicId: 'topic-2',
        title: 'A story from the other topic.',
        summary: 'Belongs to the other topic.',
        sourceIds: ['reuters'],
      }),
      [s1] as never,
    );

    const resp = await giveFeedback({ clusterId: 'cluster-2', type: 'thumbs_up' });

    expect(resp.statusCode).toBe(400);
    expect(h.driver.prepare(`SELECT * FROM feedback_events`).all()).toEqual([]);
  });

  it('offers the scope a Hide-source will use, and says which is which', async () => {
    await givenOneCluster({ id: 'cluster-1', summary: 'A story from Reuters.' });

    const body = (await page(h, '/topics/topic-1')).body;

    expect(body).toContain('name="scope"');
    expect(body).toContain('value="this_topic"');
    expect(body).toContain('value="global"');
    // Both scopes say in words what they do, so choosing between them does not
    // require knowing that "global" is the wider of the two.
    expect(body).toContain('This topic');
    expect(body).toContain('All your topics');
  });

  it('hides one Source from a Topic without taking the story with it', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Reuters reports Foo' });
    const s2 = await givenStory(h, {
      id: 's2',
      sourceId: 'the-guardian' as SourceId,
      title: 'Guardian reports Foo too',
    });
    await h.clusterRepo.insert(
      makeCluster({
        id: 'cluster-1' as never,
        topicId: 'topic-1',
        title: 'Foo, as reported.',
        summary: 'Two outlets reported the same thing.',
        sourceIds: ['reuters', 'the-guardian'],
      }),
      [s1, s2] as never,
    );

    const resp = await giveFeedback({
      clusterId: 'cluster-1',
      type: 'hide_source',
      sourceId: 'reuters',
      scope: 'this_topic',
    });
    expect(resp.statusCode).toBe(302);

    const body = (await page(h, '/topics/topic-1')).body;
    // The story is still here; the outlet the User asked not to see is not.
    expect(body).toContain('Two outlets reported the same thing.');
    expect(body).not.toContain('Reuters reports Foo');
    expect(body).toContain('Guardian reports Foo too');
  });

  it('keeps a globally hidden Source out of every Topic the User has', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Reuters reports Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId: s1,
      summary: 'A story only Reuters reported.',
      sourceIds: ['reuters'],
    });
    await h.topicRepo.insert(makeTopic({ id: 'topic-2', userId: (await firstUserId(h)) as never }));
    for (const [position, sourceId] of ['reuters', 'the-guardian'].entries()) {
      await h.topicRepo.insertTopicSource('topic-2', sourceId as string, position);
    }
    const s2 = await givenStory(h, { id: 's2', title: 'Reuters reports Foo again' });
    await h.clusterRepo.insert(
      makeCluster({
        id: 'cluster-2' as never,
        topicId: 'topic-2',
        title: 'Foo again.',
        summary: 'The same story on the other topic.',
        sourceIds: ['reuters'],
      }),
      [s2] as never,
    );

    await giveFeedback({
      clusterId: 'cluster-1',
      type: 'hide_source',
      sourceId: 'reuters',
      scope: 'global',
    });

    expect((await page(h, '/topics/topic-1')).body).not.toContain('Reuters reports Foo');
    expect((await page(h, '/topics/topic-2')).body).not.toContain('Reuters reports Foo again');
  });

  it('marks the hide button active once the Source is hidden', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Reuters reports Foo' });
    const s2 = await givenStory(h, {
      id: 's2',
      sourceId: 'the-guardian' as SourceId,
      title: 'Guardian reports Foo too',
    });
    await h.clusterRepo.insert(
      makeCluster({
        id: 'cluster-1' as never,
        topicId: 'topic-1',
        title: 'Foo, as reported.',
        summary: 'Two outlets reported the same thing.',
        sourceIds: ['reuters', 'the-guardian'],
      }),
      [s1, s2] as never,
    );

    expect(hidePressed((await page(h, '/topics/topic-1')).body)).toBe('false');
    await giveFeedback({
      clusterId: 'cluster-1',
      type: 'hide_source',
      sourceId: 'reuters',
      scope: 'this_topic',
    });

    // The fifth signal shows its state the same way the other four do.
    expect(hidePressed((await page(h, '/topics/topic-1')).body)).toBe('true');
  });

  it('shows the scope in force on the next load, so the choice persists', async () => {
    // A Cluster carried by two Sources survives hiding one of them, so its hide
    // control is still on the page afterwards and can say which scope it used.
    const s1 = await givenStory(h, { id: 's1', title: 'Reuters reports Foo' });
    const s2 = await givenStory(h, {
      id: 's2',
      sourceId: 'the-guardian' as SourceId,
      title: 'Guardian reports Foo too',
    });
    await h.clusterRepo.insert(
      makeCluster({
        id: 'cluster-1' as never,
        topicId: 'topic-1',
        title: 'Foo, as reported.',
        summary: 'Two outlets reported the same thing.',
        sourceIds: ['reuters', 'the-guardian'],
      }),
      [s1, s2] as never,
    );

    await giveFeedback({
      clusterId: 'cluster-1',
      type: 'hide_source',
      sourceId: 'reuters',
      scope: 'global',
    });
    const body = (await page(h, '/topics/topic-1')).body;

    expect(body).toContain('Reuters: hidden on all your topics');
    // And the scope that is in force is the one the control would submit again,
    // so a second load cannot quietly narrow the ask.
    expect(body).toMatch(/name="scope"[\s\S]*?value="global" selected/);
  });

  it('names the hidden Source when it leaves the topic with nothing to show', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Reuters reports Foo' });
    await givenCluster(h, {
      id: 'cluster-1',
      storyId: s1,
      summary: 'A story only Reuters reported.',
      sourceIds: ['reuters'],
    });

    await giveFeedback({
      clusterId: 'cluster-1',
      type: 'hide_source',
      sourceId: 'reuters',
      scope: 'this_topic',
    });
    const body = (await page(h, '/topics/topic-1')).body;

    // Not "no stories yet", which would tell the User their ingest is broken when
    // it is working exactly as asked, and not a "Show all" link, which could not
    // bring back anything they had hidden.
    expect(body).toContain('because you hid Reuters');
    expect(body).not.toContain('No stories yet for this topic');
    expect(body).not.toContain('Show all');
  });

  it('still shows a Cluster carried by another Source when one of them is hidden', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Reuters reports Foo' });
    const s2 = await givenStory(h, {
      id: 's2',
      sourceId: 'the-guardian' as SourceId,
      title: 'Guardian reports Foo too',
    });
    await h.clusterRepo.insert(
      makeCluster({
        id: 'cluster-1' as never,
        topicId: 'topic-1',
        title: 'Foo, as reported.',
        summary: 'Two outlets reported the same thing.',
        sourceIds: ['reuters', 'the-guardian'],
      }),
      [s1, s2] as never,
    );

    await giveFeedback({
      clusterId: 'cluster-1',
      type: 'hide_source',
      sourceId: 'reuters',
      scope: 'this_topic',
    });
    const body = (await page(h, '/topics/topic-1')).body;

    expect(body).toContain('Two outlets reported the same thing.');
    expect(body).not.toContain('because you hid');
  });

  it('ranks a Cluster the User liked above a newer one they said nothing about', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Older but liked' });
    const s2 = await givenStory(h, { id: 's2', title: 'Newer and unremarked on' });
    await givenCluster(h, { id: 'cluster-liked', storyId: s1, summary: 'The liked one.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-plain', storyId: s2, summary: 'The plain one.', sourceIds: ['reuters'] });
    await h.driver
      .prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime() - 86_400_000, 'cluster-liked');
    await h.driver
      .prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime(), 'cluster-plain');

    const before = (await page(h, '/topics/topic-1')).body;
    expect(before.indexOf('The plain one.')).toBeLessThan(before.indexOf('The liked one.'));

    await giveFeedback({ clusterId: 'cluster-liked', type: 'thumbs_up' });
    const after = (await page(h, '/topics/topic-1')).body;
    expect(after.indexOf('The liked one.')).toBeLessThan(after.indexOf('The plain one.'));
  });

  it('sinks a Cluster the User turned down below one they said nothing about', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Newest but disliked' });
    const s2 = await givenStory(h, { id: 's2', title: 'Older and unremarked on' });
    await givenCluster(h, { id: 'cluster-disliked', storyId: s1, summary: 'The disliked one.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-plain', storyId: s2, summary: 'The plain one.', sourceIds: ['reuters'] });
    await h.driver
      .prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime(), 'cluster-disliked');
    await h.driver
      .prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime() - 86_400_000, 'cluster-plain');

    await giveFeedback({ clusterId: 'cluster-disliked', type: 'less_like_this' });
    const body = (await page(h, '/topics/topic-1')).body;

    expect(body.indexOf('The plain one.')).toBeLessThan(body.indexOf('The disliked one.'));
  });

  it('lifts a Cluster built from an Article the User liked on another Cluster', async () => {
    // Two Clusters over the same Article: the propagation ADR 0004 describes.
    const s1 = await givenStory(h, { id: 's1', title: 'Shared article' });
    await givenCluster(h, { id: 'cluster-1', storyId: s1, summary: 'The one that was liked.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-2', storyId: s1, summary: 'The one built from the same Article.', sourceIds: ['reuters'] });
    await h.driver.prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`).run(NOW.getTime() - 86_400_000, 'cluster-1');
    await h.driver.prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`).run(NOW.getTime(), 'cluster-2');

    await giveFeedback({ clusterId: 'cluster-1', type: 'more_like_this' });
    const body = (await page(h, '/topics/topic-1')).body;

    // The signal is on Cluster 1's own Article, and Cluster 2 carries that same
    // Article — which is the whole of what makes a signal reach further than the
    // Cluster it was given on.
    expect(body.indexOf('The one built from the same Article.')).toBeLessThan(
      body.indexOf('The one that was liked.'),
    );
  });

  it('leaves the order alone for a User who has given no signals', async () => {
    const s1 = await givenStory(h, { id: 's1', title: 'Older story' });
    const s2 = await givenStory(h, { id: 's2', title: 'Newer story' });
    await givenCluster(h, { id: 'cluster-old', storyId: s1, summary: 'The older one.', sourceIds: ['reuters'] });
    await givenCluster(h, { id: 'cluster-new', storyId: s2, summary: 'The newer one.', sourceIds: ['reuters'] });
    await h.driver
      .prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime() - 86_400_000, 'cluster-old');
    await h.driver
      .prepare(`UPDATE clusters SET last_seen_at = ? WHERE id = ?`)
      .run(NOW.getTime(), 'cluster-new');

    const body = (await page(h, '/topics/topic-1')).body;

    expect(body.indexOf('The newer one.')).toBeLessThan(body.indexOf('The older one.'));
  });

  it('redirects to /signup when not authenticated', async () => {
    const resp = await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/feedback',
      payload: { clusterId: 'cluster-1', type: 'thumbs_up' },
    });

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/signup');
  });
});

/** The signed-in User's id, for a fixture that needs a second Topic. */
async function firstUserId(h: Harness): Promise<string> {
  return (h.driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
}

describe('HTTP: /topics/:slug/cluster-window', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('stores the window the User asked for', async () => {
    const resp = await submitForm(
      h.app,
      h.cookie,
      '/topics/topic-1/cluster-window',
      { windowDays: '3' },
    );

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

    const resp = await submitForm(
      h.app,
      h.cookie,
      '/topics/topic-1/cluster-window',
      { windowDays: '2' },
    );
    expect(resp.statusCode).toBe(302);

    // The stored window is what the page reports, and the Clusters the pipeline
    // would form from it are a subset of what it was forming.
    const shown = await page(h, '/topics/topic-1');
    expect(shown.body).toMatch(/name="windowDays"[^>]*value="2"/);
  });

  it('clamps a window that would cluster nothing, rather than accepting it', async () => {
    await submitForm(h.app, h.cookie, '/topics/topic-1/cluster-window', { windowDays: '0' });

    const topic = await h.topicRepo.getById('topic-1' as TopicId);
    expect(topic?.clusterWindowDays).toBe(1);
  });

  it('falls back to the default when the number is not a number', async () => {
    await h.topicRepo.setClusterWindowDays('topic-1' as TopicId, 4);

    const resp = await submitForm(
      h.app,
      h.cookie,
      '/topics/topic-1/cluster-window',
      { windowDays: 'soon' },
    );

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
