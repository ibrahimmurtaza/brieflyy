import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import { dueCadenceSlot } from '../domain/delivery-slot.js';
import { DEFAULT_WEEKLY_DAY, type Topic } from '../domain/types.js';
import type {
  BriefGeneration,
  BriefJobRun,
  DeliverySettings,
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
import {
  BriefNotSentError,
  type BriefPlanService,
} from './brief-plan-service.js';

/** How often the job looks for a DeliveryTime that has arrived. */
export const DEFAULT_BRIEF_INTERVAL_MS = 60 * 1000;

export interface ScheduledBriefServiceDeps {
  /**
   * The one path a brief goes out by. Held rather than the renderer and the
   * transport separately, because a scheduled brief is not a second kind of
   * brief: it is planned, rendered, stored and sent exactly as one a User asked
   * for by hand, and only the trigger differs. Driven as its three steps rather
   * than through `sendBrief` because this pass has one thing to do the hand-sent
   * path has no place for — claim the DeliverySlot between the render and the
   * send — and `sendIfOwed` is where the order that matters is written down.
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
 * in their own timezone and answers each of their Topics for the DeliverySlot
 * their own Cadence puts it on.
 *
 * Every User has a different DeliveryTime in a different timezone, so there is no
 * one time of day this runs at and no single cron expression that could mean it.
 * What there is instead is an interval to look on, and one rule for who is owed
 * something: their own clock, in their own timezone, resolved by
 * `dueCadenceSlot`. The pass itself is deliberately the whole of the work — it
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
    const topicsByUser = briefableTopicsByUser(
      (await this.deps.topicRepo.listAll()).filter((t) => t.unsubscribedAt === null),
    );
    let sentCount = 0;
    let failureCount = 0;
    // A mutable one, unlike the shared zero a brief with no client reports: this
    // is an accumulator, and the pass that sent nothing still has to be able to
    // add to it.
    const generation = { writtenClusters: 0, calls: 0, discardedBullets: 0 };

    for (const setting of settings) {
      if (optedOut.has(setting.userId)) continue;

      for (const topic of topicsByUser.get(setting.userId) ?? []) {
        try {
          const slot = dueCadenceSlot(
            deliveryTimeOf(setting),
            startedAt,
            setting.updatedAt,
            topic.cadence,
            topic.cadenceDay ?? DEFAULT_WEEKLY_DAY,
          );
          // A Topic set to never is owed nothing at all, and a Cadence whose day
          // has not come round is not owed anything either. Both are answered by
          // the slot being null rather than by the pass filtering Topics out, so
          // there is one place that knows what a Cadence means.
          if (slot === null) continue;
          const sent = await this.sendIfOwed(setting, topic, slot);
          if (sent === null) continue;
          sentCount += 1;
          // What this brief cost to write, added up. Counted here rather than read
          // back from the brief, because a pass that sent nothing still reports
          // zero of each, and a status view that cannot tell "wrote nothing" from
          // "was never asked" is the thing this is for.
          generation.writtenClusters += sent.writtenClusters;
          generation.calls += sent.calls;
          generation.discardedBullets += sent.discardedBullets;
        } catch (err) {
          failureCount += 1;
          // A brief that was rendered and then failed to leave still cost what
          // writing it cost, and the write calls were spent whether or not the
          // message did. Read off the error rather than left out, because the
          // whole point of the report is telling a spent call from an unspent one
          // — and a refusal dropped from it reads as a brief nobody looked at.
          if (err instanceof BriefNotSentError) {
            generation.writtenClusters += err.generation.writtenClusters;
            generation.calls += err.generation.calls;
            generation.discardedBullets += err.generation.discardedBullets;
          }
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
      generation,
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
   * Answer one Topic's DeliverySlot, if it is still owed, and say what writing
   * that brief cost. Null when it was already claimed, which is the ordinary case
   * for every pass after the one that sent it.
   *
   * The three steps are driven here rather than through `sendBrief` because the
   * claim on the DeliverySlot has to be taken *between* the render and the send,
   * and that is the only place it can go. Written after the send it is a receipt,
   * and a receipt cannot stop anything: a pass that dies between the transport
   * taking the message and the row being written leaves an email in an inbox with
   * nothing behind it, and the next pass — seeing no run — offers the same reading
   * a second time. Taken before, the worst a death can cost is one DeliverySlot
   * whose outcome nobody recorded, which is the one thing the application cannot
   * resolve either way.
   */
  private async sendIfOwed(
    settings: DeliverySettings,
    topic: Topic,
    slot: DeliverySlot,
  ): Promise<BriefGeneration | null> {
    // Read before the work rather than only claiming after it: every pass after
    // the one that answered a slot would otherwise plan and render a brief — and
    // spend the write calls on it — before finding out there was nothing to send.
    const already = await this.deps.briefRunRepo.findBySlot(
      settings.userId,
      topic.id,
      slot,
    );
    if (already !== null) return null;

    const account = await this.deps.accountRepo.getByUserId(settings.userId);
    if (account === null) {
      // A brief owed to a User with nowhere to send it has not been sent. It is
      // counted as a failure rather than passed over, because passing over it in
      // silence is how a User who stopped getting briefs ends up with a status
      // view saying the day went fine.
      throw new Error(`no account for user ${settings.userId}`);
    }

    const plan = await this.deps.briefPlanService.createPlan({
      topicId: topic.id,
      userId: settings.userId,
    });
    const { snapshot, rendered } = await this.deps.briefPlanService.renderSnapshot(plan);

    const claimed = await this.deps.briefRunRepo.claim({
      id: this.deps.random.uuid(),
      userId: settings.userId,
      topicId: topic.id,
      scheduledFor: slot,
      briefSnapshotId: snapshot.id,
    });
    // Another pass reached the slot between the read and here. Its claim stands
    // and this one sends nothing, so the count below is not a pass that skipped a
    // User and not one that tried and failed.
    if (claimed === null) return null;

    try {
      const { generation } = await this.deps.briefPlanService.sendSnapshot({
        to: account.email,
        snapshot,
        rendered,
      });
      try {
        await this.deps.briefRunRepo.markSent(claimed.id, this.deps.clock.now());
      } catch (err) {
        // The brief went out and the claim stays unsettled, which is exactly the
        // window this pass cannot survive: the message may be in an inbox and
        // nothing on this side of it will say so. Wrapped rather than rethrown
        // raw so the pass still adds up what writing it cost — those calls were
        // made and billed, and reporting them nowhere would leave the pass looking
        // like one where nobody looked at anything.
        throw new BriefNotSentError(
          err instanceof Error ? err.message : String(err),
          'unknown',
          generation,
          null,
          { cause: err },
        );
      }
      return generation;
    } catch (err) {
      // Only a refusal Brieflyy *watched* gives the slot back. Every other failure
      // — the provider timed out after accepting, a 5xx, a delivery row that would
      // not write, the process on its way down — leaves the claim standing, because
      // the message may well be in an inbox and a second brief is worse than a
      // silence. `BriefNotSentError` is what separates the two, and it separates
      // them on the transport's word rather than on the shape of the message.
      if (err instanceof BriefNotSentError && err.outcome === 'refused') {
        await this.deps.briefRunRepo.release(claimed.id);
      }
      throw err;
    }
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
 * The Topics this job answers, by User.
 *
 * Every Topic, because which of them are owed a brief on this pass is a question
 * about their Cadence and the moment rather than about the Topic: a daily one is
 * owed today's reading, a weekly one only on the day it is pinned to, and one set
 * to never never at all. Filtering here would put that rule in two places — this
 * list and the slot — and the two could disagree about what a Cadence means.
 */
function briefableTopicsByUser(
  topics: readonly Topic[],
): Map<UserId, readonly Topic[]> {
  const out = new Map<UserId, Topic[]>();
  for (const topic of topics) {
    const list = out.get(topic.userId);
    if (list) {
      list.push(topic);
    } else {
      out.set(topic.userId, [topic]);
    }
  }
  return out;
}

