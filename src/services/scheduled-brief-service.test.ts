import { beforeEach, describe, expect, it } from 'vitest';

import { ScheduledBriefService } from './scheduled-brief-service.js';
import { BriefPlanService } from './brief-plan-service.js';
import { BriefSnapshotRenderer } from './brief-snapshot-renderer.js';
import { DrizzleAccountRepo } from '../repos/account-repo.js';
import { DrizzleBriefJobRunRepo } from '../repos/brief-job-run-repo.js';
import { DrizzleBriefPlanRepo } from '../repos/brief-plan-repo.js';
import { DrizzleBriefRunRepo } from '../repos/brief-run-repo.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleDeliverySettingsRepo } from '../repos/delivery-settings-repo.js';
import { DrizzleEmailDeliveryRepo } from '../repos/email-delivery-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { EmailTransport } from '../email/transport.js';
import { createTestDb } from '../testing/test-db.js';
import { countRows } from '../testing/db.js';
import {
  makeAccount,
  makeCluster,
  makeDeliverySettings,
  makeTopic,
  makeUser,
} from '../testing/fixtures.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
  type TestClock,
} from '../testing/test-clocks.js';
import type { Cadence, Tier, TopicId, UserId } from '../domain/types.js';
import type { DeliveryTime } from '../domain/timezone.js';

const APP_BASE_URL = 'https://app.brieflyy.test';
const NOW = new Date('2026-09-02T12:00:00Z');
/** Long enough ago that no reading in a test is bounded by it unless it says so. */
const RECORDED = new Date('2026-01-01T00:00:00Z');

interface Harness {
  readonly scheduler: ScheduledBriefService;
  readonly transport: ConsoleEmailTransport;
  readonly clusterRepo: DrizzleClusterRepo;
  readonly topicRepo: DrizzleTopicRepo;
  readonly accountRepo: DrizzleAccountRepo;
  readonly userRepo: DrizzleUserRepo;
  readonly settingsRepo: DrizzleDeliverySettingsRepo;
  readonly briefRunRepo: DrizzleBriefRunRepo;
  readonly clock: TestClock;
count(table: string): number;
  /** The same job with different options, for the paths they open up. */
  schedulerWith(transport: EmailTransport, overrides?: { retainedRuns?: number }): ScheduledBriefService;
}

let harness: Harness;

beforeEach(() => {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const clock = makeTestClock(NOW);
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const clusterRepo = new DrizzleClusterRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const accountRepo = new DrizzleAccountRepo(db);
  const userRepo = new DrizzleUserRepo(db);
  const settingsRepo = new DrizzleDeliverySettingsRepo(db);
  const briefRunRepo = new DrizzleBriefRunRepo(db);
  const briefJobRunRepo = new DrizzleBriefJobRunRepo(db);

const schedulerWith = (
    over: EmailTransport,
    overrides: { retainedRuns?: number } = {},
  ): ScheduledBriefService =>
    new ScheduledBriefService({
      briefPlanService: new BriefPlanService({
        clusterRepo,
        briefPlanRepo: new DrizzleBriefPlanRepo(db),
        briefSnapshotRepo: new DrizzleBriefSnapshotRepo(db),
        emailDeliveryRepo: new DrizzleEmailDeliveryRepo(db),
        renderer: new BriefSnapshotRenderer({ clusterRepo, topicRepo }),
        emailTransport: over,
        appBaseUrl: APP_BASE_URL,
        clock: clock.clock,
        random: deterministicRandom,
      }),
      briefRunRepo,
      briefJobRunRepo,
      deliverySettingsRepo: settingsRepo,
      topicRepo,
      accountRepo,
      emailTransport: over,
      clock: clock.clock,
      random: deterministicRandom,
      intervalMs: 60_000,
      ...overrides,
    });

  harness = {
    scheduler: schedulerWith(transport),
    transport,
    clusterRepo,
    topicRepo,
    accountRepo,
    userRepo,
    settingsRepo,
    briefRunRepo,
    clock,
    count: (table: string): number => countRows(driver, table),
    schedulerWith,
  };
});

