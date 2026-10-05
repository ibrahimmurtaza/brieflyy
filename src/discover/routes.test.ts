import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { SqliteDriver } from '../db/client.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';

const NOW = new Date('2026-01-01T00:00:00Z');

/**
 * The transport's logger. Every other page suite writes `() => {}` inline and
 * none of them needs this; hoisting it is here because the compiler mis-scans an
 * empty block-bodied arrow used as a call argument in this position, and the
 * resulting error points at the arrow rather than at the construct.
 */
const QUIET = (): void => {};

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly driver: SqliteDriver;
}

/**
 * A signed-in User, by the only route that exists for one.
 *
 * The same walk-in every page suite in this repository takes, because a test that
 * writes a session row behind the application's back has not tested the way a
 * User arrives.
 */
async function signedIn(): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: QUIET });
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
  const raw = verify.headers['set-cookie'];
  const sessionCookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  // The session and the request token: a browser is handed a page before it
  // can submit a form, and every write checks the pair (ADR-0021).
  const { cookies: cookie } = await signedInCookies(app, sessionCookie);
  return { app, cookie, driver };
}

function hrefs(html: string): readonly string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

function header(html: string): string {
  return html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
}

/** Inside the seven-day window the fixed clock of 2026-01-01 puts around now. */
const IN_WINDOW = new Date('2025-12-30T09:00:00Z');

function insertArticleRow(
  driver: SqliteDriver,
  input: {
    readonly id: string;
    readonly sourceId: string;
    readonly publishedAt: Date;
    readonly entityIds: readonly string[];
  },
): void {
  // Raw rows rather than the repositories: this suite is about what the page says
  // once there is a corpus behind it, and the repositories' job is to keep Story
  // signatures and Story assignments consistent, which is not what is under test.
  driver
    .prepare(
      `INSERT INTO articles
         (id, source_id, external_id, url, title, body, published_at, ingested_at, signature)
       VALUES (?, ?, ?, ?, ?, '', ?, ?, '{}')`,
    )
    .run(
      input.id,
      input.sourceId,
      input.id,
      `https://example.com/${input.id}`,
      input.id,
      input.publishedAt.getTime(),
      input.publishedAt.getTime(),
    );
  for (const entityId of input.entityIds) {
    driver
      .prepare(
        `INSERT OR IGNORE INTO entities (id, canonical_name, canonical_key, kind)
         VALUES (?, ?, ?, 'org')`,
      )
      .run(entityId, entityId, entityId.toLowerCase());
    driver
      .prepare(`INSERT OR IGNORE INTO article_entities (article_id, entity_id) VALUES (?, ?)`)
      .run(input.id, entityId);
  }
}

/** One Article inside the window, which is what most of this suite writes. */
function addArticle(
  driver: SqliteDriver,
  input: {
    readonly id: string;
    readonly sourceId: string;
    readonly entityIds: readonly string[];
  },
): void {
  insertArticleRow(driver, { ...input, publishedAt: IN_WINDOW });
}

describe('HTTP: /discover', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await signedIn();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  it('sends an anonymous visitor to sign in', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/discover' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/signup');
  });

  it('is in the shell, so it can be reached from any page', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: harness.cookie },
    });

    // "Reachable from the app shell" is the acceptance criterion; the shell is
    // what every signed-in page carries, so the link on another page is the
    // assertion that needs no second surface to keep in step.
    expect(hrefs(header(res.body))).toContain('/discover');
  });

  it('renders the DiscoverTab itself', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<h1>Discover</h1>');
    expect(res.body).toContain('<main id="main"');
  });

  it('sends a User with no Topics to the first-run flow', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    // The Directory is fully listed ? there is nothing wrong with it ? but a User
    // with nothing to compare it against is pointed at the screen that fixes that.
    expect(res.body).toContain("You haven't picked any topics yet");
    expect(hrefs(res.body)).toContain('/onboarding/pick-topics');
  });

  it('offers an Add control for a Directory entry, and the control clones that entry', async () => {
    const page = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });
    expect(page.body).toMatch(/name="templateId" value="markets"/);

    const added = await submitForm(
      harness.app,
      harness.cookie,
      '/discover/add',
      'templateId=markets',
    );

    // One entry, not three. The onboarding screen's exactly-three rule is about
    // its checkbox form, and applying it to a single card refused the one thing
    // this control exists to do.
    expect(added.statusCode).toBe(302);
    expect(added.headers.location).toBe('/discover');

    const topics = await harness.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: harness.cookie },
    });
    expect(topics.body).toContain('Markets');
  });

  it('leaves the entry it just cloned out of the Directory', async () => {
    await submitForm(harness.app, harness.cookie, '/discover/add', 'templateId=markets');

    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    // The defect: the Directory filtered entries against the User's Topic ids, two
    // unrelated kinds of identifier, so it excluded nothing and the entry they had
    // just added was still on offer.
    expect(res.body).not.toMatch(/name="templateId" value="markets"/);
  });

  it('says the Directory is empty once a User holds every entry', async () => {
    for (const templateId of ['markets', 'climate', 'ai-and-ml']) {
      await submitForm(
        harness.app,
        harness.cookie,
        '/discover/add',
        `templateId=${templateId}`,
      );
    }

    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    expect(res.body).not.toMatch(/name="templateId"/);
    expect(hrefs(res.body)).toContain('/pick-topics');
  });
});

