import { describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import type { Db } from '../db/client.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { EmailTransport } from '../email/transport.js';
import { DrizzleAccountRepo } from '../repos/account-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleDeliverySettingsRepo } from '../repos/delivery-settings-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import {
  makeAccount,
  makeCluster,
  makeDeliverySettings,
  makeTopic,
  makeUser,
} from '../testing/fixtures.js';
import { deterministicRandom, makeTestClock, resetDeterministic } from '../testing/test-clocks.js';

/** Noon UTC on an ordinary day: eight in the morning UTC has already passed. */
const POLL_AT = new Date('2026-09-02T12:00:00Z');

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

/** A User who recorded a DeliveryTime, with a Topic for the job to brief. */
async function seedBriefableUser(db: Db): Promise<void> {
  const userRepo = new DrizzleUserRepo(db);
  await userRepo.insert(makeUser({ id: 'u1', onboardingState: 'completed' }));
  await new DrizzleAccountRepo(db).insert(
    makeAccount({ id: 'account-u1', userId: 'u1', email: 'iris@example.com' }),
  );
  await new DrizzleDeliverySettingsRepo(db).upsert(makeDeliverySettings({ userId: 'u1' }));
  const topicRepo = new DrizzleTopicRepo(db);
  await topicRepo.insert(makeTopic({ id: 'topic-1', userId: 'u1' }));
  await new DrizzleClusterRepo(db).insert(
    makeCluster({
      id: 'cluster-1',
      topicId: 'topic-1',
      title: 'A story',
      summary: 'It broke this morning.',
      bulletPoints: ['It broke this morning.'],
    }),
  );
}

async function buildApp(input: {
  readonly emailTransport?: EmailTransport;
  readonly briefIntervalMs?: number;
}): Promise<{ app: FastifyInstance; db: Db; driver: ReturnType<typeof createTestDb>['driver'] }> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  await seedBriefableUser(db);
  const app = await createApp({
    db,
    emailTransport: input.emailTransport ?? new ConsoleEmailTransport({ logger: () => {} }),
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(POLL_AT).clock,
    random: deterministicRandom,
    // What the server entrypoint passes: the job runs for the life of the app.
    briefJobAutoStart: true,
    briefIntervalMs: input.briefIntervalMs ?? 1,
  });
  return { app, db, driver };
}

describe('the brief job started by the application itself', () => {
  it('sends the briefs due without anything asking it to', async () => {
    const { app, driver } = await buildApp({});

    try {
      const sent = await waitFor(() => countRows(driver, 'brief_snapshots') >= 1, 10_000);
      expect(sent, 'the job never sent the brief on its own').toBe(true);
      expect(countRows(driver, 'email_deliveries')).toBe(1);
      expect(countRows(driver, 'brief_runs')).toBe(1);
    } finally {
      await app.close();
    }
  });

  it('waits for a pass in flight when the application closes', async () => {
    // This is the guarantee the signal handler leans on: the caller closes the
    // database as soon as close() resolves, and a pass abandoned halfway would be
    // a brief sent but never recorded as owed, or a row written against a closed
    // database.
    const gate: { release: (() => void) | null } = { release: null };
    const transport: EmailTransport = {
      providerName: 'gated',
      send: async () => {
        await new Promise<void>((resolve) => {
          gate.release = resolve;
        });
        return { id: 'gated-1', provider: 'gated' };
      },
    };
    const { app, driver } = await buildApp({ emailTransport: transport });

    const reached = await waitFor(() => gate.release !== null, 10_000);
    expect(reached, 'the job never started a pass').toBe(true);

    let closed = false;
    const closing = app.close().then(() => {
      closed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(closed, 'close() resolved while a pass was still in flight').toBe(false);

    gate.release!();
    await closing;

    expect(closed).toBe(true);
    expect(countRows(driver, 'email_deliveries')).toBe(1);
  });

  it('closes promptly even though the interval is long', async () => {
    // The interval is only ever waited out between passes, never during a
    // shutdown: a stop that only set a flag would leave the process alive for the
    // whole of it after a signal.
    const { app } = await buildApp({ briefIntervalMs: 30 * 60 * 1000 });

    const startedAt = Date.now();
    await app.close();

    expect(Date.now() - startedAt).toBeLessThan(5000);
  });

  it('leaves the job switched off when the application starts it switched off', async () => {
    // The default, and what every other test in the suite relies on: an
    // application built without the flag must not have a timer racing its
    // fixtures.
    resetDeterministic();
    const { db, driver } = createTestDb();
    await seedBriefableUser(db);
    const app = await createApp({
      db,
      emailTransport: new ConsoleEmailTransport({ logger: () => {} }),
      appBaseUrl: 'https://app.brieflyy.test',
      cookieSecure: false,
      clock: makeTestClock(POLL_AT).clock,
      random: deterministicRandom,
      briefJobAutoStart: false,
      briefIntervalMs: 1,
    });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(countRows(driver, 'brief_snapshots')).toBe(0);
    } finally {
      await app.close();
    }
  });
});