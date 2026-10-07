import type { Clock } from '../domain/clock.js';
import {
  NO_BACKOFF,
  type Source,
  type SourceBackoff,
  type SourceId,
} from '../domain/types.js';
import type { SourceRepo } from '../repos/source-repo.js';
import { IntervalLoop } from '../scheduling/interval-loop.js';
import type { RegistryIngestCycleReport, RegistryIngestService } from './registry-ingest-service.js';

export interface IngestSourceStatus {
  readonly sourceId: SourceId;
  readonly lastPolledAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly consecutiveFailures: number;
  /**
   * When this Source is next polled, or null when nothing is holding it back and
   * no cadence has started for it — which is a Source that has never run. A
   * Source serving a backoff has one; a Source that has never been polled and a
   * Source that has recovered do not, and the two are told apart by the failures
   * rather than by the date.
   */
  readonly nextAttemptAt: Date | null;
  readonly lastError: string | null;
  /**
   * Whether a backoff is what is holding this Source back right now.
   *
   * Not the same question as when it is next polled: every Source waiting out its
   * normal interval has a next attempt, and saying all of them are backing off
   * would be a reading with nothing behind it. This one is the state an operator
   * acts on, and it is derived from the same backoff the cycle is given, so the
   * page cannot report a Source as serving a backoff while the cycle polls it.
   */
  readonly servingBackoff: boolean;
}

export interface IngestSchedulerStatus {
  readonly running: boolean;
  readonly lastCycleAt: Date | null;
  readonly lastCycleId: string | null;
  readonly nextDueAt: Date | null;
  readonly sources: readonly IngestSourceStatus[];
}

export interface IngestSchedulerConfig {
  readonly intervalMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
}

export const DEFAULT_INGEST_SCHEDULER_CONFIG: IngestSchedulerConfig = {
  intervalMs: 30 * 60 * 1000,
  backoffBaseMs: 60 * 1000,
  backoffMaxMs: 30 * 60 * 1000,
};

export interface IngestSchedulerDeps {
  readonly registry: RegistryIngestService;
  readonly sourceRepo: SourceRepo;
  readonly clock: Clock;
  readonly config?: IngestSchedulerConfig;
  /**
   * Runs at the end of a cycle, once the Stories it wrote have settled.
   *
   * This is where Cluster formation hangs: Clusters are a grouping of the Stories
   * a cycle produced, so forming them any earlier would group against a window
   * the cycle has not finished filling. Absent means the caller only wants
   * Articles ingested.
   */
  readonly afterCycle?: (report: RegistryIngestCycleReport) => Promise<void>;
}

/**
 * Whether a Source's next attempt is still in the future, which is what is
 * holding the cycle off reaching out to it.
 *
 * This is the one definition of "is being left alone", so the decision a cycle
 * makes and the reading the dashboard cannot drift apart. It covers the cadence
 * as well as the backoff, because a Source with no failures still has a next
 * attempt: one interval on from its last poll.
 */
function isHeldUntil(backoff: SourceBackoff, now: Date): boolean {
  return (
    backoff.nextAttemptAt !== null && backoff.nextAttemptAt.getTime() > now.getTime()
  );
}

/**
 * Whether a Source is being held back by a backoff rather than by its cadence.
 *
 * A Source waiting out its normal interval is not in trouble, and reporting it
 * as backing off would say nearly every Source is in backoff nearly all of the
 * time — which is the reading the column exists to replace with something an
 * operator can act on.
 */
function isServingBackoff(backoff: SourceBackoff, now: Date): boolean {
  return backoff.consecutiveFailures > 0 && isHeldUntil(backoff, now);
}

export class IngestScheduler {
  private readonly registry: RegistryIngestService;
  private readonly sourceRepo: SourceRepo;
  private readonly clock: Clock;
  private readonly config: IngestSchedulerConfig;
  private readonly afterCycle: ((report: RegistryIngestCycleReport) => Promise<void>) | undefined;
  /**
   * The loop this scheduler rides on. It owns the waiting between cycles, the
   * wake-up on stop, and the wait for a cycle in flight, so this class is only
   * about ingest: when a Source is due, and what a cycle did to it.
   */
  private readonly loop: IntervalLoop;

  /**
   * The backoff every Source is serving, read off its row at the top of every
   * cycle and written back at the end of it.
   *
   * A cache of what the database already says rather than a record of it. The
   * whole reason the backoff exists is to outlast the process running it, so
   * nothing here is load-bearing once the process is gone — which is why it is
   * loaded before each cycle rather than kept, and why a Source whose row says
   * nothing is polled immediately however long this map has known about it.
   */
  private backoffs = new Map<SourceId, SourceBackoff>();
  private lastCycleAt: Date | null = null;
  private lastCycleId: string | null = null;
  private nextDueAt: Date | null = null;

