import type { Clock } from '../domain/clock.js';
import type { Source, SourceId } from '../domain/types.js';
import type { SourceRepo } from '../repos/source-repo.js';
import type { RegistryIngestCycleReport, RegistryIngestService } from './registry-ingest-service.js';

export interface IngestSourceStatus {
  readonly sourceId: SourceId;
  readonly lastPolledAt: Date | null;
  readonly lastSuccessAt: Date | null;
  readonly consecutiveFailures: number;
  readonly nextAttemptAt: Date;
  readonly lastError: string | null;
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
  readonly sleep?: (ms: number) => Promise<void>;
  readonly intervalFn?: () => number;
}

interface SourceBackoff {
  consecutiveFailures: number;
  lastError: string | null;
  nextAttemptAt: Date;
}

export class IngestScheduler {
  private readonly registry: RegistryIngestService;
  private readonly sourceRepo: SourceRepo;
  private readonly clock: Clock;
  private readonly config: IngestSchedulerConfig;
  private readonly intervalFn: () => number;
  private sleepFn: (ms: number) => Promise<void>;

  private readonly backoffs = new Map<SourceId, SourceBackoff>();
  private running = false;
  private lastCycleAt: Date | null = null;
  private lastCycleId: string | null = null;
  private nextDueAt: Date | null = null;

  constructor(deps: IngestSchedulerDeps) {
    this.registry = deps.registry;
    this.sourceRepo = deps.sourceRepo;
    this.clock = deps.clock;
    this.config = deps.config ?? DEFAULT_INGEST_SCHEDULER_CONFIG;
    this.intervalFn = deps.intervalFn ?? ((): number => this.config.intervalMs);
    this.sleepFn =
      deps.sleep ??
      ((ms: number): Promise<void> =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, ms);
          timer.unref?.();
        }));
  }

  setSleepFn(fn: (ms: number) => Promise<void>): void {
    this.sleepFn = fn;
  }

  async tick(): Promise<RegistryIngestCycleReport> {
    const now = this.clock.now();
    const report = await this.registry.ingestOnce();
    this.applyReportBackoff(report, now);
    this.lastCycleAt = report.finishedAt;
    this.lastCycleId = report.cycleId;
    this.nextDueAt = this.computeNextDueAt(this.clock.now());
    return report;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.nextDueAt = this.clock.now();
  }

  stop(): void {
    this.running = false;
  }

  async runForever(): Promise<void> {
    this.start();
    while (this.running) {
      const dueAt =
        this.nextDueAt ??
        new Date(this.clock.now().getTime() + this.intervalFn());
      const delay = Math.max(0, dueAt.getTime() - this.clock.now().getTime());
      await this.sleepFn(delay);
      if (!this.running) break;
      try {
        await this.tick();
      } catch {
        // Swallow tick errors; per-source backoff tracking continues.
      }
    }
  }

  status(): IngestSchedulerStatus {
    const sources: IngestSourceStatus[] = [];
    for (const [sourceId, backoff] of this.backoffs.entries()) {
      sources.push({
        sourceId,
        lastPolledAt: null,
        lastSuccessAt: null,
        consecutiveFailures: backoff.consecutiveFailures,
        nextAttemptAt: backoff.nextAttemptAt,
        lastError: backoff.lastError,
      });
    }
    return {
      running: this.running,
      lastCycleAt: this.lastCycleAt,
      lastCycleId: this.lastCycleId,
      nextDueAt: this.nextDueAt,
      sources,
    };
  }

  async statusHydrated(): Promise<IngestSchedulerStatus> {
    const sources = await this.sourceRepo.list();
    const baseStatus = this.status();
    const backoffBySource = new Map(
      baseStatus.sources.map((s) => [s.sourceId, s] as const),
    );
    const hydrated: IngestSourceStatus[] = sources.map(
      (s): IngestSourceStatus => {
        const backoff = backoffBySource.get(s.id);
        return {
          sourceId: s.id,
          lastPolledAt: s.lastPolledAt,
          lastSuccessAt: s.lastSuccessAt,
          consecutiveFailures: backoff?.consecutiveFailures ?? 0,
          nextAttemptAt:
            backoff?.nextAttemptAt ??
            this.computeNextAttemptAtForSource(s, this.clock.now()),
          lastError: backoff?.lastError ?? null,
        };
      },
    );
    return {
      running: baseStatus.running,
      lastCycleAt: baseStatus.lastCycleAt,
      lastCycleId: baseStatus.lastCycleId,
      nextDueAt: baseStatus.nextDueAt,
      sources: hydrated,
    };
  }

  private applyReportBackoff(
    report: RegistryIngestCycleReport,
    cycleFinishedAt: Date,
  ): void {
    for (const r of report.sources) {
      const existing = this.backoffs.get(r.sourceId) ?? {
        consecutiveFailures: 0,
        lastError: null,
        nextAttemptAt: cycleFinishedAt,
      };
      if (r.success) {
        existing.consecutiveFailures = 0;
        existing.lastError = null;
        existing.nextAttemptAt = new Date(
          cycleFinishedAt.getTime() + this.intervalFn(),
        );
      } else {
        existing.consecutiveFailures += 1;
        existing.lastError = r.error ?? 'unknown_error';
        const delay = this.computeBackoffDelay(existing.consecutiveFailures);
        existing.nextAttemptAt = new Date(
          cycleFinishedAt.getTime() + delay,
        );
      }
      this.backoffs.set(r.sourceId, existing);
    }
    const seen = new Set(report.sources.map((s) => s.sourceId));
    for (const id of this.backoffs.keys()) {
      if (!seen.has(id)) {
        this.backoffs.delete(id);
      }
    }
  }

  private computeBackoffDelay(consecutiveFailures: number): number {
    const shift = Math.max(0, consecutiveFailures - 1);
    const cappedShift = Math.min(shift, 6);
    const delay = this.config.backoffBaseMs * 2 ** cappedShift;
    return Math.min(delay, this.config.backoffMaxMs);
  }

  private computeNextAttemptAtForSource(source: Source, now: Date): Date {
    const backoff = this.backoffs.get(source.id);
    if (backoff) return backoff.nextAttemptAt;
    const interval = this.intervalFn();
    if (source.lastPolledAt) {
      return new Date(source.lastPolledAt.getTime() + interval);
    }
    return now;
  }

  private computeNextDueAt(now: Date): Date {
    let earliest = new Date(now.getTime() + this.intervalFn());
    for (const backoff of this.backoffs.values()) {
      if (backoff.nextAttemptAt.getTime() < earliest.getTime()) {
        earliest = backoff.nextAttemptAt;
      }
    }
    return earliest;
  }
}