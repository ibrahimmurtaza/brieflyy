import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { SqliteDriver } from '../db/client.js';
import { createTestDb } from '../testing/test-db.js';
import { countRows } from '../testing/db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import { makeCluster, makeTopic } from '../testing/fixtures.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import type { SourceId, StoryId, TopicId } from '../domain/types.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from '../testing/test-clocks.js';

const NOW = new Date('2026-09-02T12:00:00Z');
const APP_BASE_URL = 'https://app.brieflyy.test';

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly transport: ConsoleEmailTransport;
  readonly driver: SqliteDriver;
  readonly clock: TestClock;
  readonly userId: string;
  count(table: string): number;
  firstRow<T>(sql: string): T | undefined;
}

async function signInWithTopicAndClusters(): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(NOW);
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: APP_BASE_URL,
    cookieSecure: false,
    clock: clock.clock,
    random: deterministicRandom,
  });
  const email = 'iris@example.com';
  await app.inject({ method: 'POST', url: '/auth/magic-link/request', payload: { email } });
  const token = extractMagicLinkToken(transport.snapshot()[0]!.text);
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const setCookie = verify.headers['set-cookie'];
  const sessionCookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';')[0]!;
  const { cookies } = await signedInCookies(app, sessionCookie);

  const topicRepo = new DrizzleTopicRepo(db);
  const userId = (driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
  await topicRepo.insert(makeTopic({ id: 'topic-1', userId, title: 'World news' }));
  await topicRepo.insertTopicSource('topic-1' as TopicId, 'the-guardian', 0);

  for (const [storyId, clusterId, title, velocity] of [
    ['story-1', 'c-fast', 'Fast story', 9],
    ['story-2', 'c-slow', 'Slow story', 1],
  ] as const) {
    await new DrizzleStoryRepo(db).insert({
      id: storyId as StoryId,
      signature: EMPTY_SIGNATURE,
      firstSeenAt: NOW,
      lastSeenAt: NOW,
      published: { first: NOW, last: NOW },
    });
    driver
      .prepare(
        `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, signature, story_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        `article-${clusterId}`,
        'the-guardian',
        `ext-${clusterId}`,
        `https://example.com/${clusterId}`,
        title,
        'A sentence worth quoting.',
        NOW.getTime(),
        NOW.getTime(),
        '{}',
        storyId,
      );
    await new DrizzleClusterRepo(db).insert(
      makeCluster({
        id: clusterId,
        topicId: 'topic-1',
        title,
        summary: `${title} summary.`,
        bulletPoints: ['A sentence worth quoting.'],
        velocity,
        sourceIds: ['the-guardian'],
      }),
      [storyId as StoryId],
    );
  }

  return {
    app,
    cookie: cookies,
    transport,
    driver,
    clock,
    userId,
    count: (table: string): number => countRows(driver, table),
    firstRow: <T,>(sql: string): T | undefined => driver.prepare(sql).get() as T | undefined,
  };
}

function snapshotIds(h: Harness): string[] {
  return (h.driver.prepare(`SELECT id FROM brief_snapshots ORDER BY created_at`).all() as { id: string }[]).map(
    (r) => r.id,
  );
}

async function sendBrief(h: Harness): Promise<void> {
  await submitForm(h.app, h.cookie, '/topics/topic-1/send-brief');
}

describe('HTTP: brief regeneration pages', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await signInWithTopicAndClusters();
  });

  it('shows the plan a stored snapshot was rendered from, in the order it was sent', async () => {
    await sendBrief(h);
    const id = snapshotIds(h)[0]!;

    const res = await h.app.inject({
      method: 'GET',
      url: `/briefs/${id}/edit`,
      headers: { cookie: h.cookie },
    });

    expect(res.statusCode).toBe(200);
    // The two stories in the order the plan chose: fastest first.
    expect(res.body.indexOf('Fast story')).toBeLessThan(res.body.indexOf('Slow story'));
    expect(res.body).toContain('method="POST"');
  });

  it('a changed selection and order makes a new brief, and the old one is untouched', async () => {
    await sendBrief(h);
    const id = snapshotIds(h)[0]!;
    const beforeHtml = h.firstRow<{ html: string }>(
      `SELECT html FROM brief_snapshots WHERE id = '${id}'`,
    )!.html;

    h.clock.advance(1000);
    const res = await submitForm(h.app, h.cookie, `/briefs/${id}/regenerate`, {
      ids: ['c-slow', 'c-fast'],
    });

    // A new snapshot exists, the old is byte-identical, and the new one was
    // delivered and recorded through the one path every brief goes through.
    expect(snapshotIds(h)).toHaveLength(2);
    expect(h.count('email_deliveries')).toBe(2);
    const briefs = h.transport.snapshot().filter((m) => m.subject.endsWith('- Brieflyy'));
    expect(briefs).toHaveLength(2);
    expect(briefs[1]!.text!.indexOf('Slow story')).toBeLessThan(briefs[1]!.text!.indexOf('Fast story'));
    expect(
      h.firstRow<{ html: string }>(`SELECT html FROM brief_snapshots WHERE id = '${id}'`)!.html,
    ).toBe(beforeHtml);
    expect(res.statusCode).toBe(302);
  });

  it('refuses a plan that names a Cluster the Topic no longer has, with a reason', async () => {
    await sendBrief(h);
    const id = snapshotIds(h)[0]!;

    const res = await submitForm(h.app, h.cookie, `/briefs/${id}/regenerate`, {
      ids: ['c-gone'],
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('c-gone');
    expect(snapshotIds(h)).toHaveLength(1);
    expect(h.count('email_deliveries')).toBe(1);
  });

  it('refuses an empty selection with a reason', async () => {
    await sendBrief(h);
    const id = snapshotIds(h)[0]!;

    const res = await submitForm(h.app, h.cookie, `/briefs/${id}/regenerate`, {
      ids: [],
    });

    // urlencoded forms cannot carry an empty array, so an empty selection
    // arrives as no `ids` field at all; it must be refused the same way.
    expect(res.statusCode).toBe(200);
    expect(res.body.toLowerCase()).toContain('empty');
    expect(snapshotIds(h)).toHaveLength(1);
  });

  it('refuses an unknown snapshot with a 404 rather than guessing', async () => {
    await sendBrief(h);
    // An id that is not this User's (or does not exist) is refused the same way.
    const res = await submitForm(h.app, h.cookie, `/briefs/unknown/regenerate`, {
      ids: ['c-slow'],
    });

    expect(res.statusCode).toBe(404);
    expect(h.count('brief_snapshots')).toBe(1);
  });
});
