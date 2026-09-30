import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { SqliteDriver } from '../db/client.js';
import { createTestDb } from '../testing/test-db.js';
import { countRows } from '../testing/db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { makeCluster, makeTopic } from '../testing/fixtures.js';
import { createLLMSummaryClient } from '../services/llm-summary-service.js';
import type { LLMSummaryClient } from '../domain/llm.js';
import { RecordingSummaryClient } from '../testing/summary-client.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from '../testing/test-clocks.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import type { SourceId, StoryId, TopicId } from '../domain/types.js';

const NOW = new Date('2026-09-02T12:00:00Z');
const APP_BASE_URL = 'https://app.brieflyy.test';
/** The sentence the seeded Article carries and the Cluster quotes. */
const BULLET = 'The story broke this morning and it matters.';
const ARTICLE_URL = 'https://example.com/a-story-worth-reading';

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  /**
   * The one transport the application was built with. The magic link that signs
   * the User in goes through it, so a brief turning up in the same outbox is
   * the assertion that the brief reused the shared transport rather than opening
   * a second one.
   */
  readonly transport: ConsoleEmailTransport;
  readonly driver: SqliteDriver;
  readonly clusterRepo: DrizzleClusterRepo;
  readonly snapshotRepo: DrizzleBriefSnapshotRepo;
  readonly clock: TestClock;
  readonly userId: string;
  count(table: string): number;
  firstRow<T>(sql: string): T | undefined;
}

async function signInWithTopic(
  input: {
    readonly email?: string;
    readonly llmSummaryClient?: LLMSummaryClient | undefined;
  } = {},
): Promise<Harness> {
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
    ...(input.llmSummaryClient ? { llmSummaryClient: input.llmSummaryClient } : {}),
  });
  const email = input.email ?? 'iris@example.com';
  await app.inject({ method: 'POST', url: '/auth/magic-link/request', payload: { email } });
  const token = extractMagicLinkToken(transport.snapshot()[0]!.text);
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const setCookie = verify.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';')[0]!;

  const topicRepo = new DrizzleTopicRepo(db);
  const userId = (driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }).id;
  await topicRepo.insert(makeTopic({ id: 'topic-1', userId, title: 'World news' }));
  // The Topic follows the outlet its Article came from, which is what lets the
  // Cluster hold it: a Topic with no Sources has nothing to show.
  await topicRepo.insertTopicSource('topic-1' as TopicId, 'the-guardian', 0);

  // A Cluster with an Article behind it, because that is the only state a real
  // one is ever in, and the brief's bullets are quoted from those Articles —
  // with no Article there is nothing for a bullet's source link to point at,
  // and the interesting assertions would be vacuous.
  await new DrizzleStoryRepo(db).insert({
    id: 'story-1' as StoryId,
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
      'article-1',
      'the-guardian',
      'ext-1',
      ARTICLE_URL,
      'A story worth reading',
      BULLET,
      NOW.getTime(),
      NOW.getTime(),
      '{}',
      'story-1',
    );
  await new DrizzleClusterRepo(db).insert(
    makeCluster({
      id: 'c-1',
      topicId: 'topic-1',
      title: 'A story worth reading',
      summary: 'The story broke this morning and it matters.',
      bulletPoints: [BULLET],
      sourceIds: ['the-guardian'],
    }),
    ['story-1' as StoryId],
  );

  return {
    app,
    cookie,
    transport,
    driver,
    clusterRepo: new DrizzleClusterRepo(db),
    snapshotRepo: new DrizzleBriefSnapshotRepo(db),
    clock,
    userId,
    count: (table: string): number => countRows(driver, table),
    firstRow: <T,>(sql: string): T | undefined => driver.prepare(sql).get() as T | undefined,
  };
}

/** The brief messages, ignoring the magic link that signed the User in. */
function briefsSentTo(h: Harness): { subject: string; text: string; html?: string; to: string }[] {
  return h.transport.snapshot().filter((m) => m.subject.endsWith('- Brieflyy'));
}

function snapshotIdOf(h: Harness): string {
  return h.firstRow<{ id: string }>(`SELECT id FROM brief_snapshots LIMIT 1`)!.id;
}

