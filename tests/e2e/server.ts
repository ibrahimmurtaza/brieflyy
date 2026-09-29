/**
 * A real Brieflyy for the browser specs: the real application on a throwaway
 * SQLite file, with one signed-in User who already has a Topic, a Cluster and an
 * Article.
 *
 * The specs run in their own process, so they cannot reach into this server's
 * memory to find a magic-link token the way the vitest suite does. Instead this
 * writes a session with a known id and the specs set that cookie, which is the
 * same session a real sign-in would produce and keeps the specs offline.
 *
 * Two things this file has to respect, both learned the hard way:
 *
 * - Content is written through the repositories, because `clusters.source_ids`
 *   and `clusters.bullet_points` are plain text with a repository-level
 *   encoding. Seeding them as SQL produces a Cluster whose Source ids are the
 *   literal string `["reuters"`.
 * - Everything is written *after* `createApp`, because building the application
 *   applies the Directory seed, which replaces the Source registry. A Source
 *   inserted before it does not survive, and an Article pointing at one is then
 *   removed with it by the cascade.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { applySchema } from '../../src/db/migrate.js';
import { createDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { ConsoleEmailTransport } from '../../src/email/console-transport.js';
import { SESSION_COOKIE_NAME } from '../../src/config.js';
import { systemClock } from '../../src/domain/clock.js';
import { EMPTY_SIGNATURE } from '../../src/domain/story-signature.js';
import { DrizzleClusterRepo } from '../../src/repos/cluster-repo.js';
import { DrizzleStoryRepo } from '../../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../../src/repos/topic-repo.js';
import { makeCluster, makeTopic } from '../../src/testing/fixtures.js';
import type { SourceId, StoryId } from '../../src/domain/types.js';
import { E2E_BASE_URL, E2E_PORT } from './base-url.js';
import { E2E_EMAIL, E2E_SESSION_ID } from './fixture-data.js';

const HOST = '127.0.0.1';
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const USER_ID = 'e2e-user';

/** Two Sources the Directory seed is known to have, so nothing is invented. */
const SOURCES: readonly (readonly [SourceId, string])[] = [
  ['the-guardian' as SourceId, 'The Guardian'],
  ['bbc-news' as SourceId, 'BBC News'],
];

// A fresh directory per run rather than a fixed one: a previous run that died
// mid-test leaves an open handle behind, and Windows will not let it be removed.
const dir = mkdtempSync(join(tmpdir(), 'brieflyy-e2e-'));

const driver = new Database(join(dir, 'e2e.db'));
applySchema(driver);
const db = createDatabase({ driver });

const insert = (sql: string, ...args: unknown[]): void => {
  driver.prepare(sql).run(...(args as never[]));
};

insert(
  `INSERT INTO users (id, created_at, onboarding_state, tier) VALUES (?, ?, 'delivery_set', 'free')`,
  USER_ID,
  NOW.getTime() - 30 * DAY,
);
insert(
  `INSERT INTO accounts (id, user_id, email, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)`,
  'e2e-account',
  USER_ID,
  E2E_EMAIL,
  NOW.getTime() - 30 * DAY,
  NOW.getTime() - 30 * DAY,
);
insert(
  `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)`,
  E2E_SESSION_ID,
  USER_ID,
  NOW.getTime(),
  NOW.getTime() + 30 * DAY,
);
insert(
  `INSERT INTO delivery_settings (user_id, hour, minute, timezone) VALUES (?, 8, 0, 'America/New_York')`,
  USER_ID,
);

const app = await createApp({
  db,
  emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
  appBaseUrl: E2E_BASE_URL,
  cookieSecure: false,
  clock: systemClock,
  devToolsEnabled: true,
});

const topicRepo = new DrizzleTopicRepo(db);
const storyRepo = new DrizzleStoryRepo(db);
const clusterRepo = new DrizzleClusterRepo(db);

// The ids double as the slugs, because `makeTopic` derives one from the other.
for (const [id, title, category] of [
  ['world-news', 'World news', 'news'],
  ['fusion-energy', 'Fusion energy', 'unspecified'],
] as const) {
  await topicRepo.insert(
    makeTopic({
      id,
      userId: USER_ID,
      title,
      category,
      createdAt: new Date(NOW.getTime() - 30 * DAY),
    }),
  );
  for (const [position, [sourceId]] of SOURCES.entries()) {
    await topicRepo.insertTopicSource(id, sourceId, position);
  }
}

insert(
  `INSERT INTO articles (id, source_id, external_id, url, title, body, published_at, ingested_at, signature, story_id)
   VALUES ('e2e-article-1', ?, 'ext-1', 'https://www.theguardian.com/acme-foo', 'Acme Corp unveils Foo',
           'Acme Corp unveiled a product called Foo, and the market has noticed.', ?, ?, '{}', 'e2e-story-1')`,
  SOURCES[0]![0],
  NOW.getTime() - DAY,
  NOW.getTime(),
);
await storyRepo.insert({
  id: 'e2e-story-1' as StoryId,
  sourceId: SOURCES[0]![0],
  signature: EMPTY_SIGNATURE,
  firstSeenAt: new Date(NOW.getTime() - DAY),
  lastSeenAt: NOW,
  published: { first: new Date(NOW.getTime() - DAY), last: NOW },
});
await clusterRepo.insert(
  makeCluster({
    id: 'e2e-cluster-1',
    topicId: 'world-news',
    title: 'Acme Corp unveils Foo',
    summary: 'Acme Corp unveiled Foo today, and analysts are split on what it means for its competitors.',
    bulletPoints: [
      'The launch changes the landscape for enterprise customers.',
      'Analysts had expected the launch in the spring.',
    ],
    sourceIds: SOURCES.map(([id]) => id),
    createdAt: new Date(NOW.getTime() - DAY),
    lastSeenAt: NOW,
  }),
  ['e2e-story-1' as StoryId],
);

await app.listen({ port: E2E_PORT, host: HOST });
console.log(`e2e: listening on ${E2E_BASE_URL} (session cookie ${SESSION_COOKIE_NAME}=${E2E_SESSION_ID})`);

const shutdown = async (): Promise<void> => {
  await app.close();
  driver.close();
  // Best effort: the throwaway database is in the OS temp directory, and a
  // leftover one costs nothing.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignored
  }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
