import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import { dueDeliverySlot } from '../domain/delivery-slot.js';
import type {
  BriefJobRun,
  BriefRun,
  DeliverySettings,
  Topic,
  TopicId,
  UserId,
} from '../domain/types.js';
import type { EmailTransport } from '../email/transport.js';
import type { AccountRepo } from '../repos/account-repo.js';
import {
  RETAINED_JOB_RUNS,
  type BriefJobRunRepo,
} from '../repos/brief-job-run-repo.js';
import type { BriefRunRepo } from '../repos/brief-run-repo.js';
import type { DeliverySettingsRepo } from '../repos/delivery-settings-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import { IntervalLoop } from '../scheduling/interval-loop.js';
import { deliveryTimeOf } from '../domain/timezone.js';
import type { DeliverySlot } from '../domain/delivery-slot.js';
import type { BriefPlanService } from './brief-plan-service.js';

/** How often the job looks for a DeliveryTime that has arrived. */
export const DEFAULT_BRIEF_INTERVAL_MS = 60 * 1000;

export interface ScheduledBriefServiceDeps {
  /**
   * The one path a brief goes out by. Held rather than the renderer and the
   * transport separately, because a scheduled brief is not a second kind of
   * brief: it is planned, rendered, stored and sent exactly as one a User asked
   * for by hand, and only the trigger differs.
   */
  readonly briefPlanService: BriefPlanService;
  readonly briefRunRepo: BriefRunRepo;
  readonly briefJobRunRepo: BriefJobRunRepo;
  readonly deliverySettingsRepo: DeliverySettingsRepo;
  readonly topicRepo: TopicRepo;
  readonly accountRepo: AccountRepo;
  /**
   * Read once per pass for the Users who have opted out of every brief. Held
   * rather than a boolean passed in, because the opt-out is a fact about a User
   * that can change between passes and nothing should have to remember to tell
   * this service about it.
   */
  readonly userRepo: UserRepo;
  /** Held so the status view can report the provider the briefs actually went by. */
  readonly emailTransport: EmailTransport;
  readonly clock: Clock;
  readonly random: RandomSource;
  /** How often the job runs. Absent means the default above. */
  readonly intervalMs?: number;
  /**
   * How many passes to keep. Absent means the repo's own bound. A dep rather than
   * a constant only so a test can watch the bound be applied.
   */
  readonly retainedRuns?: number;
}

/** What a signed-in User can be told about the job. */
export interface ScheduledBriefStatus {
  readonly running: boolean;
  /** The most recent pass, or null when the job has never run. */
  readonly lastRun: BriefJobRun | null;
  readonly recentRuns: readonly BriefJobRun[];
}

/**
 * The daily brief job: one pass finds every User whose DeliveryTime has arrived
 * in their own timezone and answers each of their daily-Cadence Topics for that
 * DeliverySlot.
 *
 * Every User has a different DeliveryTime in a different timezone, so there is no
 * one time of day this runs at and no single cron expression that could mean it.
 * What there is instead is an interval to look on, and one rule for who is owed
 * something: their own clock, in their own timezone, resolved by
 * `dueDeliverySlot`. The pass itself is deliberately the whole of the work — it
 * reports what it sent and what it failed to send, records both, and leaves the
 * loop to `IntervalLoop`, which knows about waiting and stopping and nothing about
 * briefs.
 */
export class ScheduledBriefService {
  private readonly deps: ScheduledBriefServiceDeps;
  private readonly loop: IntervalLoop;

  constructor(deps: ScheduledBriefServiceDeps) {
    this.deps = deps;
    this.loop = new IntervalLoop({
      intervalMs: deps.intervalMs ?? DEFAULT_BRIEF_INTERVAL_MS,
      onTickError: (err) => console.error('[ScheduledBriefService] pass failed:', err),
    });
  }

  /** Route every wait through a substitute, so a test sees the job's interval. */
  setSleepFn(fn: (ms: number) => Promise<void>): void {
    this.loop.setSleepFn(fn);
  }

  start(): void {
    this.loop.start();
  }

  /**
   * Stop the job and wait for the pass in flight.
   *
   * A pass holds a brief half-sent at the moment a shutdown begins, so awaiting
   * is what keeps the process from closing the database under one.
   */
  async stop(): Promise<void> {
    await this.loop.stop();
  }

  runForever(): Promise<void> {
    this.start();
    return this.loop.runForever(() => this.run());
  }