async function sendBrief(h: Harness): Promise<void> {
  await h.app.inject({
    method: 'POST',
    url: '/topics/topic-1/send-brief',
    headers: { cookie: h.cookie },
  });
}

describe('HTTP: POST /topics/:slug/send-brief', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await signInWithTopic();
  });

  it('emails the User a brief of that Topic', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/topics/topic-1/send-brief',
      headers: { cookie: h.cookie },
    });

    expect(res.statusCode).toBe(302);
    const sent = briefsSentTo(h);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.to).toBe('iris@example.com');
    expect(sent[0]?.subject).toBe('World news - Brieflyy');
    expect(sent[0]?.text).toContain('A story worth reading');
    expect(sent[0]?.html).toContain('A story worth reading');
  });

  it('links every bullet it delivers, back to the Article it was quoted from', async () => {
    // The acceptance criterion is about the mail that arrives, not about a
    // renderer called directly, and the two are only the same thing as long as
    // the send path passes the Articles through. An unlinked bullet in a
    // delivered brief is a quotation a reader is asked to take on trust.
    await sendBrief(h);

    const sent = briefsSentTo(h)[0]!;
    expect(sent.html).toContain(`<a href="${ARTICLE_URL}" target="_blank" rel="noopener"`);
    expect(sent.html).toContain(`>${BULLET}</a>`);
    expect(sent.text).toContain(ARTICLE_URL);
  });

  it('goes out through the same transport the magic link did', async () => {
    await sendBrief(h);

    // One transport, not two. A second one would be configured separately, fail
    // separately, and in a test would leave the brief invisible to the only
    // outbox anybody was looking at.
    expect(h.transport.providerName).toBe('console');
    expect(h.transport.snapshot()).toHaveLength(2);
    expect(h.count('email_deliveries')).toBe(1);
  });

  it('persists the plan, the snapshot and the delivery', async () => {
    await sendBrief(h);

    expect(h.count('brief_plans')).toBe(1);
    expect(h.count('brief_snapshots')).toBe(1);
    expect(h.count('email_deliveries')).toBe(1);
  });

  it('records the delivery with the unsubscribe tokens the snapshot carries', async () => {
    await sendBrief(h);

    const snapshot = h.firstRow<{
      id: string;
      unsubscribe_token: string;
      global_unsubscribe_token: string;
    }>(`SELECT id, unsubscribe_token, global_unsubscribe_token FROM brief_snapshots LIMIT 1`)!;
    const delivery = h.firstRow<{
      brief_snapshot_id: string;
      unsubscribe_token: string;
      global_unsubscribe_token: string;
    }>(`SELECT brief_snapshot_id, unsubscribe_token, global_unsubscribe_token FROM email_deliveries LIMIT 1`)!;

    expect(delivery.brief_snapshot_id).toBe(snapshot.id);
    expect(delivery.unsubscribe_token).toBe(snapshot.unsubscribe_token);
    expect(delivery.global_unsubscribe_token).toBe(snapshot.global_unsubscribe_token);
  });

  it('does not send a brief for a Topic that is not the Users', async () => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/topics/somebody-elses-topic/send-brief',
      headers: { cookie: h.cookie },
    });

    expect(res.statusCode).toBe(404);
    expect(briefsSentTo(h)).toEqual([]);
  });

  it('needs a session', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/topics/topic-1/send-brief' });

    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/signup');
    expect(briefsSentTo(h)).toEqual([]);
  });

  it('sends a second brief as a second plan, snapshot and delivery', async () => {
    await sendBrief(h);
    h.clock.advance(60_000);
    await sendBrief(h);

    expect(briefsSentTo(h)).toHaveLength(2);
    expect(h.count('brief_plans')).toBe(2);
    expect(h.count('brief_snapshots')).toBe(2);
    expect(h.count('email_deliveries')).toBe(2);
  });
});