interface SeedUserInput {
  readonly id: string;
  readonly email?: string;
  /** What the User recorded at onboarding. Eight in the morning UTC unless told otherwise. */
  readonly deliveryTime?: DeliveryTime;
  readonly deliveryRecordedAt?: Date;
  readonly tier?: Tier;
  /** Omit to leave the User with no DeliveryTime at all. */
  readonly withoutDeliveryTime?: boolean;
}

/**
 * A User with an Account and, unless told otherwise, a recorded DeliveryTime —
 * which is the whole of what the job reads to decide anyone is owed a brief.
 */
async function seedUser(input: SeedUserInput): Promise<void> {
  await harness.userRepo.insert(
    makeUser({
      id: input.id,
      onboardingState: 'completed',
      ...(input.tier ? { tier: input.tier } : {}),
    }),
  );
  await harness.accountRepo.insert(
    makeAccount({
      id: `account-${input.id}`,
      userId: input.id,
      email: input.email ?? `${input.id}@example.com`,
      emailVerifiedAt: NOW,
    }),
  );
  if (input.withoutDeliveryTime === true) return;
  const deliveryTime = input.deliveryTime ?? {
    hour: 8,
    minute: 0,
    timezone: 'UTC',
  };
  await harness.settingsRepo.upsert(
    makeDeliverySettings({
      userId: input.id,
      hour: deliveryTime.hour,
      minute: deliveryTime.minute,
      timezone: deliveryTime.timezone,
      welcomeSentAt: NOW,
      updatedAt: input.deliveryRecordedAt ?? RECORDED,
    }),
  );
}

/** A Topic with a Cluster on it, since a brief with nothing to quote is not worth sending. */
async function seedTopic(
  userId: string,
  topicId: string,
  overrides: { readonly cadence?: Cadence; readonly title?: string } = {},
): Promise<void> {
  await harness.topicRepo.insert(
    makeTopic({
      id: topicId,
      userId,
      title: overrides.title ?? `Topic ${topicId}`,
      ...(overrides.cadence ? { cadence: overrides.cadence } : {}),
    }),
  );
  await harness.clusterRepo.insert(
    makeCluster({
      id: `cluster-${topicId}`,
      topicId,
      title: `A story on ${topicId}`,
      summary: 'It broke this morning.',
      bulletPoints: ['It broke this morning.'],
    }),
  );
}

/** Every address the job has sent to, in order. */
function recipients(): readonly string[] {
  return harness.transport.snapshot().map((message) => message.to);
}