describe('HTTP: /discover at the free-tier cap', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await signedIn();
    for (const templateId of ['markets', 'climate', 'ai-and-ml']) {
      await submitForm(
        harness.app,
        harness.cookie,
        '/discover/add',
        `templateId=${templateId}`,
      );
    }
  });
  afterEach(async () => {
    await harness.app.close();
  });

  it('shows a paywall rather than a control that cannot work', async () => {
    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    expect(res.body).toContain('free-topic limit');
    expect(hrefs(res.body)).toContain('/upgrade');
    expect(res.body).not.toMatch(/action="\/discover\/add"/);
  });

  it('refuses a clone posted past the cap, and keeps the User on the page', async () => {
    const res = await submitForm(
      harness.app,
      harness.cookie,
      '/discover/add',
      'templateId=startups',
    );

    // 402 rather than a redirect: this is a payment wall, not a mistake, and
    // redirecting would hide it behind a page that looks the same as success.
    expect(res.statusCode).toBe(402);
    expect(res.body).toContain('free-topic limit');

    const topics = await harness.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: harness.cookie },
    });
    expect(topics.body).not.toContain('Startups');
  });
});

describe('HTTP: what the DiscoverTab is measuring', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await signedIn();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  it('trends on what the Sources really published in the window it names', async () => {
    // The defect: the trending list arrived as `[{ templateId, lift }]` and was
    // sorted, so the ranking was whatever the caller said. These rows are the only
    // thing the page is allowed to rank on now.
    for (let i = 0; i < 5; i++) {
      addArticle(harness.driver, {
        id: `bus-${i}`,
        sourceId: 'cnbc-finance',
        entityIds: [],
      });
    }
    addArticle(harness.driver, {
      id: 'hn-1',
      sourceId: 'hacker-news',
      entityIds: [],
    });

    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    expect(res.body).toContain('Trending in the last 7 days');
    expect(res.body).toMatch(/last 7 days/);
    // `markets` follows cnbc-finance; `developer-culture` follows hacker-news.
    expect(res.body).toMatch(/Markets[\s\S]{0,400}5 articles/);
    expect(res.body).toMatch(/Developer culture[\s\S]{0,400}1 article/);
  });

  it('ignores an Article published before the window', async () => {
    insertArticleRow(harness.driver, {
      id: 'ancient',
      sourceId: 'cnbc-finance',
      publishedAt: new Date('2024-01-01T00:00:00Z'),
      entityIds: [],
    });

    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    expect(res.body).not.toContain('Trending in the last 7 days');
  });

  it('ignores an Article dated after the window closes', async () => {
    // A feed that mislabels an archive, or a clock that was wrong when the row was
    // written, would otherwise leave that Article counting towards "this week" for
    // as long as the database keeps it. The window has an end.
    insertArticleRow(harness.driver, {
      id: 'from-the-future',
      sourceId: 'cnbc-finance',
      publishedAt: new Date('2027-01-01T00:00:00Z'),
      entityIds: [],
    });

    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    expect(res.body).not.toContain('Trending in the last 7 days');
  });

  it('recommends an entry on the Entities it shares, with no Source shared at all', async () => {
    // The defect: only Source overlap was scored, so an entry about exactly the
    // companies the User already follows scored zero if none of their outlets
    // covered it. `markets` follows CNBC's finance and business feeds;
    // `ai-and-ml` follows Ars Technica, The Verge, CNBC Technology and Quanta, and
    // shares not one of them with the User. What it does share is the company both
    // write about, which is the half of the overlap the glossary names.
    addArticle(harness.driver, {
      id: 'mine-1',
      sourceId: 'cnbc-finance',
      entityIds: ['ent-openai'],
    });
    addArticle(harness.driver, {
      id: 'theirs-1',
      sourceId: 'arstechnica',
      entityIds: ['ent-openai'],
    });

    await submitForm(harness.app, harness.cookie, '/discover/add', 'templateId=markets');

    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    const recommended = res.body.match(
      /<li class="cluster">[\s\S]*?<\/li>/g,
    )?.join('\n') ?? '';
    expect(res.body).toContain("Topics like yours");
    expect(recommended).toContain('AI &amp; machine learning');
    // The reason names the only thing shared. A source here would mean the
    // assertion had passed for the wrong reason.
    expect(recommended).toContain(
      'Recommended because it shares 1 entity with your topics.',
    );
  });

  it('offers no recommendation at all to a User with nothing to compare', async () => {
    addArticle(harness.driver, {
      id: 'bus-1',
      sourceId: 'cnbc-finance',
      entityIds: ['ent-openai'],
    });

    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });

    // With no Topics there is no User in the ranking, and a list of the whole
    // Directory under the heading "like yours" would be a lie about all of it.
    expect(res.body).not.toContain("Topics like yours");
  });
});

