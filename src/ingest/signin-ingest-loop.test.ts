/**
 * What a User does makes an ingest cycle happen.
 *
 * Three moments: signing in, picking Topics, and following one more Source. The
 * interval loop is the floor between them, not the only thing that runs one.
 *
 * Ingest is fire-and-forget from the request — a cycle polls every Source in the
 * registry and cannot be held behind a redirect — so what these tests watch is
 * when a cycle *starts*, and that starting one does not hold the request open.
 */
import { afterEach, describe, expect, it } from 'vitest';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { SeededFeedFetcher } from '../testing/app-harness.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import { dayKey } from '../domain/trends.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from '../testing/test-clocks.js';
import type { FeedFetcher, RawFeed } from './feed-fetcher.js';

const NOW = new Date('2026-09-02T12:00:00Z');

/** One story from each of two Sources, so a cycle that ran shows in a count. */
const FEEDS: Readonly<Record<string, RawFeed>> = {
  'https://www.theguardian.com/world/rss': {
    entries: [
      {
        externalId: 'g-a1',
        url: 'https://www.theguardian.com/acme-1',
        title: 'Acme Corp launches new AI product',
        body: 'Acme Corp today unveiled a new AI product called Foo. Analysts said the launch changes the landscape for enterprise customers.',
        publishedAt: new Date('2026-09-02T10:00:00Z'),
      },
    ],
  },
  'https://feeds.bbci.co.uk/news/rss.xml': {
    entries: [
      {
        externalId: 'b-b1',
        url: 'https://www.bbc.co.uk/news/brandx-1',
        title: 'BrandX Inc acquires TinyCo',
        body: 'BrandX Inc announced today that it acquired TinyCo for $2B. The deal closed on Tuesday.',
        publishedAt: new Date('2026-09-02T10:40:00Z'),
      },
    ],
  },
};

/**
 * The Sources this file's fetcher can serve.
 *
 * A Template is chosen by the Sources it names rather than by its position in the
 * Directory, because a cycle reaches for every Source the picked Topics name. One
 * naming a Source this fetcher has no answer for would fail that Source's poll, and
 * the Article counts below would then be a fact about the Directory's ordering
 * rather than about when ingest ran.
 */
const SERVED_SOURCES: ReadonlySet<string> = new Set(['the-guardian', 'bbc-news']);

const CYCLE_TIMEOUT_MS = 5000;
/** Long enough that a cycle over two Sources would certainly have finished. */
const SETTLE_MS = 250;

interface Harness {
  readonly app: Awaited<ReturnType<typeof buildApp>>['app'];
  readonly driver: Awaited<ReturnType<typeof buildApp>>['driver'];
  readonly transport: ConsoleEmailTransport;
  /** Movable, because the window under test is a day boundary and not an offset. */
  readonly clock: TestClock;
}

async function buildApp(feedFetcher?: FeedFetcher) {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clock = makeTestClock(NOW);
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: clock.clock,
    random: deterministicRandom,
    feedFetcher: feedFetcher ?? new SeededFeedFetcher(FEEDS),
  });
  return { app, driver, db, transport, clock };
}

