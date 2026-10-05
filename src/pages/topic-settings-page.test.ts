import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import { countRows } from '../testing/db.js';
import { makeTopic } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import type { TopicId } from '../domain/types.js';

const NOW = new Date('2026-09-02T12:00:00Z');

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly topicRepo: DrizzleTopicRepo;
  readonly sourceRepo: DrizzleSourceRepo;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
}

/** A signed-in User holding one Topic, with three Sources in the registry. */
async function signInWithTopic(): Promise<Harness> {
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
  // The session and the request token: a browser is handed a page before it can
  // submit a form, and all six of these forms check the pair (ADR-0021).
  const { cookies } = await signedInCookies(app, sessionCookie);

  const topicRepo = new DrizzleTopicRepo(db);
  const sourceRepo = new DrizzleSourceRepo(db);
  const userId = (driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
  await topicRepo.insert(makeTopic({ id: 'topic-1', userId, title: 'World news' }));
  for (const [id, name] of [
    ['wire-reuters', 'Reuters'],
    ['wire-ap', 'Associated Press'],
    ['wire-ft', 'Financial Times'],
  ] as const) {
    await sourceRepo.insert({
      id,
      slug: id,
      name,
      homepageUrl: `https://${id}.example.com`,
      feedUrl: null,
      lastPolledAt: null,
      lastSuccessAt: null,
    });
  }
  await topicRepo.addSource('topic-1', 'wire-reuters');
  await topicRepo.addSource('topic-1', 'wire-ft');

  return { app, cookie: cookies, topicRepo, sourceRepo, driver };
}

function page(h: Harness, url: string) {
  return h.app.inject({ method: 'GET', url, headers: { cookie: h.cookie } });
}

function post(h: Harness, url: string, payload: Record<string, string>) {
  return submitForm(h.app, h.cookie, url, payload);
}

describe('HTTP: /topics/:slug/settings', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('shows what the topic is called, how often it briefs and what it reads', async () => {
    const resp = await page(h, '/topics/topic-1/settings');

    expect(resp.statusCode).toBe(200);
    expect(resp.body).toContain('World news');
    // The Cadence is shown as the stored value, not as the schema's default.
    expect(resp.body).toMatch(/name="cadence" value="daily" checked/);
    expect(resp.body).toContain('Reuters');
    expect(resp.body).toContain('Financial Times');
  });

  it('offers the Sources this topic does not already follow, and only those', async () => {
    const resp = await page(h, '/topics/topic-1/settings');

    const addForm = /action="\/topics\/topic-1\/sources\/add"[\s\S]*?<\/form>/.exec(
      resp.body,
    )?.[0];
    expect(addForm).toBeDefined();
    // Associated Press is the one of the three Sources this topic does not follow,
    // so it is the only one of the three the add control offers: a select that also
    // listed the two already on the topic is a control that can be asked to do
    // something already done.
    expect(addForm).toContain('Associated Press');
    expect(addForm).not.toContain('>Reuters<');
    expect(addForm).not.toContain('>Financial Times<');
  });

  it('names the Sources the topic follows with a way to remove each one', async () => {
    const resp = await page(h, '/topics/topic-1/settings');

    expect(resp.body).toMatch(
      /action="\/topics\/topic-1\/sources\/remove">\s*<input type="hidden" name="sourceId" value="wire-reuters">/,
    );
    expect(resp.body).toMatch(
      /action="\/topics\/topic-1\/sources\/remove">\s*<input type="hidden" name="sourceId" value="wire-ft">/,
    );
  });

  it('is reachable from the LivingBrief', async () => {
    const resp = await page(h, '/topics/topic-1');

    // The settings page is about this topic, so it is reached from the page about
    // this topic. A link only from a settings index is a control the User has to
    // know exists.
    expect(resp.body).toContain('href="/topics/topic-1/settings"');
  });

  it('offers a way back to the brief it is about', async () => {
    const resp = await page(h, '/topics/topic-1/settings');

    expect(resp.body).toContain('href="/topics/topic-1"');
  });

  it('says so when the topic has no sources at all', async () => {
    await h.topicRepo.removeSource('topic-1' as TopicId, 'wire-reuters');
    await h.topicRepo.removeSource('topic-1' as TopicId, 'wire-ft');

    const resp = await page(h, '/topics/topic-1/settings');

    // Not an empty select and no way to act: the User needs to know a topic that
    // reads nothing is why nothing is arriving.
    expect(resp.body).toContain('follows no sources');
  });

  it('says nothing about a change it did not make', async () => {
    // The key is a query string, so it can be anything — including a name from
    // `Object.prototype`, which an object literal used as a lookup table would
    // answer with a function. Rendering that as a sentence throws, and a signed-in
    // User who typed it gets a 500 rather than their settings page.
    const resp = await page(h, '/topics/topic-1/settings?changed=constructor');

    expect(resp.statusCode).toBe(200);
    // Scoped to the rendered notice rather than the class name, which is also in
    // the inlined stylesheet and so on every page.
    expect(resp.body).not.toContain('class="callout callout--success"');
  });

  it('redirects to /signup when not authenticated', async () => {
    const resp = await h.app.inject({ method: 'GET', url: '/topics/topic-1/settings' });

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/signup');
  });
});

