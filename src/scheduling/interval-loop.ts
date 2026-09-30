export interface IntervalLoopOptions {
  /** The default wait between ticks, when the caller has nothing else to say. */
  readonly intervalMs: number;
  /**
   * How long to wait before the next tick, for a caller whose next tick is not a
   * fixed interval away — a scheduler with a due time of its own, say. Absent
   * means the interval, and the value is clamped at zero so a due time in the
   * past asks for no wait rather than a negative one.
   */
  readonly nextDelayMs?: (() => number) | undefined;
  /** What a tick that threw is reported to. Absent means it is swallowed. */
  readonly onTickError?: ((err: unknown) => void) | undefined;
}

/**
 * A loop that runs work on an interval, and can be stopped.
 *
 * Two things have to be true of any background loop and neither is about the work
 * it does. It has to stop promptly: a loop parked on a timer that only notices it
 * was stopped half an interval later leaves a closing process hanging for as long,
 * which for a half-hourly loop is half an hour. And it has to finish the tick in
 * flight before `stop()` resolves, because a tick abandoned halfway is a write
 * against a database that is already closing.
 *
 * Both live here rather than in each loop, because the ingest loop and the brief
 * loop needed them and two copies of a shutdown is two copies to get wrong. The
 * loop knows nothing about what it ticks, and nothing about what time it is: how
 * long to wait is the caller's to say, which is why there is no clock here for one
 * loop to read and another to ignore.
 */
export class IntervalLoop {
  private readonly intervalMs: number;
  private readonly nextDelayMs: (() => number) | undefined;
  private readonly onTickError: ((err: unknown) => void) | undefined;
  private sleepFn: (ms: number) => Promise<void> = defaultSleep;

  private running = false;
  /** Resolvers for a wait that `stop()` is allowed to cut short. */
  private readonly waitInterruptions = new Set<() => void>();
  /** The tick currently running, so a stop can wait for it. */
  private inFlightTick: Promise<unknown> | null = null;

  constructor(options: IntervalLoopOptions) {
    this.intervalMs = options.intervalMs;
    this.nextDelayMs = options.nextDelayMs;
    this.onTickError = options.onTickError;
  }

  /** Substitute the wait, so a test sees every delay the loop asks for. */
  setSleepFn(fn: (ms: number) => Promise<void>): void {
    this.sleepFn = fn;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    this.running = true;
  }

  /**
   * Stop the loop and wait for the tick in flight to finish.
   *
   * Waiting matters on shutdown, and awaiting is what makes this safe to call
   * from a signal handler, where there is no second chance to notice.
   */
  async stop(): Promise<void> {
    this.running = false;
    for (const interrupt of [...this.waitInterruptions]) interrupt();
    this.waitInterruptions.clear();
    if (this.inFlightTick) await this.inFlightTick;
  }

  async runForever(tick: () => Promise<unknown>): Promise<void> {
    this.start();
    while (this.running) {
      if (!(await this.sleepUnlessStopped(this.nextDelay()))) break;
      if (!this.running) break;
      const inFlight = tick();
      this.inFlightTick = inFlight;
      try {
        await inFlight;
      } catch (err) {
        this.onTickError?.(err);
      } finally {
        this.inFlightTick = null;
      }
    }
  }

  private nextDelay(): number {
    const ms = this.nextDelayMs ? this.nextDelayMs() : this.intervalMs;
    return Math.max(0, ms);
  }

  /**
   * Wait `ms`, resolving false as soon as the loop is stopped.
   *
   * A plain timer would leave `runForever` parked for the whole interval after a
   * `stop()`, which is the shutdown this exists to prevent. Every wait goes
   * through the injected sleep, including a zero-length one, so a caller
   * substituting one sees every wait the loop makes.
   */
  private async sleepUnlessStopped(ms: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (completed: boolean) => {
        if (settled) return;
        settled = true;
        this.waitInterruptions.delete(interrupt);
        resolve(completed);
      };
      const interrupt = () => finish(false);
      this.waitInterruptions.add(interrupt);
      void this.sleepFn(ms).then(() => finish(true));
    });
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    // A loop's wait should not be the reason the process stays alive.
    timer.unref?.();
  });
}