  /**
   * One pass over the Users the job serves, and the record of how it went.
   *
   * A User's failure is contained to their own brief: the pass carries on for
   * everyone else and counts what it could not send, because one provider
   * refusing one address is not a reason to stop sending everyone else theirs.
   * The pass's own record is written last, so a run that throws reports nothing
   * rather than reporting a pass that did not finish.
   *
   * Two kinds of "no" are kept apart here. A User who is not owed a DeliverySlot
   * has nothing to skip, because nothing was ever on offer; a User or a Topic
   * who has unsubscribed had something on offer and said no, and their refusal is
   * counted as neither a send nor a failure — the slot is not owed either, so a
   * resubscribe does not release a backlog of every reading since.
   */
  async run(): Promise<BriefJobRun> {
    const startedAt = this.deps.clock.now();
    const settings = await this.deps.deliverySettingsRepo.list();
    const optedOut = new Set(await this.deps.userRepo.listUnsubscribedIds());
    const topicsByUser = dailyTopicsByUser(
      (await this.deps.topicRepo.listAll()).filter((t) => t.unsubscribedAt === null),
    );
    let sentCount = 0;
    let failureCount = 0;

    for (const setting of settings) {
      if (optedOut.has(setting.userId)) continue;
      const slot = dueDeliverySlot(
        deliveryTimeOf(setting),
        startedAt,
        setting.updatedAt,
      );
      if (slot === null) continue;

      for (const topic of topicsByUser.get(setting.userId) ?? []) {
        try {
          const sent = await this.sendIfOwed(setting, topic, slot);
          if (sent) sentCount += 1;
        } catch (err) {
          failureCount += 1;
          console.error(
            `[ScheduledBriefService] brief for ${topic.id} failed:`,
            err,
          );
        }
      }
    }

    const run: BriefJobRun = {
      id: this.deps.random.uuid(),
      startedAt,
      finishedAt: this.deps.clock.now(),
      sentCount,
      failureCount,
    };
    await this.deps.briefJobRunRepo.insert(run);
    // The table the status view reads is written every pass and read for the newest
    // twenty, so it is bounded here rather than left to grow for as long as the
    // process is up.
    await this.deps.briefJobRunRepo.pruneToNewest(
      this.deps.retainedRuns ?? RETAINED_JOB_RUNS,
    );
    return run;
  }

  /**
   * Answer one Topic's DeliverySlot, if it is still owed. False when it was
   * already answered, which is the ordinary case for every pass after the one that
   * sent it.
   */
  private async sendIfOwed(
    settings: DeliverySettings,
    topic: Topic,
    slot: DeliverySlot,
  ): Promise<boolean> {
    const already = await this.deps.briefRunRepo.findBySlot(
      settings.userId,
      topic.id,
      slot,
    );
    if (already !== null) return false;

    const account = await this.deps.accountRepo.getByUserId(settings.userId);
    if (account === null) {
      // A brief owed to a User with nowhere to send it has not been sent. It is
      // counted as a failure rather than passed over, because passing over it in
      // silence is how a User who stopped getting briefs ends up with a status
      // view saying the day went fine.
      throw new Error(`no account for user ${settings.userId}`);
    }

    const { snapshot } = await this.deps.briefPlanService.sendBrief({
      topicId: topic.id,
      userId: settings.userId,
      to: account.email,
    });

    // Written after the send, for the same reason the EmailDelivery is: this row
    // is the claim that the period was dealt with, so one written for a send that
    // failed would be a period nobody is owed anything for.
    const run: BriefRun = {
      id: this.deps.random.uuid(),
      userId: settings.userId,
      topicId: topic.id,
      scheduledFor: slot,
      sentAt: this.deps.clock.now(),
      briefSnapshotId: snapshot.id,
    };
    await this.deps.briefRunRepo.insert(run);
    return true;
  }

  /**
   * What a signed-in User can be told about the job.
   *
   * Read from the recorded passes rather than from memory, so the numbers are
   * the ones a restart cannot lose: a job that has never run and a job that ran
   * before the last restart are different facts and both are answerable here.
   */
  async status(): Promise<ScheduledBriefStatus> {
    const recentRuns = await this.deps.briefJobRunRepo.listRecent();
    return {
      running: this.loop.isRunning(),
      lastRun: recentRuns[0] ?? null,
      recentRuns,
    };
  }
}

/**
 * A User's Topics the daily job answers, by User.
 *
 * Only a daily Cadence. The glossary makes Cadence what the User asked for, and a
 * weekly Topic asked for weekly — which nothing implements yet, because weekly
 * needs a day of the week the Topic does not have.
 */
function dailyTopicsByUser(
  topics: readonly Topic[],
): Map<UserId, readonly Topic[]> {
const out = new Map<UserId, Topic[]>();
  for (const topic of topics) {
    if (topic.cadence !== 'daily') continue;
    const list = out.get(topic.userId);
    if (list) {
      list.push(topic);
    } else {
      out.set(topic.userId, [topic]);
    }
  }
  return out;
}