describe('ScheduledBriefService.run', () => {
  it('sends a brief to a User whose DeliveryTime has arrived in their timezone', async () => {
    // 08:00 in Auckland on 2 September is 20:00 UTC on 1 September, so at noon UTC
    // this User's morning has come and gone — a day behind the server's date.
    await seedUser({
      id: 'auckland',
      email: 'iris@example.com',
      deliveryTime: { hour: 8, minute: 0, timezone: 'Pacific/Auckland' },
    });
    await seedTopic('auckland', 'topic-auckland');

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(1);
    expect(recipients()).toEqual(['iris@example.com']);
    expect(harness.count('email_deliveries')).toBe(1);
  });

  it('sends one brief per daily-Cadence Topic of the User', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one', { title: 'World news' });
    await seedTopic('iris', 'topic-two', { title: 'Elections' });

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(2);
    expect(harness.count('brief_snapshots')).toBe(2);
    const subjects = harness.transport.snapshot().map((m) => m.subject);
    expect(subjects).toEqual(['World news - Brieflyy', 'Elections - Brieflyy']);
  });

it('leaves a User alone until their DeliveryTime comes round', async () => {
    await seedUser({
      id: 'iris',
      deliveryTime: { hour: 23, minute: 0, timezone: 'UTC' },
      deliveryRecordedAt: NOW,
    });
    await seedTopic('iris', 'topic-one');

    expect((await harness.scheduler.run()).sentCount).toBe(0);

    // The same User, after their reading has come round.
    harness.clock.set(new Date('2026-09-02T23:30:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(1);

    const [served] = await harness.briefRunRepo.listByUser('iris');
    expect(served?.scheduledFor).toEqual(new Date('2026-09-02T23:00:00Z'));
  });

  it('serves a User ahead of the server and one behind it in the same pass', async () => {
    await seedUser({
      id: 'tokyo',
      email: 'tokyo@example.com',
      deliveryTime: { hour: 8, minute: 0, timezone: 'Asia/Tokyo' },
    });
await seedUser({
      id: 'los-angeles',
      email: 'la@example.com',
      deliveryTime: { hour: 8, minute: 0, timezone: 'America/Los_Angeles' },
      deliveryRecordedAt: new Date('2026-09-01T00:00:00Z'),
    });
    await seedTopic('tokyo', 'topic-tokyo');
    await seedTopic('los-angeles', 'topic-la');

    const run = await harness.scheduler.run();

// The Los Angeles User recorded their reading the day before and had not been
    // served the 08:00 DeliverySlot that came while the process was down; the Tokyo User is
    // a day ahead of the server's own date. Each is answered on their own clock.
    expect(run.sentCount).toBe(2);
    expect([...recipients()].sort()).toEqual(['la@example.com', 'tokyo@example.com']);
    const slots = (await harness.briefRunRepo.listByUser('tokyo'))
      .concat(await harness.briefRunRepo.listByUser('los-angeles'))
      .map((r) => r.scheduledFor.toISOString())
      .sort();
    expect(slots).toEqual(['2026-09-01T15:00:00.000Z', '2026-09-01T23:00:00.000Z']);
  });

  it('uses the one DeliveryTime recorded at onboarding for every Topic', async () => {
    await seedUser({
      id: 'iris',
      deliveryTime: { hour: 6, minute: 45, timezone: 'Europe/Berlin' },
    });
    await seedTopic('iris', 'topic-one');
    await seedTopic('iris', 'topic-two');

    await harness.scheduler.run();

    const runs = await harness.briefRunRepo.listByUser('iris');
    expect(runs).toHaveLength(2);
    // 06:45 at UTC+2 in September is 04:45 UTC, and both Topics answer to it.
    for (const run of runs) {
      expect(run.scheduledFor).toEqual(new Date('2026-09-02T04:45:00Z'));
    }
  });

it('keeps the DeliverySlot on the local day it belongs to across a daylight-saving change', async () => {
    // 8 March 2026: America/New_York jumps 02:00 to 03:00. A User who asked for
    // 02:30 is owed a brief that day even though 02:30 never happened.
    await seedUser({
      id: 'iris',
      deliveryTime: { hour: 2, minute: 30, timezone: 'America/New_York' },
    });
    await seedTopic('iris', 'topic-dst');
    harness.clock.set(new Date('2026-03-08T12:00:00Z'));

    const first = await harness.scheduler.run();
    expect(first.sentCount).toBe(1);
    // The day after the clocks go forward, the reading is a real time again.
    harness.clock.set(new Date('2026-03-09T12:00:00Z'));
    const second = await harness.scheduler.run();

    expect(second.sentCount).toBe(1);
    const slots = (await harness.briefRunRepo.listByUser('iris')).map((r) =>
      r.scheduledFor.toISOString(),
    );
    // Most recent first, which is the order a User reading their own brief history
    // wants them in.
    expect(slots).toEqual(['2026-03-09T06:30:00.000Z', '2026-03-08T07:30:00.000Z']);
  });

  it('delivers on the spring-forward morning east of UTC too', async () => {
    // 29 March 2026: Europe/Berlin jumps 02:00 to 03:00 an hour earlier in the day
    // than New York does, so a reading that is skipped there is skipped while UTC is
    // still on the previous evening. A User here must still get one brief that day,
    // at the reading's own place in the morning rather than an hour before it.
    await seedUser({
      id: 'iris',
      deliveryTime: { hour: 2, minute: 30, timezone: 'Europe/Berlin' },
      deliveryRecordedAt: new Date('2026-03-29T00:00:00Z'),
    });
    await seedTopic('iris', 'topic-dst');

    // Nothing is owed before the change: the reading has not been passed yet.
    harness.clock.set(new Date('2026-03-29T00:45:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(0);

    harness.clock.set(new Date('2026-03-29T12:00:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(1);

    const [served] = await harness.briefRunRepo.listByUser('iris');
    // 03:30 local — the same reading of the morning that New York's would be.
    expect(served?.scheduledFor).toEqual(new Date('2026-03-29T01:30:00Z'));
  });

  it('sends once on the morning the clocks go back', async () => {
    // 1 November 2026: America/New_York repeats 01:00 to 02:00, so 01:30 happens
    // twice. Both moments resolve to the same DeliverySlot, and the second is
    // already served.
    await seedUser({
      id: 'iris',
      deliveryTime: { hour: 1, minute: 30, timezone: 'America/New_York' },
    });
    await seedTopic('iris', 'topic-dst');
    harness.clock.set(new Date('2026-11-01T05:45:00Z'));

    expect((await harness.scheduler.run()).sentCount).toBe(1);
    harness.clock.set(new Date('2026-11-01T06:15:00Z'));
    const second = await harness.scheduler.run();

    expect(second.sentCount).toBe(0);
    expect(second.failureCount).toBe(0);
    expect(harness.count('brief_snapshots')).toBe(1);
    expect(harness.count('brief_runs')).toBe(1);
  });

  it('does not send twice across the repeated hour east of UTC', async () => {
    // 25 October 2026: Europe/Berlin repeats 02:00 to 03:00. The earlier 02:30 is
    // 00:30 UTC and the later one 01:30 UTC, so a DeliverySlot on the later reading
    // would not come due until after the repeated hour had ended — and a User the
    // job owed the earlier one to would get two briefs fifty minutes apart.
    await seedUser({
      id: 'iris',
      deliveryTime: { hour: 2, minute: 30, timezone: 'Europe/Berlin' },
    });
    await seedTopic('iris', 'topic-dst');

    // The process was down over the earlier reading and came back just after it.
    harness.clock.set(new Date('2026-10-25T00:45:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(1);

    // Still inside the repeated hour, and then well past it.
    harness.clock.set(new Date('2026-10-25T01:35:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(0);
    harness.clock.set(new Date('2026-10-25T12:00:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(0);

    expect(harness.count('brief_snapshots')).toBe(1);
  });

it('does not send a second brief for a period it has already answered', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');

    const first = await harness.scheduler.run();
    const second = await harness.scheduler.run();

    expect(first.sentCount).toBe(1);
    expect(second.sentCount).toBe(0);
    // A pass that decided to try again anyway would have reached the provider
    // before anything stopped it, so it shows up as a failure rather than as
    // nothing: the second brief is refused by the record, not by silence.
    expect(second.failureCount).toBe(0);
    expect(recipients()).toHaveLength(1);
    expect(harness.count('brief_snapshots')).toBe(1);
    expect(harness.count('brief_runs')).toBe(1);
  });

it('recovers a run missed while the process was down', async () => {
    await seedUser({
      id: 'iris',
      deliveryTime: { hour: 8, minute: 0, timezone: 'UTC' },
      deliveryRecordedAt: new Date('2026-09-01T07:00:00Z'),
    });
    await seedTopic('iris', 'topic-one');

    // The loop ran all through the first day and sent that day's brief.
    harness.clock.set(new Date('2026-09-01T12:00:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(1);

    // Then the process was not running when the next day's reading came round.
    harness.clock.set(new Date('2026-09-02T07:30:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(0);

    // It came back two hours afterwards with no memory of having missed it.
    harness.clock.set(new Date('2026-09-02T10:00:00Z'));
    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(1);
    const served = await harness.briefRunRepo.listByUser('iris');
    // Yesterday's, and then today's — one brief per period, with the missed one
    // recovered rather than skipped.
    expect(served.map((r) => r.scheduledFor.toISOString())).toEqual([
      '2026-09-02T08:00:00.000Z',
      '2026-09-01T08:00:00.000Z',
    ]);
    expect(served[0]?.sentAt).toEqual(new Date('2026-09-02T10:00:00Z'));
    expect(harness.count('brief_snapshots')).toBe(2);
  });

  it('still recovers a missed DeliverySlot after the User saves their reading again', async () => {
    // Saving the same reading is not recording a new one: the moment it was
    // recorded is what decides which DeliverySlots the User can be owed, and moving it
    // forward would silently drop a DeliverySlot the process had already missed.
    await seedUser({ id: 'iris', deliveryTime: { hour: 8, minute: 0, timezone: 'UTC' } });
    await seedTopic('iris', 'topic-one');
    harness.clock.set(new Date('2026-09-02T09:00:00Z'));
    await harness.settingsRepo.upsert(
      makeDeliverySettings({
        userId: 'iris',
        welcomeSentAt: NOW,
        updatedAt: new Date('2026-09-02T09:00:00Z'),
      }),
    );

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(1);
    const [served] = await harness.briefRunRepo.listByUser('iris');
    expect(served?.scheduledFor).toEqual(new Date('2026-09-02T08:00:00Z'));
  });

  it('sends the next period once the clock has moved on', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');

    await harness.scheduler.run();
    harness.clock.set(new Date('2026-09-03T12:00:00Z'));
    const next = await harness.scheduler.run();

    expect(next.sentCount).toBe(1);
    expect(harness.count('brief_runs')).toBe(2);
  });

  it('runs the daily job for a free User and a paid one alike', async () => {
    await seedUser({ id: 'free-user', tier: 'free' });
    await seedUser({ id: 'paid-user', tier: 'paid' });
    await seedTopic('free-user', 'topic-free');
    await seedTopic('paid-user', 'topic-paid');

    const run = await harness.scheduler.run();

    // The brief is the product on both tiers, so neither is gated here. What a
    // tier buys is in `domain/tier.ts` and has nothing to do with whether a User
    // is sent what they asked to be sent.
    expect(run.sentCount).toBe(2);
    expect([...recipients()].sort()).toEqual(['free-user@example.com', 'paid-user@example.com']);
  });

  it('sends nothing to a User with no DeliveryTime recorded', async () => {
    await seedUser({ id: 'iris', withoutDeliveryTime: true });
    await seedTopic('iris', 'topic-one');

    const run = await harness.scheduler.run();

    // Halfway through onboarding: a Topic and a signed-in User, no clock time.
    expect(run.sentCount).toBe(0);
    expect(run.failureCount).toBe(0);
    expect(harness.count('brief_snapshots')).toBe(0);
  });

  it('leaves a Topic that is not on a daily Cadence alone', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-weekly', { cadence: 'weekly' });
    await seedTopic('iris', 'topic-never', { cadence: 'never' });
    await seedTopic('iris', 'topic-daily', { cadence: 'daily' });

    const run = await harness.scheduler.run();

    // The Cadence is what the User asked for; a weekly Topic asked for weekly.
    expect(run.sentCount).toBe(1);
    expect(harness.transport.snapshot()[0]?.subject).toBe('Topic topic-daily - Brieflyy');
  });

  it('leaves a removed Topic alone', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');
    await harness.topicRepo.remove('topic-one' as TopicId, NOW);

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(0);
  });

it('sends a brief for a Topic with nothing on it, as asking for one by hand would', async () => {
    await seedUser({ id: 'iris' });
    // A Topic whose Sources have produced no Clusters yet — a brand new Topic, or
    // one the ingest pipeline has not reached. No Cluster fixture, so nothing to
    // quote.
    await harness.topicRepo.insert(makeTopic({ id: 'topic-quiet', userId: 'iris' }));

    const run = await harness.scheduler.run();

    // The job does not get a second opinion on what a brief is. A brief with
    // nothing in it is what a User who asked for one by hand gets today, and the
    // rule for when there is nothing worth saying belongs to the plan, which is
    // the same code either way round.
    expect(run.sentCount).toBe(1);
    expect(harness.count('brief_snapshots')).toBe(1);
    expect(harness.count('brief_plans')).toBe(1);
  });

  it('counts a failed send and still serves every other User', async () => {
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedUser({ id: 'omar', email: 'omar@example.com' });
    await seedTopic('iris', 'topic-iris');
    await seedTopic('omar', 'topic-omar');
    const sent: string[] = [];
    const refusing: EmailTransport = {
      providerName: 'refusing',
      send: async (message) => {
        if (message.to === 'iris@example.com') throw new Error('provider down');
        sent.push(message.to);
        return { id: 'refusing-1', provider: 'refusing' };
      },
    };

    const run = await harness.schedulerWith(refusing).run();

    // One User's provider refusing is not the day's work stopping.
    expect(run.sentCount).toBe(1);
    expect(run.failureCount).toBe(1);
    expect(sent).toEqual(['omar@example.com']);
    expect(harness.count('email_deliveries')).toBe(1);
  });

  it('leaves a failed send owed, so the next pass retries it', async () => {
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    let refuse = true;
    const flaky: EmailTransport = {
      providerName: 'flaky',
      send: async (message) => {
        if (refuse) throw new Error('provider down');
        return { id: 'flaky-1', provider: 'flaky' };
      },
    };
const scheduler = harness.schedulerWith(flaky);

    expect((await scheduler.run()).failureCount).toBe(1);
    expect(harness.count('brief_runs')).toBe(0);

    // A retry is the next pass, so it is a minute later rather than the same
    // instant, which is all a second plan for the same Topic needs.
    refuse = false;
    harness.clock.advance(60_000);
    const retried = await scheduler.run();

    expect(retried.sentCount).toBe(1);
    expect(harness.count('brief_runs')).toBe(1);
  });

  it('counts a User it cannot find an address for as a failure, not a send', async () => {
// A User with a recorded DeliveryTime and no Account: the row a half-finished
    // sign-up or a deleted account leaves behind.
    await harness.userRepo.insert(makeUser({ id: 'ghost', onboardingState: 'completed' }));
    await harness.settingsRepo.upsert(
      makeDeliverySettings({ userId: 'ghost', welcomeSentAt: NOW, updatedAt: RECORDED }),
    );
    await seedTopic('ghost', 'topic-one');

    const run = await harness.scheduler.run();

    // A brief owed to a User with nowhere to send it is a brief that did not go
    // out. Reporting zero of both would say the day was dealt with.
    expect(run.sentCount).toBe(0);
    expect(run.failureCount).toBe(1);
  });
});

describe('ScheduledBriefService.status', () => {
  it('reports no pass before the job has run', async () => {
    const status = await harness.scheduler.status();

    expect(status).toEqual({ running: false, lastRun: null, recentRuns: [] });
  });

  it('records the last pass and how it went', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');
    harness.clock.set(new Date('2026-09-02T12:00:00Z'));

    await harness.scheduler.run();

    const status = await harness.scheduler.status();
    expect(status.lastRun).toEqual({
      id: expect.any(String),
      startedAt: new Date('2026-09-02T12:00:00Z'),
      finishedAt: new Date('2026-09-02T12:00:00Z'),
      sentCount: 1,
      failureCount: 0,
    });
  });

it('counts a pass that found nobody due as a pass, with nothing sent', async () => {
    await seedUser({
      id: 'iris',
      deliveryTime: { hour: 23, minute: 0, timezone: 'UTC' },
      deliveryRecordedAt: NOW,
    });
    await seedTopic('iris', 'topic-one');

    await harness.scheduler.run();

    // A pass that ran and sent nothing is a different thing from a job that is
    // not running, and only the first is worth seeing.
    const status = await harness.scheduler.status();
    expect(status.lastRun?.sentCount).toBe(0);
    expect(status.recentRuns).toHaveLength(1);
  });

  it('lists the most recent passes first', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');

    await harness.scheduler.run();
    harness.clock.advance(60_000);
    await harness.scheduler.run();
    harness.clock.advance(60_000);
    await harness.scheduler.run();

    const status = await harness.scheduler.status();
    expect(status.recentRuns.map((r) => r.startedAt.toISOString())).toEqual([
      '2026-09-02T12:02:00.000Z',
      '2026-09-02T12:01:00.000Z',
      '2026-09-02T12:00:00.000Z',
    ]);
    expect(status.lastRun?.id).toBe(status.recentRuns[0]?.id);
  });

  it('keeps a bounded history of passes', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');
    const scheduler = harness.schedulerWith(
      harness.transport,
      { retainedRuns: 2 },
    );

    for (let pass = 0; pass < 4; pass++) {
      harness.clock.advance(60_000);
      await scheduler.run();
    }

    // Four passes, three days apart, and only the newest two kept: the table the
    // status view reads is written every pass and read for the newest few, so
    // leaving it to grow is a table nobody will ever read the rest of.
    expect(harness.count('brief_job_runs')).toBe(2);
    const status = await scheduler.status();
    expect(status.recentRuns.map((r) => r.sentCount)).toEqual([0, 0]);
    expect(status.lastRun?.startedAt).toEqual(new Date('2026-09-02T12:04:00Z'));
  });

  it('reports a pass that sent and one that failed on the same day', async () => {
await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-iris');
    await seedUser({ id: 'omar', email: 'omar@example.com' });
    await seedTopic('omar', 'topic-omar');
    const refusing: EmailTransport = {
      providerName: 'refusing',
      send: async (message) => {
        if (message.to === 'omar@example.com') throw new Error('provider down');
        return { id: 'ok-1', provider: 'refusing' };
      },
    };
    const scheduler = harness.schedulerWith(refusing);

    await scheduler.run();
    const status = await scheduler.status();

    expect(status.lastRun).toMatchObject({ sentCount: 1, failureCount: 1 });
  });
});

describe('ScheduledBriefService as a loop', () => {
  /** Let the loop's awaits settle, so a test does not race the microtask queue. */
  function settle(): Promise<void> {
    return new Promise((resolve) => setImmediate(resolve));
  }

  function park(): {
    readonly delays: number[];
    sleep(ms: number): Promise<void>;
    release(): void;
  } {
    const delays: number[] = [];
    const parked: { release: (() => void) | null } = { release: null };
    return {
      delays,
      sleep(ms: number): Promise<void> {
        delays.push(ms);
        return new Promise<void>((resolve) => {
          parked.release = resolve;
        });
      },
      release(): void {
        const resolve = parked.release;
        parked.release = null;
        resolve?.();
      },
    };
  }

  it('runs a pass on every interval, and stops when told to', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');
    const waiter = park();
    harness.scheduler.setSleepFn(waiter.sleep);

    const running = harness.scheduler.runForever();
    expect((await harness.scheduler.status()).running).toBe(true);

    waiter.release();
    await settle();
    expect(harness.count('brief_job_runs')).toBe(1);

    waiter.release();
    await settle();
    expect(harness.count('brief_job_runs')).toBe(2);

    await harness.scheduler.stop();
    waiter.release();
    await running;

    expect((await harness.scheduler.status()).running).toBe(false);
    expect(waiter.delays).toEqual([60_000, 60_000, 60_000]);
  });

  it('stops without waiting out the interval, and waits for the pass in flight', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');
    // Park the loop between passes, so the only thing that can end the test is
    // the code under test.
    harness.scheduler.setSleepFn(() => new Promise<void>(() => {}));

    const running = harness.scheduler.runForever();
    await settle();

    const outcome = await Promise.race([
      harness.scheduler.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 2000)),
    ]);
    await running;

    expect(outcome).toBe('stopped');
  });
});