describe('HTTP: a brief with a configured summary client', () => {
  it('stores the written text on the snapshot and never asks for it again', async () => {
    // A BriefSnapshot is what was sent, so the written text is part of the
    // document and not a recipe for rebuilding it: a User who opens a brief in
    // six months reads the words they were sent, whatever the Clusters and the
    // provider have done since.
    const client = new RecordingSummaryClient();
    const h = await signInWithTopic({ llmSummaryClient: client });

    await sendBrief(h);

    const sent = briefsSentTo(h)[0]!;
    expect(sent.html).toContain('Written summary of A story worth reading');
    expect(sent.html).toContain(`<a href="${ARTICLE_URL}" target="_blank" rel="noopener"`);
    expect(sent.html).toContain('>A written point.</a>');
    expect(sent.text).toContain('Written summary of A story worth reading');
    expect(client.callCount).toBe(1);

    const stored = h.firstRow<{ html: string; text: string }>(
      `SELECT html, text FROM brief_snapshots LIMIT 1`,
    )!;
    expect(stored.html).toBe(sent.html);
    expect(stored.text).toBe(sent.text);

    const viewed = await h.app.inject({
      method: 'GET',
      url: `/briefs/${snapshotIdOf(h)}`,
      headers: { cookie: h.cookie },
    });
    expect(viewed.statusCode).toBe(200);
    expect(viewed.body).toContain('Written summary of A story worth reading');
    expect(client.callCount).toBe(1);
  });

  it('keeps the count of what writing cost out of the brief it delivered', async () => {
    // The counters are how a pass of the job says whether the written path ran.
    // A BriefSnapshot is stored and served forever, so a number about how the
    // machine built it has no business being in it — a User reading a brief from
    // six months ago is reading the brief, not a build log. Asserted against the
    // labels the status view uses, because "Clusters written: 1" would pass a
    // test that only looked for the word "discarded".
    const h = await signInWithTopic({ llmSummaryClient: new RecordingSummaryClient() });

    await sendBrief(h);

    const sent = briefsSentTo(h)[0]!;
    for (const label of ['Clusters written', 'Write calls', 'Bullets discarded']) {
      expect(sent.html, label).not.toContain(label);
      expect(sent.text, label).not.toContain(label);
    }
  });

  it('records what the send cost on the delivery, not on the brief', async () => {
    // The row that has to carry it, and the reason the daily job is not the only
    // one that can: this brief was sent by hand, from a button, and the job never
    // heard of it. Without this a brief an operator triggered by hand would be
    // the one brief whose cost nothing recorded.
    const h = await signInWithTopic({ llmSummaryClient: new RecordingSummaryClient() });

    await sendBrief(h);

    const row = h.firstRow<{
      written_clusters: number;
      generation_calls: number;
      discarded_bullets: number;
      html_has_report: number;
    }>(
      `SELECT written_clusters, generation_calls, discarded_bullets,
              (instr(brief_snapshots.html, 'Clusters written') > 0) AS html_has_report
       FROM email_deliveries JOIN brief_snapshots
         ON brief_snapshots.id = email_deliveries.brief_snapshot_id
       LIMIT 1`,
    );
    expect(row?.written_clusters).toBe(1);
    expect(row?.generation_calls).toBe(1);
    expect(row?.discarded_bullets).toBe(0);
    expect(row?.html_has_report).toBe(0);
  });

  it('leaves the LivingBrief on the extractive summary', async () => {
    // The design decision the glossary records: a Cluster summary is quoted, and
    // what is written is written once, into a snapshot that does not change. The
    // page a User browses would otherwise say one thing and the email they were
    // sent said another, for the same Cluster, on the same day.
    const client = new RecordingSummaryClient();
    const h = await signInWithTopic({ llmSummaryClient: client });
    await sendBrief(h);

    const page = await h.app.inject({
      method: 'GET',
      url: '/topics/topic-1',
      headers: { cookie: h.cookie },
    });

    expect(page.body).toContain('The story broke this morning and it matters.');
    expect(page.body).not.toContain('Written summary of');
    expect(page.body).not.toContain('A written point.');
    // And the page never paid for one either.
    expect(client.callCount).toBe(1);
  });

  it('emails a complete brief with no client at all, having asked for nothing', async () => {
    // The state a deployment with no credential is in. The client is resolved
    // the way the entrypoint resolves it, and the brief that comes out the other
    // end is a brief, not an absence of one.
    expect(createLLMSummaryClient({ env: {} })).toBeNull();

    const h = await signInWithTopic({
      llmSummaryClient: createLLMSummaryClient({ env: {} }) ?? undefined,
    });
    await sendBrief(h);

    const sent = briefsSentTo(h)[0]!;
    expect(sent.subject).toBe('World news - Brieflyy');
    expect(sent.html).toContain('The story broke this morning and it matters.');
    expect(sent.html).toContain(`>${BULLET}</a>`);
    expect(h.count('brief_snapshots')).toBe(1);
  });
});

