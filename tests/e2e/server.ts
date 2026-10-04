/**
 * A real Brieflyy for the browser specs: the real application on a throwaway
 * SQLite file, seeded with the Users, Topics, Stories, Clusters and Articles the
 * specs read, and the harness routes they read those through.
 *
 * The specs run in their own process, so they cannot reach into this server's
 * memory to find a magic-link token the way the vitest suite does. Instead this
 * writes sessions with known ids and the specs set those cookies, which is the
 * same session a real sign-in would produce and keeps the specs offline. The specs
 * that do sign a User up rather than being handed one reach the mail through
 * `/e2e/mailbox`, because that is the only place a spec can read it from.
 *
 * This file is the seeding and nothing else; the six routes the specs lean on are
 * in `./harness-routes.ts`, so that adding a fixture and adding a way to observe
 * one are separate changes. Three things here are worth stating once, because they
 * are not obvious and were each learned the hard way:
 *
 * - Content is written through the repositories, because `clusters.source_ids`
 *   and `clusters.bullet_points` are plain text with a repository-level
 *   encoding. Seeding them as SQL produces a Cluster whose Source ids are the
 *   literal string `["reuters"`.
 * - Everything is written *after* `createApp`, because building the application
 *   applies the Directory seed, which replaces the Source registry. A Source
 *   inserted before it does not survive, and an Article pointing at one is then
 *   removed with it by the cascade.
 * - A row with no code path behind it is a fixture nothing is reading. Every User
 *   here exists because some spec signs in as them, and each one's reason is on it.
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import Database from 'better-sqlite3';

import { applySchema } from '../../src/db/migrate.js';
import { createDatabase } from '../../src/db/client.js';
import { createApp } from '../../src/app.js';
import { ConsoleEmailTransport } from '../../src/email/console-transport.js';
import { GoogleOAuthClient } from '../../src/oauth/google-client.js';
import { SESSION_COOKIE_NAME } from '../../src/config.js';
import { systemClock } from '../../src/domain/clock.js';
import { EMPTY_SIGNATURE } from '../../src/domain/story-signature.js';
import { DrizzleClusterRepo } from '../../src/repos/cluster-repo.js';
import { DrizzleStoryRepo } from '../../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../../src/repos/topic-repo.js';
import { DrizzleTrendsRepo } from '../../src/repos/trends-repo.js';
import { DrizzleEntityRepo } from '../../src/repos/entity-repo.js';
import { DrizzleArticleRepo } from '../../src/repos/article-repo.js';
import { TrendsService } from '../../src/services/trends-service.js';
import { nodeRandom } from '../../src/domain/crypto.js';
import { makeCluster, makeTopic } from '../../src/testing/fixtures.js';
import { RecordingSummaryClient } from '../../src/testing/summary-client.js';
import type {
  ArticleId,
  EntityId,
  SourceId,
  StoryId,
  TopicCategory,
  TopicOrigin,
} from '../../src/domain/types.js';
import { E2E_BASE_URL, E2E_PORT } from './base-url.js';
import { registerHarnessRoutes } from './harness-routes.js';
import {
  E2E_EMAIL,
  E2E_FEEDBACK_FIXTURES,
  E2E_FEEDBACK_SLUG,
  E2E_FEEDBACK_TITLE,
  E2E_QUOTED_ARTICLE_TITLE,
  E2E_QUOTED_SLUG,
  E2E_QUOTED_TITLE,
  E2E_SESSION_ID,
  E2E_UNSUBSCRIBE_FIXTURES,
  E2E_UNSUBSCRIBE_OTHER_TOPIC_SLUG,
  E2E_UNSUBSCRIBE_OTHER_TOPIC_TITLE,
  E2E_UNSUBSCRIBE_TOPIC_SLUG,
  E2E_UNSUBSCRIBE_TOPIC_TITLE,
} from './fixture-data.js';

const HOST = '127.0.0.1';
const NOW = new Date();
const DAY = 24 * 60 * 60 * 1000;
const SESSION_TTL_MS = 30 * DAY;
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

/**
 * A User, an Account, a session the specs hold the id of, and a DeliveryTime.
 *
 * One shape for all of them because they are all the same four rows, and a User
 * with no DeliveryTime is not a state this application keeps: the header would
 * offer the setting rather than a time, and three of the specs assert on that
 * header. Written as SQL rather than through the repositories because these are
 * rows the application has no public way to create before its own routes run.
 */