describe('HTTP: /topics/:slug/cadence', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('stores the schedule the User picked and shows it on the next load', async () => {
    const resp = await post(h, '/topics/topic-1/cadence', {
      cadence: 'weekly',
      day: 'thursday',
    });

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toContain('/topics/topic-1/settings');
    const topic = await h.topicRepo.getById('topic-1' as TopicId);
    expect(topic?.cadence).toBe('weekly');
    expect(topic?.cadenceDay).toBe('thursday');

    const shown = await page(h, '/topics/topic-1/settings');
    expect(shown.body).toMatch(/name="cadence" value="weekly" checked/);
    expect(shown.body).toMatch(/value="thursday" selected/);
  });

  it('stores never, which stops the topic being emailed at all', async () => {
    await post(h, '/topics/topic-1/cadence', { cadence: 'never', day: 'monday' });

    const topic = await h.topicRepo.getById('topic-1' as TopicId);
    expect(topic?.cadence).toBe('never');
  });

  it('refuses a cadence that is not one of the three, rather than narrowing it', async () => {
    const resp = await post(h, '/topics/topic-1/cadence', {
      cadence: 'hourly',
      day: 'monday',
    });

    expect(resp.statusCode).toBe(400);
    expect(resp.body).toContain('daily, weekly or never');
    expect((await h.topicRepo.getById('topic-1' as TopicId))?.cadence).toBe('daily');
  });

  it('refuses a weekday that is not a day', async () => {
    const resp = await post(h, '/topics/topic-1/cadence', {
      cadence: 'weekly',
      day: 'caturday',
    });

    expect(resp.statusCode).toBe(400);
    expect((await h.topicRepo.getById('topic-1' as TopicId))?.cadence).toBe('daily');
  });

  it('refuses a weekly schedule with no day, rather than picking one for the User', async () => {
    // Storing Monday for a User who asked for weekly and named no day would be a
    // brief arriving on a day they never chose, with nothing on screen saying why.
    const resp = await post(h, '/topics/topic-1/cadence', { cadence: 'weekly', day: '' });

    expect(resp.statusCode).toBe(400);
    expect(resp.body).toContain('needs a day of the week');
    const topic = await h.topicRepo.getById('topic-1' as TopicId);
    expect(topic?.cadence).toBe('daily');
    expect(topic?.cadenceDay).toBeNull();
  });

  it('will not touch a topic that is not the users', async () => {
    const resp = await post(h, '/topics/topic-1/cadence', { cadence: 'never', day: '' });

    expect([302, 404]).toContain(resp.statusCode);
  });
});

