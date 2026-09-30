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
import { RecordingSummaryClient } from '../../src/testing/summary-client.js';
import type { SourceId, StoryId, TopicCategory, TopicOrigin } from '../../src/domain/types.js';
import { E2E_BASE_URL, E2E_PORT } from './base-url.js';
import {
  E2E_ALL_UNSUBSCRIBE_TOKEN,
  E2E_EMAIL,
  E2E_SESSION_ID,
  E2E_TOPIC_UNSUBSCRIBE_TOKEN,
} from './fixture-data.js';

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
  // A summary client that writes, so a spec can follow a brief a User actually
  // asked for rather than one a test assembled and wrote to a temp file. The
  // same double the vitest suite uses, and a double for the same reason: the
  // specs share this process and nothing in here may reach a provider.
  llmSummaryClient: new RecordingSummaryClient(),
});

const topicRepo = new DrizzleTopicRepo(db);
const storyRepo = new DrizzleStoryRepo(db);
const clusterRepo = new DrizzleClusterRepo(db);

// The ids double as the slugs, because `makeTopic` derives one from the other.
//
// `world-news` carries the Directory origin it would have in a real session:
// added from a template, with `origin_template_id` pointing at the row, which is
// the state the picker spec needs and the only one that exercises that foreign
// key. `makeTopic` defaults to `freeform`, and the topic would still have shown
// as held — the picker also matches on title, and this Topic's title is the
// template's title. So the origin is not what makes the spec pass; it is what
// makes the fixture true.
//
// `fusion-energy` is not a Directory template, so it stays freeform, and it is
// what holds the spec's count at 1 rather than 2.
for (const [id, title, category, origin] of [
  [
    'world-news',
    'World news',
    'news',
    { kind: 'template', templateId: 'world-news' },
  ],
  ['fusion-energy', 'Fusion energy', 'unspecified', { kind: 'freeform' }],
] as const satisfies readonly (readonly [string, string, TopicCategory, TopicOrigin])[]) {
  await topicRepo.insert(
    makeTopic({
      id,
      userId: USER_ID,
      title,
      category,
      origin,
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

/**
 * A brief that really went out, with tokens the specs know.
 *
 * The unsubscribe routes are public and the token is the whole authorisation, so
 * the only honest way for a spec to reach them is the way a reader does: by
 * following a link out of an email. The spec process cannot reach into this
 * server's memory to read a token the way the vitest suite does, so the delivery
 * is written here with the tokens `fixture-data.ts` exports, and the spec uses
 * them as the links they are — same columns, same lookups, same route.
 *
 * Written on `fusion-energy` rather than `world-news` so that a spec spending the
 * per-Topic token stops a brief no other spec reads.
 */
insert(
  `INSERT INTO brief_plans (id, topic_id, user_id, created_at, cluster_ids)
   VALUES ('e2e-brief-plan-1', 'fusion-energy', ?, ?, ?)`,
  USER_ID,
  NOW.getTime() - DAY,
  '["e2e-cluster-1"]',
);
insert(
  `INSERT INTO brief_snapshots (id, brief_plan_id, user_id, topic_id, created_at, html, text, unsubscribe_token, global_unsubscribe_token)
   VALUES ('e2e-snapshot-1', 'e2e-brief-plan-1', ?, 'fusion-energy', ?, '<p>A brief</p>', 'A brief', ?, ?)`,
  USER_ID,
  NOW.getTime() - DAY,
  E2E_TOPIC_UNSUBSCRIBE_TOKEN,
  E2E_ALL_UNSUBSCRIBE_TOKEN,
);
insert(
  `INSERT INTO email_deliveries (id, user_id, brief_snapshot_id, topic_id, sent_at, unsubscribe_token, global_unsubscribe_token)
   VALUES ('e2e-delivery-1', ?, 'e2e-snapshot-1', 'fusion-energy', ?, ?, ?)`,
  USER_ID,
  NOW.getTime() - DAY,
  E2E_TOPIC_UNSUBSCRIBE_TOKEN,
  E2E_ALL_UNSUBSCRIBE_TOKEN,
);

/**
 * Put the unsubscribe state back, so each spec starts from a reader who still
 * wants their mail.
 *
 * A token is single-use by design, and the specs share one server process. That
 * makes a spent token a fact about the whole run rather than about one spec: the
 * first spec to follow a link would leave every later one looking at a reader who
 * has already unsubscribed. This exists only here, in the fixture server, rather
 * than in the application — the single-use property is the product's, and a reset
 * route in `src/` would be a way to spend the same token twice.
 */
app.post('/e2e/reset-unsubscribe', async (_req, reply) => {
  insert(`UPDATE users SET unsubscribed_at = NULL WHERE id = ?`, USER_ID);
  insert(`UPDATE topics SET unsubscribed_at = NULL WHERE user_id = ?`, USER_ID);
  insert(`DELETE FROM unsubscribes`);
  return reply.code(204).send();
});

/**
 * Soft-remove a Topic, the way a User does from `/topics`.
 *
 * A removal keeps the row, so the delivery a token was minted for still resolves
 * and the unsubscribe is still real — which is the state that made a
 * confirmation page read "You have stopped undefined briefs": the Topic id
 * resolved, and the Topic behind it did not.
 */
app.post<{ Body: { id?: string } }>('/e2e/remove-topic', async (req, reply) => {
  const id = (req.body ?? {}).id;
  if (typeof id !== 'string') return reply.code(400).send();
  insert(`UPDATE topics SET removed_at = ? WHERE id = ?`, NOW.getTime(), id);
  return reply.code(204).send();
});

/** Undo a soft removal, so the removal spec does not affect the ones after it. */
app.post<{ Body: { id?: string } }>('/e2e/restore-topic', async (req, reply) => {
  const id = (req.body ?? {}).id;
  if (typeof id !== 'string') return reply.code(400).send();
  insert(`UPDATE topics SET removed_at = NULL WHERE id = ?`, id);
  return reply.code(204).send();
});

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
