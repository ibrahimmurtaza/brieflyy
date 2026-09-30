import { beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { EmailMessage } from '../email/transport.js';
import type { SqliteDriver } from '../db/client.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { topicOptOutAt, userOptOutAt } from '../testing/opt-outs.js';
import { makeCluster, makeTopic } from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from '../testing/test-clocks.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import type { TopicId, UserId } from '../domain/types.js';

const NOW = new Date('2026-09-02T12:00:00Z');
const APP_BASE_URL = 'https://app.brieflyy.test';

/**
 * The whole path a reader takes, with nothing faked: a signed-in User asks for a
 * brief by hand, the brief goes out through the real transport, and the tokens in
 * that email are what the routes below are given.
 *
 * Written as one harness rather than two because the whole point of the change is
 * the join: the routes are only worth anything if they accept the links a real
 * brief carries, and a test that minted its own tokens would pass whether or not
 * the renderer and the routes agreed about anything.
 */
interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly driver: SqliteDriver;
  readonly clock: TestClock;
  readonly userId: UserId;
  /** The token pair in the most recent brief's delivery. */
  sentTokens(): { topic: string; global: string };
  /** The message the brief went out as, headers and all. */
  sent(): EmailMessage;
  topicOptOut(topicId: string): Date | null;
  userOptOut(): Date | null;
  count(table: string): number;
}

let harness: Harness;