function countRows(h: Harness, table: string): number {
  return (
    h.driver.prepare(`SELECT count(*) AS c FROM "${table}"`).get() as { c: number }
  ).c;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a condition the cycle will satisfy on its own, if it is running. */
async function waitUntil(what: string, predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + CYCLE_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(10);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** Waits for the cycle a User action started, which the request did not. */
async function waitForArticles(h: Harness, expected: number): Promise<void> {
  await waitUntil(`${expected} articles`, () => countRows(h, 'articles') === expected);
}

/** Gives a cycle that is not coming the time it would have needed to arrive. */
function settle(): Promise<void> {
  return sleep(SETTLE_MS);
}

/**
 * Empties the corpus so that Articles appearing again can only mean a cycle ran.
 *
 * Stories go with Articles because a Story is derived from the Articles that
 * mention it, and leaving them behind would let a re-ingest look like work when
 * nothing had actually been read.
 */
function clearCorpus(h: Harness): void {
  h.driver.prepare('DELETE FROM "stories"').run();
  h.driver.prepare('DELETE FROM "articles"').run();
}

async function signIn(h: Harness): Promise<string> {
  await h.app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  const sent = h.transport.snapshot();
  const token = extractMagicLinkToken(sent[sent.length - 1]!.text);
  const response = await h.app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  expect(response.statusCode).toBe(302);
  const raw = response.headers['set-cookie'];
  const first = Array.isArray(raw) ? raw[0]! : raw!;
  return first.split(';')[0]!;
}

/**
 * Picks Topics through the picker rather than through the repository.
 *
 * Picking is where the corpus first becomes readable for a User, so a test about
 * when ingest runs has to go through it: writing a Topic with the repository would
 * skip the very call under test.
 */
async function pickTopics(h: Harness): Promise<number> {
  const sessionCookie = await signIn(h);
  const { cookies } = await signedInCookies(h.app, sessionCookie);
  const templates = (await h.app.inject({
    method: 'GET',
    url: '/api/onboarding/templates',
    headers: { cookie: cookies },
  })).json() as { templates: { id: string; defaultSourceIds: string[] }[] };
  const pickable = templates.templates.filter((t) =>
    t.defaultSourceIds.every((s) => SERVED_SOURCES.has(s)),
  );
  // The picker takes exactly INITIAL_TOPIC_COUNT or it answers `wrong_count`, so a
  // test that picks fewer would be testing the picker's arity rather than ingest.
  expect(
    pickable.length,
    'fewer Directory Templates use only the Sources this file serves than the picker takes',
  ).toBeGreaterThanOrEqual(3);
  const response = await submitForm(h.app, cookies, '/onboarding/pick-topics', {
    templateIds: pickable.slice(0, 3).map((t) => t.id),
  });
  return response.statusCode;
}

describe('HTTP: a User action runs an ingest cycle', () => {
  const open: Harness[] = [];
  afterEach(async () => {
    for (const h of open.splice(0)) await h.app.close();
  });

  it('polls nothing while no Topic names a Source, and still signs the User in', async () => {
    const built = await buildApp();
    const h: Harness = built;
    open.push(h);

    await signIn(h);
    await settle();

    // The sign-in that starts onboarding happens before any Topic exists, so the
    // cycle it runs has no Source to read. That is not a failure, and it must not
    // read as one: the User still has a session.
    expect(countRows(h, 'articles')).toBe(0);
    expect(countRows(h, 'users')).toBe(1);
  });

  it('ingests the feeds as soon as the picker writes the Topics', async () => {
    const built = await buildApp();
    const h: Harness = built;
    open.push(h);

    await signIn(h);
    await settle();
    expect(countRows(h, 'articles')).toBe(0);

    // Picking is the first moment the corpus is readable, and is what the User was
    // waiting on when they signed in — so this, not the sign-in, is the trigger.
    expect(await pickTopics(h)).toBe(302);

    await waitForArticles(h, 2);
    expect(countRows(h, 'articles')).toBe(2);
    expect(countRows(h, 'stories')).toBe(2);
  });

  it('runs a cycle for a sign-in later on the day the account was created', async () => {
    const built = await buildApp();
    const h: Harness = built;
    open.push(h);

    await signIn(h);
    await pickTopics(h);
    await waitForArticles(h, 2);

    // Clear the Articles so a cycle that ran would be obvious, and move past the
    // six-hour backoff so the Sources are due again — otherwise a cycle would run
    // and correctly do nothing, and the test would pass for the wrong reason.
    clearCorpus(h);
    h.clock.advance(8 * 60 * 60 * 1000);
    expect(dayKey(h.clock.clock.now())).toBe(dayKey(new Date(NOW)));

    await signIn(h);
    await waitForArticles(h, 2);
  });

  it('leaves a sign-in the day after sign-up to the loop', async () => {
    const built = await buildApp();
    const h: Harness = built;
    open.push(h);

    await signIn(h);
    await pickTopics(h);
    await waitForArticles(h, 2);

    // Clear the Articles so a cycle that ran would be obvious, then cross midnight
    // UTC. The account's Topics are unchanged and still readable — the only thing
    // that changed is the date, and that is the whole claim being tested.
    clearCorpus(h);
    h.clock.set(new Date('2026-09-03T00:00:01Z'));
    expect(dayKey(h.clock.clock.now())).toBe('2026-09-03');
    expect(dayKey(new Date(NOW))).toBe('2026-09-02');

    await signIn(h);
    await settle();

    // Past their first day the six-hour loop is what keeps a Reader fresh, and a
    // sign-in is not a reason to run a second cycle on top of it.
    expect(countRows(h, 'articles')).toBe(0);
    expect(countRows(h, 'users')).toBe(1);
  });

  it('answers the picker while the cycle it started is still running', async () => {
    // A fetcher that parks inside every poll until the gate opens, so the cycle is
    // provably in flight — and provably not finished — when the picker's response
    // is due. The gate is a latch rather than a single release because a cycle
    // polls one Source at a time and would otherwise park on the second one.
    let openGate: () => void = () => {};
    const parked = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    let serving = false;
    const parking: FeedFetcher = {
      async fetch(url: string) {
        serving = true;
        await parked;
        return FEEDS[url]!;
      },
    };
    const built = await buildApp(parking);
    const h: Harness = built;
    open.push(h);

    await signIn(h);
    await settle();

    const picking = pickTopics(h);
    await waitUntil('the picker to start a cycle', () => serving);

    // If the route awaited the cycle this could not resolve until the gate opens,
    // so racing it is the assertion: the 302 is answered with the cycle still parked.
    const answered = await Promise.race([
      picking,
      sleep(2000).then(() => 'still-waiting' as const),
    ]);
    expect(answered, 'the picker blocked on the cycle it started').toBe(302);

    openGate();
    await waitForArticles(h, 2);
  }, 15000);
});