function insertReader(input: {
  readonly userId: string;
  readonly email: string;
  readonly sessionId: string;
}): void {
  insert(
    `INSERT INTO users (id, created_at, onboarding_state, tier) VALUES (?, ?, 'delivery_set', 'free')`,
    input.userId,
    NOW.getTime() - 30 * DAY,
  );
  insert(
    `INSERT INTO accounts (id, user_id, email, email_verified_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    `${input.userId}-account`,
    input.userId,
    input.email,
    NOW.getTime() - 30 * DAY,
    NOW.getTime() - 30 * DAY,
  );
  insert(
    `INSERT INTO sessions (id, user_id, created_at, expires_at, revoked_at) VALUES (?, ?, ?, ?, NULL)`,
    input.sessionId,
    input.userId,
    NOW.getTime(),
    NOW.getTime() + SESSION_TTL_MS,
  );
  insert(
    `INSERT INTO delivery_settings (user_id, hour, minute, timezone) VALUES (?, 8, 0, 'America/New_York')`,
    input.userId,
  );
}

/**
 * Iris, for the specs that only read.
 *
 * Her `world-news` Topic carries the Directory origin it would have in a real
 * session: added from a template, with `origin_template_id` pointing at the row,
 * which is the only state that exercises that foreign key. `makeTopic` defaults to
 * `freeform`, and the Topic would still have shown as held without it, because the
 * picker also matches on title and this Topic's title is the template's title. So
 * the origin is not what makes the spec pass; it is what makes the fixture true.
 *
 * `fusion-energy` is not a Directory template, so it stays freeform, and it is the
 * one the free-form-category spec reads.
 *
 * Two Topics and not three, deliberately: a third would put her on the free cap,
 * which is a state the picker specs exercise from the other side.
 */
insertReader({ userId: USER_ID, email: E2E_EMAIL, sessionId: E2E_SESSION_ID });

// The transport is held rather than built inline, because a spec that signs a User
// up, or that reads the mail a brief went out in, has to read it and this is the
// only place it can be read from. See `/e2e/mailbox` in `./harness-routes.ts`.
const emailTransport = new ConsoleEmailTransport({ logger: () => {} });

const app = await createApp({
  db,
  emailTransport,
  appBaseUrl: E2E_BASE_URL,
  cookieSecure: false,
  clock: systemClock,
  devToolsEnabled: true,
  // Placeholder credentials, and the real client, because whether an instance
  // offers Google is a property of the deployment (ADR-0019) — and a deployed
  // instance is what these specs are meant to be looking at. The sign-in page
  // renders the Google button only where a provider is configured, and the smoke
  // spec asserts that button is visible because it is one of the controls that
  // went white-on-white under a dark browser. Nothing here reaches Google: the
  // client fetches its keys during a code exchange, and no spec follows the
  // button off the page.
  oauthClient: new GoogleOAuthClient({
    clientId: 'e2e-client-id',
    clientSecret: 'e2e-client-secret',
  }),
  // The summary client the vitest suite uses, and a double for the same reason: the
  // specs share this process and nothing in here may reach a provider. It writes,
  // so a spec can follow a brief a User actually asked for; and it declines the one
  // Cluster named `E2E_QUOTED_ARTICLE_TITLE`, which is what puts a quoted brief in
  // front of a browser without a second application or a second renderer.
  llmSummaryClient: new RecordingSummaryClient((call) =>
    call.clusterTitle === E2E_QUOTED_ARTICLE_TITLE ? null : undefined,
  ),
});

const topicRepo = new DrizzleTopicRepo(db);
const storyRepo = new DrizzleStoryRepo(db);
const clusterRepo = new DrizzleClusterRepo(db);
const articleRepo = new DrizzleArticleRepo(db);
const entityRepo = new DrizzleEntityRepo(db);

// The ids double as the slugs, because `makeTopic` derives one from the other.
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

/**
 * A User per viewport, for the specs that record a signal or send a brief.
 *
 * Iris is on the free tier, so a third Topic of hers would put her at the cap. A
 * User of her own is what keeps a stored signal out of every page the read-only
 * specs are looking at, and a User per viewport is what keeps one viewport's
 * signal out of another viewport's starting state. See `fixture-data.ts` for why the
 * latter matters even though recording the same signal twice writes nothing.
 *
 * Two Topics each, because a spec that writes needs somewhere of its own to write
 * to and the two kinds of writing do not share a claim: `seedSignalTopic` is where
 * the feedback specs press things, `seedQuotedTopic` is where the brief that could
 * not be written is sent from.
 */
for (const [project, signals] of Object.entries(E2E_FEEDBACK_FIXTURES)) {
  const userId = `e2e-signals-${project}`;
  insertReader({ userId, email: signals.email, sessionId: signals.sessionId });
  await seedSignalTopic({ project, userId, signals });
  await seedQuotedTopic({ project, userId, signals });
}

/**
 * The Topic the feedback specs press things on.
 *
 * Freeform, with Sources on it, which is what the picker and the per-Topic settings
 * page together produce for somebody who starts from their own idea and then says
 * where to read it. Two Sources rather than one because the hide control is only
 * meaningful where hiding one outlet still leaves the other outlet's account of the
 * same story on the page.
 *
 * The Story behind the Cluster is one story told twice, which is the same point: a
 * hide that took the story with it would satisfy "the hidden outlet's Article is
 * absent" just as well as this does.
 */
async function seedSignalTopic(input: {
  readonly project: string;
  readonly userId: string;
  readonly signals: (typeof E2E_FEEDBACK_FIXTURES)[keyof typeof E2E_FEEDBACK_FIXTURES];
}): Promise<void> {
  const { project, userId, signals } = input;
  await topicRepo.insert(
    makeTopic({
      id: signals.topicId,
      slug: E2E_FEEDBACK_SLUG,
      userId,
      title: E2E_FEEDBACK_TITLE,
      category: 'unspecified',
      origin: { kind: 'freeform' },
      createdAt: new Date(NOW.getTime() - 30 * DAY),
    }),
  );
  for (const [position, [sourceId]] of signals.sources.entries()) {
    await topicRepo.insertTopicSource(signals.topicId, sourceId as SourceId, position);
  }

  const storyId = `e2e-signals-${project}-story` as StoryId;
  await storyRepo.insert({
    id: storyId,
    signature: EMPTY_SIGNATURE,
    firstSeenAt: new Date(NOW.getTime() - DAY),
    lastSeenAt: NOW,
    published: { first: new Date(NOW.getTime() - DAY), last: NOW },
  });
  for (const [position, [sourceId, headline]] of signals.articles.entries()) {
    await articleRepo.insert({
      article: {
        id: `e2e-signals-${project}-article-${position}` as ArticleId,
        sourceId: sourceId as SourceId,
        externalId: `ext-signals-${project}-${position}`,
        url: `https://example.com/signals-${project}-storm-${position}`,
        title: headline,
        body: 'A storm took the regional grid offline, and both outlets reported the same evening.',
        publishedAt: new Date(NOW.getTime() - DAY),
        ingestedAt: NOW,
        entities: [],
        signature: EMPTY_SIGNATURE,
        storyId,
      },
      entityIds: [],
    });
  }
  await clusterRepo.insert(
    makeCluster({
      id: signals.clusterId,
      topicId: signals.topicId,
      title: signals.articles[0]![1],
      summary: 'A storm took the regional grid offline, and restoration ran through the night.',
      bulletPoints: [
        'Two of the outlets the User follows carried the same account of the outage.',
        'Restoration crews worked through the night on the damaged lines.',
      ],
      articleCount: signals.articles.length,
      sourceIds: signals.articles.map(([sourceId]) => sourceId as SourceId),
      createdAt: new Date(NOW.getTime() - DAY),
      lastSeenAt: NOW,
    }),
    [storyId],
  );
}