beforeEach(async () => {
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

  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(
      extractMagicLinkToken(transport.snapshot()[0]!.text),
    )}`,
  });
  const setCookie = verify.headers['set-cookie'];
  const cookie = (Array.isArray(setCookie) ? setCookie[0]! : setCookie!).split(';')[0]!;

  const topicRepo = new DrizzleTopicRepo(db);
  const clusterRepo = new DrizzleClusterRepo(db);
  const userId = (driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string })
    .id as UserId;
  // Two topics, because a per-Topic unsubscribe that stopped both would pass a
  // test written against one. Each gets a Cluster so the brief has something to
  // quote and the send really goes out.
  for (const id of ['topic-1', 'topic-2'] as const) {
    await topicRepo.insert(
      makeTopic({ id, userId, title: id === 'topic-1' ? 'World news' : 'Elections' }),
    );
    await topicRepo.insertTopicSource(id as TopicId, 'the-guardian', 0);
    await clusterRepo.insert(
      makeCluster({
        id: `cluster-${id}`,
        topicId: id,
        title: `A story on ${id}`,
        summary: 'It broke this morning.',
        bulletPoints: ['It broke this morning.'],
      }),
    );
  }

  harness = {
    app,
    cookie,
    driver,
    clock,
    userId,
    sentTokens: () => {
      const row = driver
        .prepare(
          `SELECT unsubscribe_token AS topic, global_unsubscribe_token AS global
           FROM email_deliveries ORDER BY rowid DESC LIMIT 1`,
        )
        .get() as { topic: string; global: string } | undefined;
      if (!row) throw new Error('no brief has been sent yet');
      return row;
    },
    userOptOut: (): Date | null => userOptOutAt(driver, userId),
    topicOptOut: (topicId: string): Date | null => topicOptOutAt(driver, topicId),
    sent: (): EmailMessage => {
      // The last brief, skipping the magic link that signed the User in.
      const briefs = transport.snapshot().filter((m) => m.html !== undefined);
      const last = briefs[briefs.length - 1];
      if (!last) throw new Error('no brief has been sent yet');
      return last;
    },
    count: (table: string): number =>
      (driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n,
  };
});

/** Ask for a brief of one Topic by hand, the way a User does from `/topics`. */
async function sendBrief(slug = 'topic-1'): Promise<void> {
  const res = await harness.app.inject({
    method: 'POST',
    url: `/topics/${slug}/send-brief`,
    headers: { cookie: harness.cookie },
    payload: '',
  });
  expect(res.statusCode).toBe(302);
}

describe('the links a brief carries', () => {
  it('are the paths the application serves, in both the body and the headers', async () => {
    await sendBrief();
    const { topic, global } = harness.sentTokens();

    // The brief's own footer, and the header a client reads instead of showing
    // those links. Both name the same two tokens, so either path a client takes
    // lands on a route that can spend them.
    const snapshot = harness.driver
      .prepare(`SELECT html FROM brief_snapshots LIMIT 1`)
      .get() as { html: string };
    expect(snapshot.html).toContain(`/unsubscribe/topic?token=${topic}`);
    expect(snapshot.html).toContain(`/unsubscribe/all?token=${global}`);

    const sent = harness.sent().headers ?? {};
    expect(sent['List-Unsubscribe']).toBe(
      `<${APP_BASE_URL}/unsubscribe/topic?token=${topic}>, <${APP_BASE_URL}/unsubscribe/all?token=${global}>`,
    );
    expect(sent['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });
});

describe('a one-click unsubscribe', () => {
  it('stops the topic when the mail client POSTs the header URL', async () => {
    await sendBrief();
    const { topic } = harness.sentTokens();

    // Exactly what RFC 8058 describes: the client POSTs to the URL it was given
    // in `List-Unsubscribe`, with no session and no page loaded.
    const res = await harness.app.inject({
      method: 'POST',
      url: `/unsubscribe/topic?token=${encodeURIComponent(topic)}`,
      payload: '',
    });

    expect(res.statusCode).toBe(200);
    expect(harness.topicOptOut('topic-1')).toEqual(NOW);
    // The rest of the mailbox keeps arriving.
    expect(harness.topicOptOut('topic-2')).toBeNull();
  });

  it('ends every brief when the global URL is POSTed', async () => {
    await sendBrief();
    const { global } = harness.sentTokens();

    const res = await harness.app.inject({
      method: 'POST',
      url: `/unsubscribe/all?token=${encodeURIComponent(global)}`,
      payload: '',
    });

    expect(res.statusCode).toBe(200);
    expect(harness.userOptOut()).toEqual(NOW);
  });

  it('records the unsubscribe against the delivery the link arrived in', async () => {
    await sendBrief();
    const { topic } = harness.sentTokens();

    await harness.app.inject({
      method: 'POST',
      url: `/unsubscribe/topic?token=${encodeURIComponent(topic)}`,
      payload: '',
    });

    const row = harness.driver
      .prepare(`SELECT scope, topic_id, email_delivery_id FROM unsubscribes`)
      .get() as { scope: string; topic_id: string; email_delivery_id: string } | undefined;
    expect(row?.scope).toBe('this_topic');
    expect(row?.topic_id).toBe('topic-1');
    const delivery = harness.driver
      .prepare(`SELECT id FROM email_deliveries LIMIT 1`)
      .get() as { id: string };
    expect(row?.email_delivery_id).toBe(delivery.id);
  });

  it('refuses a second POST of the same token', async () => {
    await sendBrief();
    const { topic } = harness.sentTokens();
    const url = `/unsubscribe/topic?token=${encodeURIComponent(topic)}`;

    expect(
      (await harness.app.inject({ method: 'POST', url, payload: '' })).statusCode,
    ).toBe(200);
    const second = await harness.app.inject({ method: 'POST', url, payload: '' });

    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('already been used');
    expect(harness.count('unsubscribes')).toBe(1);
  });

  it('refuses a token no brief was ever sent with', async () => {
    await sendBrief();

    const res = await harness.app.inject({
      method: 'POST',
      url: '/unsubscribe/topic?token=not-a-token-any-brief-carried',
      payload: '',
    });

    expect(res.statusCode).toBe(400);
    expect(harness.count('unsubscribes')).toBe(0);
    expect(harness.topicOptOut('topic-1')).toBeNull();
  });
});

describe('following the link in a browser', () => {
  it('unsubscribes on a GET, for a client with no one-click support', async () => {
    await sendBrief();
    const { topic } = harness.sentTokens();

    const res = await harness.app.inject({
      method: 'GET',
      url: `/unsubscribe/topic?token=${encodeURIComponent(topic)}`,
    });

    // A confirmation page naming the topic, and the state really changed —
    // a GET that rendered a page without unsubscribing would be a second dead
    // link wearing the costume of a working one.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('You have stopped World news briefs');
    expect(harness.topicOptOut('topic-1')).toEqual(NOW);
  });

  it('confirms the global unsubscribe on a GET too', async () => {
    await sendBrief();
    const { global } = harness.sentTokens();

    const res = await harness.app.inject({
      method: 'GET',
      url: `/unsubscribe/all?token=${encodeURIComponent(global)}`,
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('You have stopped all Brieflyy emails');
    expect(harness.userOptOut()).toEqual(NOW);
  });

  it('offers a way back, on the page the link lands on', async () => {
    await sendBrief();
    const { topic } = harness.sentTokens();

    const res = await harness.app.inject({
      method: 'GET',
      url: `/unsubscribe/topic?token=${encodeURIComponent(topic)}`,
    });

    // A control that can only turn something off is not a control. The page
    // points at the settings screen, and that screen is a real one.
    expect(res.body).toContain('href="/settings/briefs"');
    const settings = await harness.app.inject({
      method: 'GET',
      url: '/settings/briefs',
      headers: { cookie: harness.cookie },
    });
    expect(settings.statusCode).toBe(200);
  });

  it('says what happened rather than showing an error, when the token is spent', async () => {
    await sendBrief();
    const { topic } = harness.sentTokens();
    const url = `/unsubscribe/topic?token=${encodeURIComponent(topic)}`;
    await harness.app.inject({ method: 'GET', url });

    const again = await harness.app.inject({ method: 'GET', url });

    // A mail client that retries a one-click POST, or a reader who opened the
    // link twice, has not done anything wrong and should not be told they have.
    expect(again.statusCode).toBe(400);
    expect(again.body).toContain('already been used');
  });
});

describe('the settings screen', () => {
  it('shows the opt-out, and turns it back off again', async () => {
    await sendBrief();
    const { topic } = harness.sentTokens();
    await harness.app.inject({
      method: 'POST',
      url: `/unsubscribe/topic?token=${encodeURIComponent(topic)}`,
      payload: '',
    });

    const before = await harness.app.inject({
      method: 'GET',
      url: '/settings/briefs',
      headers: { cookie: harness.cookie },
    });
    expect(before.body).toContain('Briefs for this topic are off');
    expect(before.body).toContain('/settings/briefs/topic-1/resubscribe');

    const res = await harness.app.inject({
      method: 'POST',
      url: '/settings/briefs/topic-1/resubscribe',
      headers: { cookie: harness.cookie },
      payload: '',
    });

    expect(res.statusCode).toBe(302);
    expect(harness.topicOptOut('topic-1')).toBeNull();
  });

  it('shows the global opt-out, and turns every brief back on', async () => {
    await sendBrief();
    const { global } = harness.sentTokens();
    await harness.app.inject({
      method: 'POST',
      url: `/unsubscribe/all?token=${encodeURIComponent(global)}`,
      payload: '',
    });

    const before = await harness.app.inject({
      method: 'GET',
      url: '/settings/briefs',
      headers: { cookie: harness.cookie },
    });
    expect(before.body).toContain('You have stopped all Brieflyy emails');

    const res = await harness.app.inject({
      method: 'POST',
      url: '/settings/briefs/resubscribe',
      headers: { cookie: harness.cookie },
      payload: '',
    });

    expect(res.statusCode).toBe(302);
    expect(harness.userOptOut()).toBeNull();
  });

  it('refuses to resubscribe a topic that belongs to somebody else', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/settings/briefs/somebody-elses-topic/resubscribe',
      headers: { cookie: harness.cookie },
      payload: '',
    });

    expect(res.statusCode).toBe(404);
  });

  it('is not reachable without a session', async () => {
    const res = await harness.app.inject({ method: 'GET', url: '/settings/briefs' });
    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/signup');
  });
});

describe('asking for a brief by hand', () => {
  it('sends, while the User still wants the mail', async () => {
    const res = await harness.app.inject({
      method: 'POST',
      url: '/topics/topic-1/send-brief',
      headers: { cookie: harness.cookie },
      payload: '',
    });

    expect(res.headers.location).toBe('/topics/topic-1?brief=sent');
    expect(harness.count('email_deliveries')).toBe(1);
  });

  it('does not send once the Topic has been unsubscribed, and says why', async () => {
    await sendBrief();
    await harness.app.inject({
      method: 'POST',
      url: `/unsubscribe/topic?token=${encodeURIComponent(harness.sentTokens().topic)}`,
      payload: '',
    });
    const before = harness.count('email_deliveries');

    // The one path that could get around the daily job's filter. A User who has
    // asked not to be emailed and then presses a button asking to be emailed has
    // not unsubscribed — but the page must not offer the button, and the route
    // must not send, or the promise the confirmation page made is a lie.
    const res = await harness.app.inject({
      method: 'POST',
      url: '/topics/topic-1/send-brief',
      headers: { cookie: harness.cookie },
      payload: '',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toContain('/settings/briefs');
    expect(harness.count('email_deliveries')).toBe(before);

    const page = await harness.app.inject({
      method: 'GET',
      url: '/topics/topic-1',
      headers: { cookie: harness.cookie },
    });
    // The button is gone and says what to do instead: a control that always ends
    // in a refusal is worse than one that explains itself.
    expect(page.body).not.toContain('Email me this brief now');
    expect(page.body).toContain('You have stopped these emails');
  });

  it('does not send once the User has unsubscribed from everything', async () => {
    await sendBrief();
    await harness.app.inject({
      method: 'POST',
      url: `/unsubscribe/all?token=${encodeURIComponent(harness.sentTokens().global)}`,
      payload: '',
    });
    const before = harness.count('email_deliveries');

    const res = await harness.app.inject({
      method: 'POST',
      url: '/topics/topic-2/send-brief',
      headers: { cookie: harness.cookie },
      payload: '',
    });

    expect(res.statusCode).toBe(302);
    expect(harness.count('email_deliveries')).toBe(before);
  });

  it('sends again once the User has resubscribed', async () => {
    await sendBrief();
    await harness.app.inject({
      method: 'POST',
      url: `/unsubscribe/all?token=${encodeURIComponent(harness.sentTokens().global)}`,
      payload: '',
    });
    await harness.app.inject({
      method: 'POST',
      url: '/settings/briefs/resubscribe',
      headers: { cookie: harness.cookie },
      payload: '',
    });
    const before = harness.count('email_deliveries');

    const res = await harness.app.inject({
      method: 'POST',
      url: '/topics/topic-2/send-brief',
      headers: { cookie: harness.cookie },
      payload: '',
    });

    expect(res.headers.location).toBe('/topics/topic-2?brief=sent');
    expect(harness.count('email_deliveries')).toBe(before + 1);
  });
});
