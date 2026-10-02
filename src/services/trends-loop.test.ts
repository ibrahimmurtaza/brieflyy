import { describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import type { Db } from '../db/client.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { Article, SourceId, StoryId } from '../domain/types.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { makeArticle, makeTopic, makeUser } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { createTestDb } from '../testing/test-db.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';

const NOW = new Date('2024-06-15T12:00:00Z');
const SOURCE = 'the-guardian' as SourceId;

async function waitFor(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return predicate();
}

function countRows(driver: { prepare(sql: string): { get(): unknown } }, table: string): number {
  return (driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

/**
 * A User with one Topic and a day of Articles, written after the application is
 * built.
 *
 * After, because building it applies the Directory seed, which replaces the Source
 * registry — the same constraint the browser fixture server documents.
 */
async function seedTopicWithArticles(db: Db): Promise<void> {
  await new DrizzleUserRepo(db).insert(makeUser({ id: 'u1' }));
  const topicRepo = new DrizzleTopicRepo(db);
  await topicRepo.insert(makeTopic({ id: 't1', userId: 'u1', title: 'World news' }));
  await topicRepo.insertTopicSource('t1', SOURCE, 0);

  const entityRepo = new DrizzleEntityRepo(db);
  const entityId = 'entity-acme' as const;
  await entityRepo.upsertByKey({
    id: entityId,
    entity: { name: 'Acme Corp', key: 'acme corp', kind: 'org' },
  });

  const articleRepo = new DrizzleArticleRepo(db);
  const storyRepo = new DrizzleStoryRepo(db);
  for (const [id, when] of [
    ['a1', '2024-06-01T09:00:00Z'],
    ['a2', '2024-06-02T09:00:00Z'],
    ['a3', '2024-06-03T09:00:00Z'],
  ] as const) {
    const publishedAt = new Date(when);
    const article: Article = {
      ...makeArticle({ id }),
      sourceId: SOURCE,
      publishedAt,
      ingestedAt: publishedAt,
      storyId: `story-${id}` as StoryId,
    };
    await storyRepo.insert({
      id: article.storyId as StoryId,
      signature: article.signature,
      firstSeenAt: publishedAt,
      lastSeenAt: publishedAt,
      published: { first: publishedAt, last: publishedAt },
    });
    await articleRepo.insert({ article, entityIds: [entityId] });
  }
}

async function buildApp(input: {
  readonly trendsJobAutoStart: boolean;
  readonly trendsIntervalMs?: number;
}) {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const app = await createApp({
    db,
    emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(NOW).clock,
    random: deterministicRandom,
    trendsJobAutoStart: input.trendsJobAutoStart,
    ...(input.trendsIntervalMs === undefined
      ? {}
      : { trendsIntervalMs: input.trendsIntervalMs }),
  });
  await seedTopicWithArticles(db);
  return { app, driver };
}

describe('the trends job started by the application itself', () => {
  it('materialises a trend without anything asking it to', async () => {
    const { app, driver } = await buildApp({
      trendsJobAutoStart: true,
      trendsIntervalMs: 1,
    });

    try {
      const written = await waitFor(() => countRows(driver, 'topic_trends') >= 1, 10_000);
      expect(written, 'the job never wrote a trend on its own').toBe(true);
      const row = driver
        .prepare(`SELECT topic_id, computed_at FROM topic_trends`)
        .get() as { topic_id: string; computed_at: number };
      expect(row.topic_id).toBe('t1');
      expect(row.computed_at).toBe(NOW.getTime());
    } finally {
      await app.close();
    }
  });

  it('holds one row per Topic however many times it goes round', async () => {
    const { app, driver } = await buildApp({
      trendsJobAutoStart: true,
      trendsIntervalMs: 1,
    });

    try {
      await waitFor(() => countRows(driver, 'topic_trends') === 1, 10_000);
      // Let several passes go by, then check the row count again. A pass that
      // appended would make the trends table the largest thing in the database.
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(countRows(driver, 'topic_trends')).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('closes promptly even though the interval is an hour', async () => {
    const { app } = await buildApp({
      trendsJobAutoStart: true,
      trendsIntervalMs: 60 * 60 * 1000,
    });

    const startedAt = Date.now();
    await app.close();
    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('leaves the job switched off when the application starts it switched off', async () => {
    const { app, driver } = await buildApp({ trendsJobAutoStart: false });
    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(countRows(driver, 'topic_trends')).toBe(0);
    } finally {
      await app.close();
    }
  });
});