describe('HTTP: /topics/:slug after a brief is sent', () => {
  it('says the brief was sent, and offers to send another', async () => {
    const h = await signInWithTopic();
    await sendBrief(h);

    const page = await h.app.inject({
      method: 'GET',
      url: '/topics/topic-1?brief=sent',
      headers: { cookie: h.cookie },
    });

    expect(page.body).toMatch(/sent to iris@example\.com/);
    expect(page.body).toContain('action="/topics/topic-1/send-brief"');
  });

  it('links to the briefs this Topic has already sent', async () => {
    const h = await signInWithTopic();
    await sendBrief(h);

    const page = await h.app.inject({
      method: 'GET',
      url: '/topics/topic-1',
      headers: { cookie: h.cookie },
    });

    expect(page.body).toContain(`href="/briefs/${snapshotIdOf(h)}"`);
  });

  it('offers to send a brief even when nothing has been sent yet', async () => {
    const h = await signInWithTopic();

    const page = await h.app.inject({
      method: 'GET',
      url: '/topics/topic-1',
      headers: { cookie: h.cookie },
    });

    expect(page.body).toContain('action="/topics/topic-1/send-brief"');
  });
});

describe('HTTP: /briefs/:id', () => {
  it('serves the stored brief, not a fresh rendering of it', async () => {
    const h = await signInWithTopic();
    await sendBrief(h);
    const id = snapshotIdOf(h);
    const stored = await h.snapshotRepo.findByIdForUser(h.userId, id);

    const res = await h.app.inject({
      method: 'GET',
      url: `/briefs/${id}`,
      headers: { cookie: h.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toBe(stored?.html);
  });

  it('serves the stored brief even after the Topic has moved on', async () => {
    const h = await signInWithTopic();
    await sendBrief(h);
    const id = snapshotIdOf(h);
    // The Cluster a brief was built from stops being active. A page that
    // re-rendered the brief would now be showing something else.
    await h.clusterRepo.archiveExcluding('topic-1' as never, [], new Date('2026-09-03T00:00:00Z'));

    const res = await h.app.inject({
      method: 'GET',
      url: `/briefs/${id}`,
      headers: { cookie: h.cookie },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('A story worth reading');
  });

  it('carries its own way back into the application', async () => {
    // This page is the one place a document is served without `layout()`: the
    // brief is served exactly as it was emailed, because a BriefSnapshot is
    // what was sent and re-wrapping it would be a different document. The shell
    // is what stops a User being stranded on a page with no navigation, so the
    // thing the shell would have given them is asserted here instead.
    const h = await signInWithTopic();
    await sendBrief(h);

    const res = await h.app.inject({
      method: 'GET',
      url: `/briefs/${snapshotIdOf(h)}`,
      headers: { cookie: h.cookie },
    });

    expect(res.body).toContain(`href="${APP_BASE_URL}/topics/topic-1"`);
    expect(res.body).toContain(`href="${APP_BASE_URL}/topics"`);
  });

  it('is not found for a User the brief is not theirs', async () => {
    const h = await signInWithTopic();
    await sendBrief(h);
    const id = snapshotIdOf(h);

    const other = await signInWithTopic({ email: 'omar@example.com' });
    const res = await other.app.inject({
      method: 'GET',
      url: `/briefs/${id}`,
      headers: { cookie: other.cookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it('is not found for an id that is not a brief', async () => {
    const h = await signInWithTopic();
    const res = await h.app.inject({
      method: 'GET',
      url: '/briefs/there-is-no-such-brief',
      headers: { cookie: h.cookie },
    });

    expect(res.statusCode).toBe(404);
  });

  it('needs a session', async () => {
    const h = await signInWithTopic();
    await sendBrief(h);

    const res = await h.app.inject({ method: 'GET', url: `/briefs/${snapshotIdOf(h)}` });

    expect(res.statusCode).toBe(302);
    expect(res.headers['location']).toBe('/signup');
  });
});
