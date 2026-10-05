import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import type { Db, SqliteDriver } from '../db/client.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { makeArticle, makeCluster } from '../testing/fixtures.js';

const NOW = new Date('2026-03-01T00:00:00Z');

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly db: Db;
  readonly driver: SqliteDriver;
  readonly userId: string;
  readonly topicId: string;
  readonly topicSlug: string;
  readonly sourceId: string;
}

/**
 * A signed-in, onboarded User with one Cluster in their Archive.
 *
 * Onboarded because the Archive hangs off Topics, and a User with none has an empty
 * one by construction — which is a different test.
 */
async function signInWithArchive(email = 'iris@example.com'): Promise<Harness> {
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
  const requested = await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email },
  });
  const token = extractMagicLinkToken(transport.snapshot()[0]!.text);
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const raw = verify.headers['set-cookie'];
  const sessionCookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  // A browser is handed a page before it can submit a form, and the token on
  // that page is what every write route now checks (ADR-0021).
  const { cookies: cookie } = await signedInCookies(app, sessionCookie);

  const templates = (
    (await app.inject({ method: 'GET', url: '/api/onboarding/templates' })).json() as {
      templates: { id: string }[];
    }
  ).templates;
  await submitForm(app, cookie, '/onboarding/pick-topics', {
    templateIds: templates.slice(0, 3).map((t) => t.id),
  });
  await submitForm(app, cookie, '/onboarding/delivery-time', {
    hour: '8',
    minute: '0',
    timezone: 'UTC',
  });

  const userId = (driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
  const topic = driver
    .prepare(`SELECT id, slug FROM topics WHERE user_id = ? LIMIT 1`)
    .get(userId) as { id: string; slug: string };
  const sourceId = (
    driver
      .prepare(`SELECT source_id FROM topic_sources WHERE topic_id = ? LIMIT 1`)
      .get(topic.id) as { source_id: string }
  ).source_id;

  return { app, cookie, db, driver, userId, topicId: topic.id, topicSlug: topic.slug, sourceId };
}

describe('HTTP: the search bar in the shell', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await signInWithArchive();
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const get = (url: string) =>
    harness.app.inject({ method: 'GET', url, headers: { cookie: harness.cookie } });

  for (const url of ['/topics', '/discover', '/trends']) {
    it(`sits on ${url} and leads to the results`, async () => {
      const res = await get(url);
      const head = res.body.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';

      // A search box on every page, because the Archive is the one thing a User
      // reaches for from anywhere and a control that only exists on its own results
      // page is a control they have to already be on.
      expect(head, `${url} has no search form`).toContain('action="/archive/search"');
      expect(head, `${url} has no search input`).toContain('name="q"');
      // And it goes through a GET, so a search is a link a User can share or come
      // back to, and the page it produces needs no JavaScript to work.
      expect(head).toContain('method="GET"');
    });
  }

  it('is not offered to somebody who cannot use it', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/signup' });

    expect(res.body).not.toContain('action="/archive/search"');
  });
});