/**
 * A Topic of their own for the brief that has to be quoted.
 *
 * The written path is handed the Article each bullet came from, so its anchors are
 * built. The quoted path has only a stored sentence, so it looks the sentence up
 * against the Cluster's own Articles, and that lookup is a different piece of code
 * with a different way of going wrong. A brief made entirely of quotations is what a
 * deployment with no credential sends, so it is the kind most likely to be the only
 * kind anybody ever sees, and it used to be checked by rendering a document to a
 * temporary file and opening that.
 *
 * One Article rather than two, and the bullet is that Article's own title, which is a
 * statement the lookup offers when the body has none to match. The Cluster's title is
 * what the summary client declines, which is how this brief comes to be quoted rather
 * than written: the renderer falls back on a client that answers nothing, exactly as
 * it does when a provider fails.
 */
async function seedQuotedTopic(input: {
  readonly project: string;
  readonly userId: string;
  readonly signals: (typeof E2E_FEEDBACK_FIXTURES)[keyof typeof E2E_FEEDBACK_FIXTURES];
}): Promise<void> {
  const { project, userId, signals } = input;
  const topicId = `e2e-signals-${project}-${E2E_QUOTED_SLUG}`;
  await topicRepo.insert(
    makeTopic({
      id: topicId,
      slug: E2E_QUOTED_SLUG,
      userId,
      title: E2E_QUOTED_TITLE,
      category: 'unspecified',
      origin: { kind: 'freeform' },
      createdAt: new Date(NOW.getTime() - 30 * DAY),
    }),
  );
  await topicRepo.insertTopicSource(topicId, SOURCES[0]![0], 0);

  const storyId = `e2e-signals-${project}-quoted-story` as StoryId;
  await storyRepo.insert({
    id: storyId,
    signature: EMPTY_SIGNATURE,
    firstSeenAt: new Date(NOW.getTime() - DAY),
    lastSeenAt: NOW,
    published: { first: new Date(NOW.getTime() - DAY), last: NOW },
  });
  await articleRepo.insert({
    article: {
      id: `e2e-signals-${project}-quoted-article` as ArticleId,
      sourceId: SOURCES[0]![0],
      externalId: `ext-signals-${project}-quoted`,
      url: signals.quotedArticleUrl,
      title: E2E_QUOTED_ARTICLE_TITLE,
      body: 'Repair crews worked through the night on the damaged lines.',
      publishedAt: new Date(NOW.getTime() - DAY),
      ingestedAt: NOW,
      entities: [],
      signature: EMPTY_SIGNATURE,
      storyId,
    },
    entityIds: [],
  });
  await clusterRepo.insert(
    makeCluster({
      id: `e2e-signals-${project}-quoted-cluster`,
      topicId,
      title: E2E_QUOTED_ARTICLE_TITLE,
      summary: 'Repair crews worked through the night on the damaged lines.',
      bulletPoints: [E2E_QUOTED_ARTICLE_TITLE],
      articleCount: 1,
      sourceIds: [SOURCES[0]![0]],
      createdAt: new Date(NOW.getTime() - DAY),
      lastSeenAt: NOW,
    }),
    [storyId],
  );
}