  constructor(deps: IngestSchedulerDeps) {
    this.registry = deps.registry;
    this.sourceRepo = deps.sourceRepo;
    this.clock = deps.clock;
    this.config = deps.config ?? DEFAULT_INGEST_SCHEDULER_CONFIG;
    this.afterCycle = deps.afterCycle;
    this.loop = new IntervalLoop({
      intervalMs: this.config.intervalMs,
      // The next due time is this scheduler's own, because a cycle may leave a
      // Source due sooner than a whole interval away.
      nextDelayMs: () => this.msUntilDue(),
      onTickError: (err) => console.error('[IngestScheduler] tick failed:', err),
    });
  }

  setSleepFn(fn: (ms: number) => Promise<void>): void {
    this.loop.setSleepFn(fn);
  }

  private intervalMs(): number {
    return this.config.intervalMs;
  }

  /** How long until the next cycle is due, floored at nothing to wait for. */
  private msUntilDue(): number {
    const now = this.clock.now();
    const dueAt =
      this.nextDueAt ?? new Date(now.getTime() + this.intervalMs());
    return dueAt.getTime() - now.getTime();
  }

  async tick(): Promise<RegistryIngestCycleReport> {
    // Read before the cycle rather than after it, because the answer this
    // process gives has to be the answer the last one left on the rows. A
    // scheduler that started up with nothing in memory must leave a Source
    // serving a backoff alone on its very first cycle, or a deploy is a way of
    // putting every broken feed back into the next cycle's path.
    await this.loadBackoffs();
    const now = this.clock.now();
    // The scheduler owns the backoff state, so it is the one that decides which
    // Sources this cycle is allowed to reach out to.
    const report = await this.registry.ingestOnce({
      isDue: (sourceId, at) => this.isSourceDue(sourceId, at),
    });
    await this.applyReportBackoff(report, now);
    // After the backoff state, so the cycle is finished as far as the registry
    // and the scheduler are concerned before anything downstream reads what it
    // wrote.
    if (this.afterCycle) await this.afterCycle(report);
    this.lastCycleAt = report.finishedAt;
    this.lastCycleId = report.cycleId;
    this.nextDueAt = this.computeNextDueAt(this.clock.now());
    return report;
  }

  start(): void {
    if (this.loop.isRunning()) return;
    this.loop.start();
    this.nextDueAt = this.clock.now();
  }

  /**
   * Stop the loop and wait for the cycle in flight to finish.
   *
   * Waiting matters on shutdown: a cycle that is halfway through writing
   * Articles must not be abandoned, and a process that closes its database
   * underneath one is how a half-written Story happens. Awaiting is also what
   * makes this safe to call from a signal handler, where there is no second
   * chance to notice.
   */
  async stop(): Promise<void> {
    await this.loop.stop();
  }

  /**
   * Whether a Source is due to be polled now. This is what the registry asks
   * before it reaches out, so a Source waiting out a backoff is left alone
   * rather than being polled on every cycle regardless — and so is one whose
   * interval has not gone, which is what keeps an early wake-up for a broken
   * feed from becoming a poll of every other feed too.
   */
  isSourceDue(sourceId: SourceId, now: Date): boolean {
    return !isHeldUntil(this.backoffs.get(sourceId) ?? NO_BACKOFF, now);
  }

  runForever(): Promise<void> {
    // Started here rather than left to the loop, because starting is also what
    // makes the first cycle due from now rather than a whole interval away.
    this.start();
    return this.loop.runForever(() => this.tick());
  }

  status(): IngestSchedulerStatus {
    const now = this.clock.now();
    const sources: IngestSourceStatus[] = [...this.backoffs.entries()].map(
      ([sourceId, backoff]) => ({
        sourceId,
        lastPolledAt: null,
        lastSuccessAt: null,
        consecutiveFailures: backoff.consecutiveFailures,
        nextAttemptAt: backoff.nextAttemptAt,
        lastError: backoff.lastError,
        servingBackoff: isServingBackoff(backoff, now),
      }),
    );
    return {
      running: this.loop.isRunning(),
      lastCycleAt: this.lastCycleAt,
      lastCycleId: this.lastCycleId,
      nextDueAt: this.nextDueAt,
      sources,
    };
  }