describe('HTTP: a Directory of two hundred entries', () => {
  let harness: Harness;

  beforeEach(async () => {
    harness = await signedIn();
    // The size the acceptance criterion names, added on top of the curated set so
    // the count is beyond two hundred rather than exactly it.
    const insertTemplate = harness.driver.prepare(
      `INSERT INTO topic_templates (id, slug, title, blurb, category)
       VALUES (?, ?, ?, ?, 'technology')`,
    );
    const insertSource = harness.driver.prepare(
      `INSERT INTO topic_template_sources (topic_template_id, source_id, position)
       VALUES (?, 'the-verge', 0)`,
    );
    harness.driver.transaction(() => {
      for (let i = 0; i < 200; i++) {
        const id = `bulk-${i}`;
        insertTemplate.run(id, id, `Bulk ${i}`, 'A long enough blurb to render.');
        insertSource.run(id);
      }
    })();

    // And a corpus for the two entity joins to actually read. An empty `articles`
    // table makes both of them return instantly, which is the one case where a
    // per-entry lookup would also have been fast — so a load test that left it
    // empty would be asserting the case the design does not worry about.
    for (let i = 0; i < 400; i++) {
      insertArticleRow(harness.driver, {
        id: `bulk-article-${i}`,
        sourceId: i % 2 === 0 ? 'the-verge' : 'arstechnica',
        publishedAt: IN_WINDOW,
        entityIds: [`ent-${i % 40}`],
      });
    }
  });

  afterEach(async () => {
    await harness.app.close();
  });

  it('renders in well under a second', async () => {
    const started = performance.now();
    const res = await harness.app.inject({
      method: 'GET',
      url: '/discover',
      headers: { cookie: harness.cookie },
    });
    const elapsed = performance.now() - started;

    expect(res.statusCode).toBe(200);
    const rendered = (res.body.match(/class="card card--entry"/g) ?? []).length;
    expect(
      rendered,
      'the Directory is not the size the criterion names',
    ).toBeGreaterThanOrEqual(200);
    expect(elapsed, `/discover took ${Math.round(elapsed)}ms`).toBeLessThan(1000);
  });
});

describe('HTTP: a refused submission', () => {
  let harness: Harness;
  beforeEach(async () => {
    harness = await signedIn();
  });
  afterEach(async () => {
    await harness.app.close();
  });

  it('answers a submission naming no entry in words, on the page it came from', async () => {
    const res = await submitForm(harness.app, harness.cookie, '/discover/add', '');

    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('<h1>Discover</h1>');
    expect(res.body).toMatch(/Pick at least one topic/);
  });

  it('answers a submission naming an entry that is not in the Directory', async () => {
    const res = await submitForm(
      harness.app,
      harness.cookie,
      '/discover/add',
      'templateId=not-a-real-template',
    );

    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(/not in the Directory/);
  });
});