/**
 * One reader per viewport, for the specs that spend a sign-out token.
 *
 * The tokens are unique and single-use, and the three projects run against this one
 * server at the same time, so a shared set of them would mean two of every three
 * viewports being told the link had already been used. That is the right answer and
 * the wrong thing to be testing, so each project gets its own User, its own two
 * Topics and its own brief carrying its own tokens.
 *
 * The brief goes on the per-Topic one rather than the other, so a spec spending the
 * per-Topic token stops a brief rather than stopping a subject nothing has been sent
 * about. Neither Topic carries a Cluster: nothing in those specs reads a brief's
 * contents, and one would only give the Archive another copy of the same fake news.
 */
for (const [project, reader] of Object.entries(E2E_UNSUBSCRIBE_FIXTURES)) {
  const userId = `e2e-reader-${project}`;
  insertReader({ userId, email: reader.email, sessionId: reader.sessionId });

  const topicIds: Record<string, string> = {};
  for (const [slug, title, category, origin] of [
    [
      E2E_UNSUBSCRIBE_OTHER_TOPIC_SLUG,
      E2E_UNSUBSCRIBE_OTHER_TOPIC_TITLE,
      'news',
      { kind: 'template', templateId: 'world-news' },
    ],
    [
      E2E_UNSUBSCRIBE_TOPIC_SLUG,
      E2E_UNSUBSCRIBE_TOPIC_TITLE,
      'unspecified',
      { kind: 'freeform' },
    ],
  ] as const satisfies readonly (readonly [string, string, TopicCategory, TopicOrigin])[]) {
    // Suffixed, because a Topic id is a primary key: two accounts cannot hold the
    // same one even though slugs are only unique per User.
    const topicId = `e2e-${project}-${slug}`;
    topicIds[slug] = topicId;
    await topicRepo.insert(
      makeTopic({
        id: topicId,
        slug,
        userId,
        title,
        category,
        origin,
        createdAt: new Date(NOW.getTime() - 30 * DAY),
      }),
    );
    for (const [position, [sourceId]] of SOURCES.entries()) {
      await topicRepo.insertTopicSource(topicId, sourceId, position);
    }
  }

  // The delivery. Its `cluster_ids` are empty, which is true of a brief written for a
  // Topic with nothing to say, and which the Archive reads back as a brief with no
  // Sources rather than as a row pointing at a Cluster that is not there.
  insert(
    `INSERT INTO brief_plans (id, topic_id, user_id, created_at, cluster_ids)
     VALUES (?, ?, ?, ?, '')`,
    `e2e-${project}-brief-plan-1`,
    topicIds[E2E_UNSUBSCRIBE_TOPIC_SLUG]!,
    userId,
    NOW.getTime() - DAY,
  );
  insert(
    `INSERT INTO brief_snapshots (id, brief_plan_id, user_id, topic_id, created_at, html, text, unsubscribe_token, global_unsubscribe_token)
     VALUES (?, ?, ?, ?, ?, '<p>A brief</p>', 'A brief', ?, ?)`,
    `e2e-${project}-snapshot-1`,
    `e2e-${project}-brief-plan-1`,
    userId,
    topicIds[E2E_UNSUBSCRIBE_TOPIC_SLUG]!,
    NOW.getTime() - DAY,
    reader.topicToken,
    reader.allToken,
  );
  insert(
    `INSERT INTO email_deliveries (id, user_id, brief_snapshot_id, topic_id, sent_at, unsubscribe_token, global_unsubscribe_token)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    `e2e-${project}-delivery-1`,
    userId,
    `e2e-${project}-snapshot-1`,
    topicIds[E2E_UNSUBSCRIBE_TOPIC_SLUG]!,
    NOW.getTime() - DAY,
    reader.topicToken,
    reader.allToken,
  );
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
 * A run of coverage on the day the Cluster above arrived, and a trickle before it.
 *
 * Two jobs. The run is what makes the day a spike worth annotating, and it is dated
 * to the Cluster's own `createdAt` so the annotation has a real Cluster to point at.
 * The trickle is the baseline the spike is measured against: without it every day
 * would be quiet and nothing would stand out. Each of these Articles is its own Story
 * so the LivingBrief keeps showing exactly one Article under the Cluster, which the
 * brief specs count.
 */
const ACME_ENTITY_ID = 'e2e-entity-acme' as EntityId;
await entityRepo.upsertByKey({
  id: ACME_ENTITY_ID,
  entity: { name: 'Acme Corp', key: 'acme corp', kind: 'org' },
});

/** Days before `NOW`, oldest first. */
const COVERAGE: readonly { readonly id: string; readonly daysAgo: number }[] = [
  ...Array.from({ length: 12 }, (_, i) => ({ id: `burst-${i}`, daysAgo: 1 })),
  ...Array.from({ length: 10 }, (_, i) => ({ id: `trickle-${i}`, daysAgo: 3 + i * 3 })),
];
for (const { id, daysAgo } of COVERAGE) {
  const publishedAt = new Date(NOW.getTime() - daysAgo * DAY);
  const storyId = `e2e-story-${id}` as StoryId;
  await storyRepo.insert({
    id: storyId,
    signature: EMPTY_SIGNATURE,
    firstSeenAt: publishedAt,
    lastSeenAt: publishedAt,
    published: { first: publishedAt, last: publishedAt },
  });
  await articleRepo.insert({
    article: {
      id: `e2e-article-${id}` as ArticleId,
      sourceId: SOURCES[0]![0],
      externalId: `ext-${id}`,
      url: `https://www.theguardian.com/${id}`,
      title: 'Acme Corp says something',
      body: 'Acme Corp was mentioned again, in a story nobody else carried.',
      publishedAt,
      ingestedAt: publishedAt,
      entities: [],
      signature: EMPTY_SIGNATURE,
      storyId,
    },
    entityIds: [ACME_ENTITY_ID],
  });
}

/**
 * The stored trends the specs read, written as rows rather than measured.
 *
 * A spec asserting that a chart draws a spike needs a spike to exist, and making one
 * happen through ingest would mean the spec was testing ingest too. These are the
 * same rows the hourly job writes, in the same shape, through the same service: the
 * server builds them with `TrendsService`, so a spec cannot pass against a trend the
 * real code would refuse to produce.
 */
const trendsService = new TrendsService({
  repo: new DrizzleTrendsRepo(db),
  clock: systemClock,
  random: nodeRandom,
});
await trendsService.refreshAll();

await registerHarnessRoutes(app, {
  driver,
  db,
  emailTransport,
  now: NOW,
});

await app.listen({ port: E2E_PORT, host: HOST });
console.log(
  `e2e: listening on ${E2E_BASE_URL} (session cookie ${SESSION_COOKIE_NAME}=${E2E_SESSION_ID})`,
);

const shutdown = async (): Promise<void> => {
  await app.close();
  driver.close();
  // Best effort: the throwaway database is in the OS temp directory, and a leftover
  // one costs nothing.
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignored
  }
  process.exit(0);
};
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
