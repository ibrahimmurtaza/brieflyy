import { beforeEach, describe, expect, it } from 'vitest';

import { ScheduledBriefService } from './scheduled-brief-service.js';
import type { LLMSummaryClient } from '../domain/llm.js';
import { RecordingSummaryClient } from '../testing/summary-client.js';
import { BriefPlanService } from './brief-plan-service.js';
import { BriefSnapshotRenderer } from './brief-snapshot-renderer.js';
import { DrizzleAccountRepo } from '../repos/account-repo.js';
import { DrizzleBriefJobRunRepo } from '../repos/brief-job-run-repo.js';
import { DrizzleBriefPlanRepo } from '../repos/brief-plan-repo.js';
import { DrizzleBriefRunRepo } from '../repos/brief-run-repo.js';
import type { BriefRunRepo } from '../repos/brief-run-repo.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleDeliverySettingsRepo } from '../repos/delivery-settings-repo.js';
import { DrizzleEmailDeliveryRepo } from '../repos/email-delivery-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { EmailRefusedError, type EmailTransport } from '../email/transport.js';
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
import type { Cadence, Tier, TopicId, UserId, Weekday } from '../domain/types.js';
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
  /** One row, for asserting what was actually written rather than what was returned. */
  firstRow<T>(sql: string): T | undefined;

  /** The same job with different options, for the paths they open up. */
  schedulerWith(transport: EmailTransport, overrides?: { retainedRuns?: number }): ScheduledBriefService;
  /** The same job with a summary client, which is what a deployment with one has. */
  schedulerWritingWith(
    client: LLMSummaryClient,
    transport?: EmailTransport,
  ): ScheduledBriefService;
  /** The same job over a repository of the caller's, which is how a pass is made to die. */
  schedulerWithRepo(briefRunRepo: BriefRunRepo, transport?: EmailTransport): ScheduledBriefService;
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

  const schedulerOver = (
    over: EmailTransport,
    client: LLMSummaryClient | undefined,
    overrides: {
      retainedRuns?: number;
      briefRunRepo?: BriefRunRepo;
    } = {},
  ): ScheduledBriefService =>
    new ScheduledBriefService({
      briefPlanService: new BriefPlanService({
        clusterRepo,
        briefPlanRepo: new DrizzleBriefPlanRepo(db),
        briefSnapshotRepo: new DrizzleBriefSnapshotRepo(db),
        emailDeliveryRepo: new DrizzleEmailDeliveryRepo(db),
        renderer: new BriefSnapshotRenderer({
          clusterRepo,
          topicRepo,
          clock: clock.clock,
          ...(client ? { llmClient: client } : {}),
        }),
        emailTransport: over,
        appBaseUrl: APP_BASE_URL,
        clock: clock.clock,
        random: deterministicRandom,
      }),
      briefRunRepo: overrides.briefRunRepo ?? briefRunRepo,
      briefJobRunRepo,
      deliverySettingsRepo: settingsRepo,
      topicRepo,
      accountRepo,
      userRepo,
      emailTransport: over,
      clock: clock.clock,
      random: deterministicRandom,
      intervalMs: 60_000,
      ...(overrides.retainedRuns === undefined ? {} : { retainedRuns: overrides.retainedRuns }),
    });

  const schedulerWith = (
    over: EmailTransport,
    overrides: { retainedRuns?: number } = {},
  ): ScheduledBriefService => schedulerOver(over, undefined, overrides);

  const schedulerWritingWith = (
    client: LLMSummaryClient,
    over: EmailTransport = transport,
  ): ScheduledBriefService => schedulerOver(over, client);

  const schedulerWithRepo = (
    repo: BriefRunRepo,
    over: EmailTransport = transport,
  ): ScheduledBriefService => schedulerOver(over, undefined, { briefRunRepo: repo });

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
    firstRow: <T,>(sql: string): T | undefined => driver.prepare(sql).get() as T | undefined,
    schedulerWith,
    schedulerWritingWith,
    schedulerWithRepo,
  };
});

