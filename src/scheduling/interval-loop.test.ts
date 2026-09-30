import { describe, expect, it } from 'vitest';

import { IntervalLoop } from './interval-loop.js';


/** Let the loop's awaits settle, so a test does not race the microtask queue. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

interface Waiter {
  /** Every delay the loop was asked to wait, in order. */
  readonly delays: number[];
  /** Stands in for a real timer, parking until the test lets it go. */
  sleep(ms: number): Promise<void>;
  /** Let the pending wait finish, or do nothing if it has already. */
  release(): void;
}

function makeWaiter(): Waiter {
  const delays: number[] = [];
  let pending: (() => void) | null = null;
  return {
    delays,
    sleep(ms: number): Promise<void> {
      delays.push(ms);
      return new Promise<void>((resolve) => {
        pending = resolve;
      });
    },
    release(): void {
      const resolve = pending;
      pending = null;
      resolve?.();
    },
  };
}

const NOW = new Date('2026-09-02T12:00:00Z');

function buildLoop(waiter: Waiter, intervalMs = 1000): IntervalLoop {
  const loop = new IntervalLoop({ intervalMs });
  loop.setSleepFn(waiter.sleep);
  return loop;
}

describe('IntervalLoop', () => {
  it('waits the interval before each tick, and keeps ticking until stopped', async () => {
    const waiter = makeWaiter();
    const loop = buildLoop(waiter);
    let ticks = 0;

    const running = loop.runForever(async () => {
      ticks++;
    });
    expect(loop.isRunning()).toBe(true);
    expect(ticks, 'ticked before waiting').toBe(0);
    expect(waiter.delays).toEqual([1000]);

    waiter.release();
    await settle();
    expect(ticks).toBe(1);

    // Parked again for the next tick, and still asking for the interval rather
    // than running on from the tick it just finished.
    expect(waiter.delays).toEqual([1000, 1000]);
    expect(ticks, 'ticked twice for one wait').toBe(1);

    await loop.stop();
    waiter.release();
    await running;

    expect(loop.isRunning()).toBe(false);
    expect(ticks).toBe(1);
  });

it('takes the next delay from the caller rather than a constant', async () => {
    const waiter = makeWaiter();
    let dueAt = NOW.getTime();
    const loop = new IntervalLoop({
      intervalMs: 30 * 60_000,
      // What a scheduler whose next due time is its own computes: nothing is due
      // yet, so it asks for no wait at all.
      nextDelayMs: () => dueAt - NOW.getTime(),
    });
    loop.setSleepFn(waiter.sleep);

    const running = loop.runForever(async () => {});
    await settle();

    expect(waiter.delays).toEqual([0]);
    dueAt = NOW.getTime() + 90_000;
    waiter.release();
    await settle();

    // The second wait asked for what the caller said was due, not the interval the
    // loop was built with.
    expect(waiter.delays).toEqual([0, 90_000]);
    await loop.stop();
    await running;
  });

  it('wakes out of the wait when stopped, rather than sleeping out the interval', async () => {
    // A real interval is half an hour. If stop() only flipped a flag, closing the
    // process would block for up to that long, which is what a shutdown avoids.
    const loop = new IntervalLoop({ intervalMs: 30 * 60_000 });
    loop.setSleepFn(() => new Promise<void>(() => {}));

    const running = loop.runForever(async () => {});
    await settle();

    const outcome = await Promise.race([
      loop.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('timed out'), 2000)),
    ]);
    await running;

    expect(outcome).toBe('stopped');
  });

  it('waits for the tick in flight to finish before stop() resolves', async () => {
    const waiter = makeWaiter();
    const loop = buildLoop(waiter);
    let ticks = 0;
    const parked: { release: (() => void) | null } = { release: null };

    const running = loop.runForever(async () => {
      ticks++;
      await new Promise<void>((resolve) => {
        parked.release = resolve;
      });
    });

    waiter.release();
    await settle();
    expect(ticks).toBe(1);

    // Parked inside the tick, and parked again between ticks, so the only thing
    // that can end this is the code under test.
    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await settle();
    expect(stopped, 'resolved with a tick still running').toBe(false);

    parked.release?.();
    await stopping;
    await running;

    expect(stopped).toBe(true);
    expect(loop.isRunning()).toBe(false);
  });

  it('reports a tick that threw and carries on to the next one', async () => {
    const waiter = makeWaiter();
    const errors: unknown[] = [];
    const loop = new IntervalLoop({
      intervalMs: 1000,
      onTickError: (err) => errors.push(err),
    });
    loop.setSleepFn(waiter.sleep);
    let ticks = 0;

    const running = loop.runForever(async () => {
      ticks++;
      throw new Error(`tick ${ticks}`);
    });

    waiter.release();
    await settle();
    expect(errors).toHaveLength(1);

    // A tick that throws is the tick after which the loop has to carry on: one
    // User's brief failing to send is not a reason to stop sending them theirs.
    waiter.release();
    await settle();
    expect(ticks).toBe(2);
    expect(errors).toHaveLength(2);

    await loop.stop();
    waiter.release();
    await running;
  });
});