describe('HTTP: /topics/:slug/rename', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('stores the new name and shows it everywhere the topic is named', async () => {
    const resp = await post(h, '/topics/topic-1/rename', {
      title: 'World news and weather',
    });

    expect(resp.statusCode).toBe(302);
    const settings = await page(h, '/topics/topic-1/settings');
    expect(settings.body).toContain('World news and weather');
    const brief = await page(h, '/topics/topic-1');
    expect(brief.body).toContain('World news and weather');
  });

  it('comes back with what was typed when the name is refused', async () => {
    const resp = await post(h, '/topics/topic-1/rename', { title: '   ' });

    expect(resp.statusCode).toBe(400);
    expect(resp.body).toContain('between 1 and 80 characters');
    // The stored title, not the refused one: a page that showed the refused value
    // in the heading would claim a save that did not happen.
    expect(resp.body).toContain('World news');
    expect((await h.topicRepo.getById('topic-1' as TopicId))?.title).toBe('World news');
  });

  it('refuses a name another of the users topics already has', async () => {
    const userId = (h.driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string })
      .id;
    await h.topicRepo.insert(makeTopic({ id: 'topic-2', userId, title: 'Elections' }));

    const resp = await post(h, '/topics/topic-1/rename', { title: 'Elections' });

    expect(resp.statusCode).toBe(400);
    expect(resp.body).toContain('already have a topic');
    expect((await h.topicRepo.getById('topic-1' as TopicId))?.title).toBe('World news');
  });
});

describe('HTTP: /topics/:slug/sources', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('follows a source the user added', async () => {
    const resp = await post(h, '/topics/topic-1/sources/add', { sourceId: 'wire-ap' });

    expect(resp.statusCode).toBe(302);
    expect((await h.topicRepo.getById('topic-1' as TopicId))?.sourceIds).toEqual([
      'wire-reuters',
      'wire-ft',
      'wire-ap',
    ]);
  });

  it('refuses a source that is not in the registry', async () => {
    const resp = await post(h, '/topics/topic-1/sources/add', { sourceId: 'nope' });

    expect(resp.statusCode).toBe(400);
    expect((await h.topicRepo.getById('topic-1' as TopicId))?.sourceIds).toEqual([
      'wire-reuters',
      'wire-ft',
    ]);
  });

  it('stops following a source the user removed', async () => {
    const resp = await post(h, '/topics/topic-1/sources/remove', { sourceId: 'wire-ft' });

    expect(resp.statusCode).toBe(302);
    expect((await h.topicRepo.getById('topic-1' as TopicId))?.sourceIds).toEqual(['wire-reuters']);
    // The link row is what the ingest cycle reads, so it has to be gone too and
    // not merely hidden from the page.
    expect(countRows(h.driver, 'topic_sources')).toBe(1);
  });

  it('refuses to remove a source the topic was not following', async () => {
    const resp = await post(h, '/topics/topic-1/sources/remove', { sourceId: 'wire-ap' });

    expect(resp.statusCode).toBe(400);
    expect((await h.topicRepo.getById('topic-1' as TopicId))?.sourceIds).toEqual([
      'wire-reuters',
      'wire-ft',
    ]);
  });
});

describe('HTTP: /topics/:slug/delete', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopic();
  });

  afterEach(async () => {
    await h.app.close();
  });

  it('removes the topic and leaves the living brief', async () => {
    const resp = await post(h, '/topics/topic-1/delete', {});

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/topics');
    expect(await page(h, '/topics/topic-1').then((r) => r.statusCode)).toBe(404);
  });

  it('takes the topic off the list of topics', async () => {
    await post(h, '/topics/topic-1/delete', {});

    const list = await page(h, '/topics');
    expect(list.body).not.toContain('World news');
  });

  it('frees the slot, so a free user can pick a different topic', async () => {
    // The free tier holds three. A User who picks badly and cannot delete one is
    // stuck at three with the paywall as the only way on, which is the state this
    // control exists to end.
    const userId = (h.driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string })
      .id;
    await h.topicRepo.insert(makeTopic({ id: 'topic-2', userId, title: 'Elections' }));
    await h.topicRepo.insert(makeTopic({ id: 'topic-3', userId, title: 'Climate' }));

    // At the cap, so the picker refuses to add.
    expect((await post(h, '/pick-topics', { templateIds: 'ai-and-ml' })).statusCode).toBe(402);

    await post(h, '/topics/topic-1/delete', {});

    expect(countRows(h.driver, 'topics')).toBe(3);
    expect((await post(h, '/pick-topics', { templateIds: 'ai-and-ml' })).statusCode).toBe(302);
    expect(await h.topicRepo.listByUser(userId)).toHaveLength(3);
  });

  it('reports a topic that is not the users as not found', async () => {
    const resp = await post(h, '/topics/not-a-topic-of-mine/delete', {});

    expect(resp.statusCode).toBe(404);
    expect(countRows(h.driver, 'topics')).toBe(1);
  });
});