/**
 * A BriefRunRepo that cannot record that a send went out, and delegates the rest
 * of itself. What a deploy between the transport's answer and the next write
 * looks like from inside the pass: everything the pass wanted to write after the
 * email went out is lost, and the only thing that can survive it is what was
 * written before.
 */
function dyingBeforeItRecordsASend(repo: BriefRunRepo): BriefRunRepo {
  return {
    claim: (run) => repo.claim(run),
    markSent: async () => {
      throw new Error('the process went away mid-pass');
    },
    release: (id) => repo.release(id),
    findBySlot: (userId, topicId, slot) => repo.findBySlot(userId, topicId, slot),
    listByUser: (userId) => repo.listByUser(userId),
  };
}

interface SeedUserInput {
  readonly id: string;
  readonly email?: string;
  /** What the User recorded at onboarding. Eight in the morning UTC unless told otherwise. */
  readonly deliveryTime?: DeliveryTime;
  readonly deliveryRecordedAt?: Date;
  readonly tier?: Tier;
  /** When the User opted out of every brief, or omit to leave them receiving them. */
  readonly unsubscribedAt?: Date;
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
      ...(input.unsubscribedAt ? { unsubscribedAt: input.unsubscribedAt } : {}),
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
  overrides: {
    readonly cadence?: Cadence;
    readonly cadenceDay?: Weekday | null;
    readonly title?: string;
    readonly unsubscribedAt?: Date | null;
  } = {},
): Promise<void> {
  await harness.topicRepo.insert(
    makeTopic({
      id: topicId,
      userId,
      title: overrides.title ?? `Topic ${topicId}`,
      ...(overrides.cadence ? { cadence: overrides.cadence } : {}),
      ...(overrides.cadenceDay === undefined ? {} : { cadenceDay: overrides.cadenceDay }),
      ...(overrides.unsubscribedAt === undefined
        ? {}
        : { unsubscribedAt: overrides.unsubscribedAt }),
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

/** Let the loop's awaits settle, so a test does not race the microtask queue. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** A door a test can hold a call open in, and open again to let it through. */
function parked(): { wait(): Promise<void>; open(): void } {
  let opened: (() => void) | null = null;
  return {
    wait: () =>
      new Promise<void>((resolve) => {
        opened = resolve;
      }),
    open: () => {
      const resolve = opened;
      opened = null;
      resolve?.();
    },
  };
}

describe('ScheduledBriefService, an unsubscribed reader', () => {
  it('sends nothing at all to a User who unsubscribed from every brief', async () => {
    // The unsubscribe link in a brief has to stop the mail, and the only thing
    // that can stop it is the job: a flag nothing reads is a link that reads as
    // working and is not.
    await seedUser({ id: 'iris', unsubscribedAt: NOW });
    await seedTopic('iris', 'topic-one');
    await seedTopic('iris', 'topic-two');

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(0);
    expect(run.failureCount).toBe(0);
    expect(harness.transport.snapshot()).toHaveLength(0);
    expect(harness.count('brief_snapshots')).toBe(0);
    // And nothing is owed for that slot either, so a resubscribe does not
    // produce a backlog of every reading since the opt-out.
    expect(harness.count('brief_runs')).toBe(0);
  });

  it('sends to everyone else in the same pass', async () => {
    await seedUser({ id: 'gone', email: 'gone@example.com', unsubscribedAt: NOW });
    await seedUser({ id: 'staying', email: 'staying@example.com' });
    await seedTopic('gone', 'topic-gone');
    await seedTopic('staying', 'topic-staying');

    const run = await harness.scheduler.run();

    // One reader's decision is not a reason to stop sending everyone else theirs.
    expect(run.sentCount).toBe(1);
    expect(recipients()).toEqual(['staying@example.com']);
  });

  it('stops one unsubscribed Topic and leaves the User other Topics sending', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one', { title: 'World news', unsubscribedAt: NOW });
    await seedTopic('iris', 'topic-two', { title: 'Elections' });

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(1);
    expect(harness.transport.snapshot().map((m) => m.subject)).toEqual([
      'Elections - Brieflyy',
    ]);
  });

  it('starts sending again once the Topic is resubscribed', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one', { unsubscribedAt: NOW });

    expect((await harness.scheduler.run()).sentCount).toBe(0);

    await harness.topicRepo.setUnsubscribedAt('topic-one', null);
    expect((await harness.scheduler.run()).sentCount).toBe(1);
  });
});

/**
 * A BriefRunRepo that reports every slot as unclaimed, over a real one.
 *
 * The stale read two processes on one database produce: this pass asked before
 * the other had claimed, and is now claiming what the other already has. Only the
 * unique index can settle it, so the rest of the repository is the real one and
 * the claim really does fail against a row that exists.
 */
function notReadingClaimsItWillLose(repo: BriefRunRepo): BriefRunRepo {
  return {
    claim: (claim) => repo.claim(claim),
    markSent: (id, sentAt) => repo.markSent(id, sentAt),
    release: (id) => repo.release(id),
    findBySlot: async () => null,
    listByUser: (userId) => repo.listByUser(userId),
  };
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

  it('sends a brief for a weekly Topic on the day it is pinned to', async () => {
    // 2 September 2026 is a Wednesday. The User's 08:00 has passed today, and the
    // Topic they pinned to Wednesday is owed today's reading — the same one a
    // daily Topic would get.
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-weekly', { cadence: 'weekly', cadenceDay: 'wednesday' });

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(1);
    const [served] = await harness.briefRunRepo.listByUser('iris');
    expect(served?.scheduledFor).toEqual(new Date('2026-09-02T08:00:00Z'));
  });

  it('sends a brief for a weekly Topic on its day a week later, and not in between', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-weekly', { cadence: 'weekly', cadenceDay: 'wednesday' });

    expect((await harness.scheduler.run()).sentCount).toBe(1);

    // The four days in between are not owed anything, even though a daily Topic
    // would have been sent one on each.
    for (const day of ['2026-09-03', '2026-09-04', '2026-09-05', '2026-09-06']) {
      harness.clock.set(new Date(`${day}T12:00:00Z`));
      expect((await harness.scheduler.run()).sentCount, day).toBe(0);
    }

    // And the following Wednesday is owed, so "weekly" means a week rather than
    // "the one reading that has already happened".
    harness.clock.set(new Date('2026-09-09T12:00:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(1);
  });

  it('answers a weekly Topic on the reading of the day before its own day', async () => {
    // A Topic pinned to Saturday, on the Friday before: last Saturday is the
    // reading still owed, because this week's is still to come.
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-weekly', { cadence: 'weekly', cadenceDay: 'saturday' });
    harness.clock.set(new Date('2026-09-04T12:00:00Z'));

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(1);
    const [served] = await harness.briefRunRepo.listByUser('iris');
    expect(served?.scheduledFor).toEqual(new Date('2026-08-29T08:00:00Z'));
  });

  it('serves a daily and a weekly Topic of the same User on their own readings', async () => {
    // Two Users would be two DeliverySettings rows; one User with two Topics is
    // the harder case, because the two Cadences can disagree about which day is
    // owed and the pass has to answer for each rather than for the User. Thursday,
    // so the Friday Topic's reading is still to come and last Friday's is the one
    // it is owed.
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-daily', { title: 'Daily', cadence: 'daily' });
    await seedTopic('iris', 'topic-weekly', {
      title: 'Weekly',
      cadence: 'weekly',
      cadenceDay: 'friday',
    });
    harness.clock.set(new Date('2026-09-03T12:00:00Z'));

    const run = await harness.scheduler.run();

    expect(run.sentCount).toBe(2);
    const runs = await harness.briefRunRepo.listByUser('iris');
    const byTopic = new Map(runs.map((r) => [r.topicId, r.scheduledFor.toISOString()]));
    expect(byTopic.get('topic-daily')).toBe('2026-09-03T08:00:00.000Z');
    expect(byTopic.get('topic-weekly')).toBe('2026-08-28T08:00:00.000Z');
  });

  it('stops briefing a Topic the User set to never', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one', { title: 'Daily', cadence: 'daily' });
    await seedTopic('iris', 'topic-quiet', { title: 'Quiet', cadence: 'never' });

    const first = await harness.scheduler.run();
    expect(first.sentCount).toBe(1);
    expect(harness.transport.snapshot()[0]?.subject).toBe('Daily - Brieflyy');

    // And it stays quiet on the next day too, rather than being a Topic that was
    // skipped once.
    harness.clock.set(new Date('2026-09-03T12:00:00Z'));
    const second = await harness.scheduler.run();
    expect(second.sentCount).toBe(1);
    expect(harness.count('brief_snapshots')).toBe(2);
  });

  it('briefs a weekly Topic again once the User puts it back on a daily Cadence', async () => {
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one', { cadence: 'weekly', cadenceDay: 'monday' });

    expect((await harness.scheduler.run()).sentCount).toBe(1);

    await harness.topicRepo.setCadence('topic-one', 'daily', null);
    harness.clock.set(new Date('2026-09-03T12:00:00Z'));
    expect((await harness.scheduler.run()).sentCount).toBe(1);
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
        if (message.to === 'iris@example.com') throw new EmailRefusedError('provider down');
        sent.push(message.to);
        return { id: 'refusing-1', provider: 'refusing' };
      },
    };

    const run = await harness.schedulerWith(refusing).run();

    // One User's provider refusing is not the day's work stopping. One brief is
    // counted as a send and one as a failure — never both, never neither — so
    // the two numbers say what the pass did rather than how often it reached a
    // transport.
    expect(run.sentCount).toBe(1);
    expect(run.failureCount).toBe(1);
    expect(sent).toEqual(['omar@example.com']);
    // Both attempts on record, the refusal as a refusal rather than as nothing.
    expect(harness.count('email_deliveries')).toBe(2);
  });

  it('records a refused brief as a refusal rather than as nothing at all', async () => {
    // A refused send used to leave a rendered snapshot and no delivery, which
    // reads exactly like a brief nobody asked for. The row is the only place that
    // says this brief was attempted and turned down.
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    const refusing: EmailTransport = {
      providerName: 'refusing',
      send: async () => {
        throw new EmailRefusedError('provider down');
      },
    };

    await harness.schedulerWith(refusing).run();

    const recorded = harness.firstRow<{ outcome: string }>(
      'SELECT outcome FROM email_deliveries LIMIT 1',
    );
    expect(recorded).toEqual({ outcome: 'refused' });
    // The snapshot is still there: it is what was rendered, and there is nothing
    // to be gained by throwing it away over a provider that was briefly down.
    expect(harness.count('brief_snapshots')).toBe(1);
  });

  it('keeps the claim when the send failed in a way it cannot vouch for', async () => {
    // A timeout after the provider accepted, a 5xx, a socket that died: in each of
    // these the message may be in the User's inbox. Releasing the slot would make
    // the next pass send the same reading to somebody who already has it, which is
    // the exact harm the claim exists to prevent — a silence costs one brief, a
    // duplicate costs the User theirs.
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    const timingOut: EmailTransport = {
      providerName: 'timing-out',
      send: async () => {
        throw new Error('socket hang up');
      },
    };
    const scheduler = harness.schedulerWith(timingOut);

    expect((await scheduler.run()).failureCount).toBe(1);
    // Recorded as an attempt whose outcome is unknown, not as a refusal — the two
    // read the same to an operator and mean opposite things to the next pass.
    expect(harness.firstRow<{ outcome: string }>('SELECT outcome FROM email_deliveries LIMIT 1'))
      .toEqual({ outcome: 'unknown' });
    // And the claim stands, so the next pass offers nothing.
    expect(harness.count('brief_runs')).toBe(1);

    harness.clock.advance(60_000);
    const second = await scheduler.run();

    expect(second.sentCount).toBe(0);
    expect(second.failureCount).toBe(0);
    expect(recipients()).toHaveLength(0);
  });

  it('takes the DeliverySlot before it asks the transport for anything', async () => {
    // The whole of the fix in one assertion, and read from the database rather
    // than from anything this test holds: at the moment the message is handed
    // over, the claim on the slot is already on disk. Written afterwards it is a
    // record of a send a pass may have died in the middle of, which is the window
    // that lets the next pass offer the same reading a second time.
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    let claimedWhileSending = 0;
    let sentAtWhileSending: number | null = null;
    const watching: EmailTransport = {
      providerName: 'watching',
      send: async () => {
        claimedWhileSending = harness.count('brief_runs');
        sentAtWhileSending =
          harness.firstRow<{ sent_at: number | null }>(
            'SELECT sent_at FROM brief_runs LIMIT 1',
          )?.sent_at ?? null;
        return { id: 'watching-1', provider: 'watching' };
      },
    };

    expect((await harness.schedulerWith(watching).run()).sentCount).toBe(1);

    expect(claimedWhileSending).toBe(1);
    // Claimed, not settled: the transport has not answered yet, so there is no
    // moment to record and nothing here is pretending there is.
    expect(sentAtWhileSending).toBeNull();
  });

  it('does not offer the slot again after a pass died between the send and the record', async () => {
    // The pass this is about. The email is out, the row that stops the next pass
    // offering the same reading is not written, and the next pass has no way to
    // tell that from a slot nobody has reached yet — so it sends the same brief
    // again and the User has it twice.
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    const dying = harness.schedulerWithRepo(dyingBeforeItRecordsASend(harness.briefRunRepo));

    const first = await dying.run();

    // It went out, and the pass could not record that it did, which is a failure
    // the pass knows about rather than a send it can take credit for.
    expect(recipients()).toHaveLength(1);
    expect(first.sentCount).toBe(0);
    expect(first.failureCount).toBe(1);

    // The next pass finds the claim the dead one left and sends nothing.
    const second = await harness.scheduler.run();

    expect(second.sentCount).toBe(0);
    expect(second.failureCount).toBe(0);
    expect(recipients()).toHaveLength(1);
    expect(harness.count('brief_snapshots')).toBe(1);
    expect(harness.count('brief_runs')).toBe(1);
  });

  it('settles the claim once the transport has taken the brief', async () => {
    // The other end of the claim: a slot that was taken and then sent is a run
    // with a send time on it, which is what tells a settled claim from one a
    // pass walked away from.
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    harness.clock.advance(5_000);

    await harness.scheduler.run();

    const [served] = await harness.briefRunRepo.listByUser('iris');
    expect(served?.sentAt).toEqual(harness.clock.clock.now());
  });

  it('counts a slot another pass claimed first as neither a send nor a failure', async () => {
    // Two processes on one database both read the slot as unanswered, both render,
    // and then both try to claim it. The unique index settles it at the write, and
    // the loser has to read its lost claim as "nothing owed here" rather than as a
    // send it did not make or a failure it did not have.
    //
    // The read is made to miss deliberately — a repo that answers "not claimed"
    // for a slot another process has already claimed is exactly the stale read two
    // processes produce, and it is what puts the pass all the way through to the
    // claim where the index has to do its work.
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    const first = harness.scheduler.run();
    await settle();
    // A minute later, so the two plans are not competing on the same timestamp
    // and the race is the one under test rather than an unrelated constraint.
    harness.clock.advance(60_000);
    const raced = harness.schedulerWithRepo(
      notReadingClaimsItWillLose(harness.briefRunRepo),
    );

    const second = await raced.run();
    await first;

    // One brief went out, once. The racing pass read the slot as owed, planned and
    // rendered for it, and then reported neither a send nor a failure — because it
    // sent nothing and nothing went wrong with it.
    expect(second.sentCount).toBe(0);
    expect(second.failureCount).toBe(0);
    expect(recipients()).toHaveLength(1);
    expect(harness.count('brief_runs')).toBe(1);
  });

  it('leaves a failed send owed, so the next pass retries it', async () => {
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    let refuse = true;
    const flaky: EmailTransport = {
      providerName: 'flaky',
      send: async (message) => {
        if (refuse) throw new EmailRefusedError('provider down');
        return { id: 'flaky-1', provider: 'flaky' };
      },
    };
const scheduler = harness.schedulerWith(flaky);

    expect((await scheduler.run()).failureCount).toBe(1);
    // The claim is released rather than left standing. The transport said no, so
    // nothing reached the User and the slot is still owed; a claim a refusal left
    // behind would turn a provider having a bad minute into a User quietly losing
    // the morning's brief.
    expect(harness.count('brief_runs')).toBe(0);

    // A retry is the next pass, so it is a minute later rather than the same
    // instant, which is all a second plan for the same Topic needs.
    refuse = false;
    harness.clock.advance(60_000);
    const retried = await scheduler.run();

    expect(retried.sentCount).toBe(1);
    expect(harness.count('brief_runs')).toBe(1);
    // Two attempts on record with two different answers, rather than one row
    // rewritten by whichever outcome was written last.
    const refused = harness.firstRow<{ refused: number }>(
      `SELECT COUNT(*) AS refused FROM email_deliveries WHERE outcome = 'refused'`,
    );
    expect(refused).toEqual({ refused: 1 });
  });

  it('adds up what a refused brief cost to write, even though it never left', async () => {
    // The write calls were made and billed whatever the provider went on to do.
    // A pass that sent one brief and had one refused has spent real tokens, and
    // dropping its report would make that pass indistinguishable from one where
    // nothing was ever looked at — which is the whole reason the report is there.
    await seedUser({ id: 'iris', email: 'iris@example.com' });
    await seedTopic('iris', 'topic-one');
    const client = new RecordingSummaryClient(() => ({
      summary: 'A written line.',
      bulletPoints: [{ text: 'A point.', articleUrl: 'https://example.com/a-1' }],
      discardedBullets: 3,
    }));
    const refusing: EmailTransport = {
      providerName: 'refusing',
      send: async () => {
        throw new EmailRefusedError('provider down');
      },
    };

    const run = await harness.schedulerWritingWith(client, refusing).run();

    expect(run.sentCount).toBe(0);
    expect(run.failureCount).toBe(1);
    // One Cluster, so one written and one call, with the bullets that did not cite
    // a Cluster discarded on the way out.
    expect(run.generation).toEqual({
      writtenClusters: 1,
      calls: 1,
      discardedBullets: 3,
    });
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
      // Nothing asked and nothing written, because the harness has no summary
      // client. Reported as three explicit zeros rather than left out, so an
      // operator reading this pass can tell "the path did not run" from "nobody
      // looked".
      generation: { writtenClusters: 0, calls: 0, discardedBullets: 0 },
    });
  });

  it('records what writing the pass cost, and it survives the round trip', async () => {
    // The whole reason the counters exist. A pass that sends briefs and writes
    // none of them is a deployment whose credential expired, an endpoint that
    // started refusing, or a model that stopped citing anything real — and all
    // three produce a perfect brief, so nothing a User can see distinguishes
    // them from a deployment that never asked for one.
    await seedUser({ id: 'iris' });
    await seedTopic('iris', 'topic-one');
    await seedTopic('iris', 'topic-two');
    harness.clock.set(new Date('2026-09-02T12:00:00Z'));
    const client = new RecordingSummaryClient(() => ({
      summary: 'A written line.',
      bulletPoints: [{ text: 'A point.', articleUrl: 'https://example.com/a-1' }],
      discardedBullets: 2,
    }));

    await harness.schedulerWritingWith(client).run();

    const status = await harness.schedulerWritingWith(client).status();
    // Two briefs, one Cluster each: two Clusters written, two calls, and four
    // bullets thrown away for citing something that was not in the Cluster.
    expect(status.lastRun?.generation).toEqual({
      writtenClusters: 2,
      calls: 2,
      discardedBullets: 4,
    });
    // Read back from the row rather than from the return value, because the row
    // is the only copy that outlives the process — a counter that lived in the
    // returned object would be zero to anybody who looked afterwards.
    const stored = harness.firstRow<{
      written_clusters: number;
      generation_calls: number;
      discarded_bullets: number;
    }>(`SELECT written_clusters, generation_calls, discarded_bullets FROM brief_job_runs LIMIT 1`);
    expect(stored).toEqual({ written_clusters: 2, generation_calls: 2, discarded_bullets: 4 });
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
        if (message.to === 'omar@example.com') throw new EmailRefusedError('provider down');
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


