import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { FeedFetcher, RawFeed } from '../ingest/feed-fetcher.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { createTestDb } from './test-db.js';
import { extractMagicLinkToken } from './email.js';
import { makeTopic } from './fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from './test-clocks.js';
import type { TopicId } from '../domain/types.js';

/** The Directory's slugs for the two Sources a loop test reads. */
const DEFAULT_SOURCES = ['the-guardian', 'bbc-news'] as const;

export interface AppHarness {
  readonly app: FastifyInstance;
  /** The session cookie of the signed-in User, for `app.inject` headers. */
  readonly cookie: string;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
  readonly db: ReturnType<typeof createTestDb>['db'];
  readonly clock: TestClock;
  readonly articleRepo: DrizzleArticleRepo;
  /** The row count of a table, for the things a cycle wrote. */
  count(table: string): number;
}

export interface AppHarnessInput {
  /** What each feed URL serves. A feed nothing was registered for fails loudly. */
  readonly feeds: Readonly<Record<string, RawFeed>>;
  readonly now: Date;
  readonly topicTitle?: string;
  readonly sources?: readonly string[];
}

/** A feed fetcher that serves exactly the feeds it was given. */
export class SeededFeedFetcher implements FeedFetcher {
  constructor(private readonly feeds: Readonly<Record<string, RawFeed>>) {}

  async fetch(url: string): Promise<RawFeed> {
    const feed = this.feeds[url];
    if (!feed) throw new Error(`unexpected feed url ${url}`);
    return feed;
  }
}

/**
 * The whole path a cycle takes, with nothing written by hand: a signed-in User, a
 * Topic on the Directory's Sources, and a clock to move.
 *
 * Two loop tests need exactly this and neither needs any of it differently, so it
 * lives here rather than being copied into each: what a test is about is what the
 * feed says, not how a User gets signed in.
 */
export async function buildAppHarness(input: AppHarnessInput): Promise<AppHarness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(input.now);
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: clock.clock,
    random: deterministicRandom,
    feedFetcher: new SeededFeedFetcher(input.feeds),
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
  await topicRepo.insert(
    makeTopic({ id: 'topic-1', userId, title: input.topicTitle ?? 'World news' }),
  );
  for (const id of input.sources ?? DEFAULT_SOURCES) {
    await topicRepo.insertTopicSource('topic-1' as TopicId, id, 0);
  }

  return {
    app,
    cookie,
    driver,
    db,
    clock,
    articleRepo: new DrizzleArticleRepo(db),
    count: (table: string): number =>
      (
        driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }
      ).n,
  };
}