describe('HTTP: /archive/search', () => {
  let harness: Harness;
  let clusters: DrizzleClusterRepo;

  beforeEach(async () => {
    harness = await signInWithArchive();
    clusters = new DrizzleClusterRepo(harness.db);
  });

  afterEach(async () => {
    await harness.app.close();
  });

  const get = (url: string) =>
    harness.app.inject({ method: 'GET', url, headers: { cookie: harness.cookie } });

  it('redirects to /signup when not authenticated', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/archive/search' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/signup');
  });

  it('offers a form to search with and one to narrow by', async () => {
    const res = await get('/archive/search');

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('<h1>Archive search</h1>');
    expect(res.body).toContain('action="/archive/search"');
    expect(res.body).toContain('name="q"');
    for (const filter of ['from', 'to', 'source', 'entity', 'topic']) {
      expect(res.body, `no ${filter} filter`).toContain(`name="${filter}"`);
    }
  });

  it('says so when a User has nothing in their Archive', async () => {
    const res = await get('/archive/search');

    // Not an error and not a blank page: an empty Archive is a state, and it is the
    // state every User is in on the day they sign up.
    expect(res.body).toContain('Nothing in your archive yet');
  });

  it('lists what a search found and links each result to where it can be read', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: harness.topicId,
        title: 'A regulator opens an inquiry',
        summary: 'The order names two companies.',
        createdAt: new Date('2026-02-20T00:00:00Z'),
      }),
    );

    const res = await get('/archive/search?q=regulator');

    expect(res.body).toContain('A regulator opens an inquiry');
    expect(res.body).toContain('The order names two companies.');
    // A result nobody can open is a list of strings. The anchor is the Cluster's own,
    // built by the same helper the LivingBrief uses so the two cannot drift apart.
    expect(res.body).toContain(`href="/topics/${harness.topicSlug}#cluster-cluster-1"`);
    // And the Topic it came from, because "what was this about" is half the answer.
    expect(res.body).toContain('Cluster');
  });

  it('dates every result, in the zone the User keeps their hours in', async () => {
    // Set to a zone where UTC would give a visibly wrong reading, so a page that
    // formatted in UTC cannot pass by accident: 23:30 UTC is the next day in Tokyo.
    harness.driver
      .prepare(
        `INSERT INTO delivery_settings (user_id, hour, minute, timezone, updated_at)
         VALUES (?, 8, 0, 'Asia/Tokyo', 1)
         ON CONFLICT(user_id) DO UPDATE SET timezone = 'Asia/Tokyo'`,
      )
      .run(harness.userId);
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: harness.topicId,
        title: 'A regulator opens an inquiry',
        createdAt: new Date('2026-02-20T23:30:00Z'),
      }),
    );

    const res = await get('/archive/search?q=regulator');

    // The Archive is ordered newest-first and has no date filter applied, so the one
    // result is this one. A result nobody can place in time is half a result — and
    // note the day is the 21st: 23:30 UTC is already tomorrow in Tokyo, so a page
    // that formatted in UTC would print "Thu, 20 Feb at 23:30" and fail here.
    expect(res.body).toContain('Sat, 21 Feb at 08:30');
    // And the frame it is in, because a clock reading on its own is a claim without
    // one — the same spelling and the same labelled zone as every other page.
    expect(res.body).toContain('Asia/Tokyo');
  });

  it('says when a search found nothing', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: harness.topicId,
        title: 'A regulator opens an inquiry',
        createdAt: new Date('2026-02-20T00:00:00Z'),
      }),
    );

    const res = await get('/archive/search?q=helion');

    expect(res.body).toContain('Nothing matched');
    // And not the empty-state wording, which would claim there is nothing at all
    // when there is something and the words were wrong.
    expect(res.body).not.toContain('Nothing in your archive yet');
  });

  it('keeps another User out of another User’s Archive', async () => {
    harness.driver.prepare(`INSERT INTO users (id) VALUES ('user-other')`).run();
    harness.driver
      .prepare(
        `INSERT INTO topics (id, user_id, slug, title, blurb, category, origin_kind, created_at)
         VALUES ('topic-other', 'user-other', 'theirs', 'Theirs', '', 'news', 'freeform', 1)`,
      )
      .run();
    await clusters.insert(
      makeCluster({
        id: 'cluster-theirs',
        topicId: 'topic-other',
        title: 'A shared-sounding story',
        createdAt: new Date('2026-02-20T00:00:00Z'),
      }),
    );

    // The Archive really does hold it — otherwise this would pass for the wrong
    // reason, which is the failure mode a negative assertion is most prone to.
    const indexed = harness.driver
      .prepare(`SELECT COUNT(*) AS n FROM archive_items WHERE item_id = 'cluster-theirs'`)
      .get() as { n: number };
    expect(indexed.n).toBe(1);

    const res = await get('/archive/search?q=shared');

    expect(res.body).toContain('Nothing matched');
  });

  it('offers the Sources, Topics and Entities this Archive actually holds', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: harness.topicId,
        title: 'A regulator opens an inquiry',
        sourceIds: [harness.sourceId],
        createdAt: new Date('2026-02-20T00:00:00Z'),
      }),
    );

    const res = await get(`/archive/search?source=${harness.sourceId}`);
    const chosen = res.body.match(/<select[^>]*name="source"[\s\S]*?<\/select>/)?.[0] ?? '';

    // Only what the Archive holds, and the choice kept, or narrowing twice means
    // choosing it twice.
    expect(chosen).toContain(`value="${harness.sourceId}"`);
    expect(chosen).toMatch(/value="cnbc"[^>]*selected/);
  });

  it('hides from a free User what their tier does not reach, and says why', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-ancient',
        topicId: harness.topicId,
        title: 'An ancient story about turbines',
        createdAt: new Date('2024-01-01T00:00:00Z'),
      }),
    );

    const free = await get('/archive/search?q=turbines');
    expect(free.body).toContain('Nothing matched');
    // The boundary is the repository's, but a User who searched for something and
    // got nothing is owed the reason: thirty days is a rule somebody wrote.
    expect(free.body).toContain('last 30 days');

    harness.driver.prepare(`UPDATE users SET tier = 'paid' WHERE id = ?`).run(harness.userId);
    const paid = await get('/archive/search?q=turbines');

    expect(paid.body).toContain('An ancient story about turbines');
    expect(paid.body).not.toContain('last 30 days');
  });

  it('shows a free User a BriefSnapshot however old it is', async () => {
    harness.driver
      .prepare(
        `INSERT INTO brief_plans (id, topic_id, user_id, created_at, cluster_ids)
         VALUES ('plan-1', ?, ?, 1, '')`,
      )
      .run(harness.topicId, harness.userId);
    harness.driver
      .prepare(
        `INSERT INTO brief_snapshots
           (id, brief_plan_id, user_id, topic_id, created_at, html, text, unsubscribe_token, global_unsubscribe_token)
         VALUES ('snap-1', 'plan-1', ?, ?, ?, '<p>sent</p>', 'A brief about turbines.', 'u', 'g')`,
      )
      .run(harness.userId, harness.topicId, Date.parse('2020-01-01T00:00:00Z'));

    const res = await get('/archive/search?q=turbines');

    expect(res.body).toContain('A brief about turbines.');
    // A brief is read at the address it was served from, which is scoped to the
    // User it was sent to.
    expect(res.body).toContain('href="/briefs/snap-1"');
  });

  it('narrows by a date range, and shows the range back in the form', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-february',
        topicId: harness.topicId,
        title: 'A February story',
        createdAt: new Date('2026-02-01T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-january',
        topicId: harness.topicId,
        title: 'A January story',
        createdAt: new Date('2026-01-01T00:00:00Z'),
      }),
    );

    const res = await get('/archive/search?from=2026-02-01&to=2026-02-28');

    expect(res.body).toContain('A February story');
    expect(res.body).not.toContain('A January story');
    // The form keeps what was asked for, or narrowing twice would mean typing it all
    // again.
    expect(res.body).toContain('value="2026-02-01"');
    expect(res.body).toContain('value="2026-02-28"');
  });

  it('narrows by Source', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: harness.topicId,
        title: 'From the outlet they follow',
        sourceIds: [harness.sourceId],
        createdAt: new Date('2026-02-20T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-2',
        topicId: harness.topicId,
        title: 'From somewhere else',
        createdAt: new Date('2026-02-21T00:00:00Z'),
      }),
    );

    const res = await get(`/archive/search?source=${harness.sourceId}`);

    expect(res.body).toContain('From the outlet they follow');
    expect(res.body).not.toContain('From somewhere else');
  });

  it('narrows by Entity', async () => {
    const acme = await new DrizzleEntityRepo(harness.db).upsertByKey({
      id: 'ent-acme',
      entity: { name: 'Acme', key: 'acme', kind: 'org' },
    });
    await new DrizzleArticleRepo(harness.db).insert({
      article: makeArticle({
        id: 'a-1',
        sourceId: harness.sourceId,
        title: 'Acme ships',
        body: 'A thing happened.',
        publishedAt: new Date('2026-02-18T00:00:00Z'),
      }),
      entityIds: [acme.id],
    });
    await new DrizzleArticleRepo(harness.db).insert({
      article: makeArticle({
        id: 'a-2',
        sourceId: harness.sourceId,
        title: 'Somebody else ships',
        body: 'Another thing happened.',
        publishedAt: new Date('2026-02-17T00:00:00Z'),
      }),
      entityIds: [],
    });

    const res = await get(`/archive/search?entity=${acme.id}`);

    expect(res.body).toContain('Acme ships');
    expect(res.body).not.toContain('Somebody else ships');
  });

  it('narrows by Topic', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: harness.topicId,
        title: 'In the first topic',
        createdAt: new Date('2026-02-20T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'cluster-2',
        topicId: harness.topicId,
        title: 'In the second topic',
        createdAt: new Date('2026-02-21T00:00:00Z'),
      }),
    );

    const res = await get(`/archive/search?topic=${harness.topicId}`);

    expect(res.body).toContain('In the first topic');
    expect(res.body).toContain('In the second topic');
  });

  it('ignores a date it cannot read rather than refusing to render', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: harness.topicId,
        title: 'A readable story',
        createdAt: new Date('2026-02-20T00:00:00Z'),
      }),
    );

    const res = await get('/archive/search?from=yesterday&q=readable');

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('A readable story');
  });

  it('offers the next page of results rather than stopping at the first', async () => {
    // More rows than one page holds, so the "Older" link has somewhere to go. A
    // limit with no way past it tells a User with a full Archive that they have a
    // full Archive and gives them no way to read it.
    for (let i = 0; i < 30; i += 1) {
      await clusters.insert(
        makeCluster({
          id: `cluster-${i}`,
          topicId: harness.topicId,
          title: `Story ${i}`,
          summary: 'Something happened.',
          createdAt: new Date(Date.parse('2026-02-01T00:00:00Z') + i * 60_000),
        }),
      );
    }

    const first = await get('/archive/search');
    expect(first.body).toContain('Story 29');
    expect(first.body).not.toContain('Story 0');
    expect(first.body).toContain('Older');

    const second = await get('/archive/search?offset=25');
    expect(second.body).toContain('Story 4');
    expect(second.body).toContain('Newer');

    // And the page keeps every filter the first page had, or narrowing again would
    // mean narrowing from scratch.
    const narrow = await get('/archive/search?from=2026-02-01&offset=25');
    expect(narrow.body).toContain('href="/archive/search?from=2026-02-01"');
  });

  it('says when it searched only some of the words it was given', async () => {
    const long = Array.from({ length: 12 }, (_, i) => `w${i}`).join(' ');
    const res = await get(`/archive/search?q=${encodeURIComponent(long)}`);

    // Silently dropping the tail would make a User's results depend on which words
    // happened to fit, with nothing on the page to say so.
    expect(res.body).toContain('Searched the first 8 words');
  });

  it('names the outlet a result came from', async () => {
    await clusters.insert(
      makeCluster({
        id: 'cluster-1',
        topicId: harness.topicId,
        title: 'From both outlets',
        sourceIds: [harness.sourceId, 'the-guardian'],
        createdAt: new Date('2026-02-20T00:00:00Z'),
      }),
    );

    const res = await get('/archive/search');

    // "Where this came from" is half of what makes a result a result, and it costs
    // nothing: the filter options already name every Source this Archive holds.
    const kinds = res.body.match(/<p class="results__kind">[^<]*<\/p>/g) ?? [];
    expect(kinds).toHaveLength(1);
    expect(kinds[0]).toContain('CNBC');
    expect(kinds[0]).toContain('The Guardian');
  });

  it('rounds a hand-typed offset to a whole page rather than scanning for it', async () => {
    for (let i = 0; i < 30; i += 1) {
      await clusters.insert(
        makeCluster({
          id: `cluster-${i}`,
          topicId: harness.topicId,
          title: `Story ${i}`,
          createdAt: new Date(Date.parse('2026-02-01T00:00:00Z') + i * 60_000),
        }),
      );
    }

    // A number that is not a whole page is the page before the one it names, so the
    // paging links a User follows and a number a User typed cannot disagree about
    // where they are.
    const partial = await get('/archive/search?offset=27');
    expect(partial.body.replace('&ndash;', '–')).toContain('26–30 of 30');
    expect(partial.body).toContain('Newer');

    // And one past the end is an empty page that says so, rather than a walk
    // through everything to find that out — and rather than claiming the Archive is
    // empty when it holds thirty items.
    const absurd = await get('/archive/search?offset=999999999');
    expect(absurd.statusCode).toBe(200);
    expect(absurd.body).toContain('That is the end of your archive');
    expect(absurd.body).toContain('Back to the newest');
    expect(absurd.body).not.toContain('Nothing in your archive yet');
  });
});