  async statusHydrated(): Promise<IngestSchedulerStatus> {
    const now = this.clock.now();
    const sources = await this.sourceRepo.list();
    const baseStatus = this.status();
    const hydrated: IngestSourceStatus[] = sources.map((s) => {
      const backoff = this.backoffOf(s);
      return {
        sourceId: s.id,
        lastPolledAt: s.lastPolledAt,
        lastSuccessAt: s.lastSuccessAt,
        consecutiveFailures: backoff.consecutiveFailures,
        nextAttemptAt: this.nextAttemptAtForSource(s),
        lastError: backoff.lastError,
        servingBackoff: isServingBackoff(backoff, now),
      };
    });
    return {
      running: baseStatus.running,
      lastCycleAt: baseStatus.lastCycleAt,
      lastCycleId: baseStatus.lastCycleId,
      nextDueAt: baseStatus.nextDueAt,
      sources: hydrated,
    };
  }

  private async loadBackoffs(): Promise<void> {
    const sources = await this.sourceRepo.list();
    this.backoffs = new Map(sources.map((s) => [s.id, s.backoff] as const));
  }

  /**
   * The backoff one Source is serving.
   *
   * What the current cycle read wins, because that is what the cycle is acting
   * on. Failing that the row, which is right before the first cycle of a process
   * has run: the status an operator opens straight after a deploy is a reading
   * of the database, not of a map that has not been filled in yet.
   */
  private backoffOf(source: Source): SourceBackoff {
    return this.backoffs.get(source.id) ?? source.backoff;
  }

  private async applyReportBackoff(
    report: RegistryIngestCycleReport,
    cycleFinishedAt: Date,
  ): Promise<void> {
    for (const r of report.sources) {
      // A Source that was left alone this cycle keeps whatever it was already
      // serving out. Counting the skip as a success would clear the backoff
      // without ever having retried the Source.
      if (r.skipped) continue;
      if (r.success) {
        // The streak and the error go, and the next attempt goes on the normal
        // cadence rather than to null. Clearing the date as well would leave a
        // healthy Source with nothing holding it back, and the loop wakes early
        // for whichever Source is serving a short backoff — so that Source would
        // be polled on every one of those wake-ups, which is the crowding the
        // cadence exists to prevent.
        const nextAttemptAt = new Date(
          cycleFinishedAt.getTime() + this.intervalMs(),
        );
        await this.sourceRepo.recordRecovered(r.sourceId, nextAttemptAt);
        this.backoffs.set(r.sourceId, { ...NO_BACKOFF, nextAttemptAt });
        continue;
      }
      const consecutiveFailures =
        (this.backoffs.get(r.sourceId) ?? NO_BACKOFF).consecutiveFailures + 1;
      const backoff: SourceBackoff = {
        consecutiveFailures,
        lastError: r.error ?? 'unknown_error',
        nextAttemptAt: new Date(
          cycleFinishedAt.getTime() +
            this.computeBackoffDelay(consecutiveFailures),
        ),
      };
      await this.sourceRepo.recordBackoff(r.sourceId, backoff);
      this.backoffs.set(r.sourceId, backoff);
    }
  }

  private computeBackoffDelay(consecutiveFailures: number): number {
    const shift = Math.max(0, consecutiveFailures - 1);
    const cappedShift = Math.min(shift, 6);
    const delay = this.config.backoffBaseMs * 2 ** cappedShift;
    return Math.min(delay, this.config.backoffMaxMs);
  }

  /**
   * When this Source is next polled, and null when there is no answer to give.
   *
   * The stored next attempt says so outright. A Source written before the backoff
   * columns existed has none of its own, so it falls back to one cadence after
   * its last poll — and a Source that has never been polled is given no date at
   * all rather than "now", which on the dashboard reads as a Source late for a
   * slot it never had.
   */
  private nextAttemptAtForSource(source: Source): Date | null {
    const stored = this.backoffOf(source).nextAttemptAt;
    if (stored !== null) return stored;
    if (source.lastPolledAt === null) return null;
    return new Date(source.lastPolledAt.getTime() + this.intervalMs());
  }

  private computeNextDueAt(now: Date): Date {
    let earliest = new Date(now.getTime() + this.intervalMs());
    for (const backoff of this.backoffs.values()) {
      if (backoff.nextAttemptAt === null) continue;
      if (backoff.nextAttemptAt.getTime() < earliest.getTime()) {
        earliest = backoff.nextAttemptAt;
      }
    }
    return earliest;
  }
}
