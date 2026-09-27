import type { Clock } from '../domain/clock.js';

export interface RateLimitRule {
  /** Requests allowed per window, per key. */
  readonly limit: number;
  readonly windowMs: number;
}

export type RateLimitRules = Readonly<Record<string, RateLimitRule>>;

export interface RateLimitDecision {
  readonly allowed: boolean;
  /** Seconds until the key may try again; 0 when the request is allowed. */
  readonly retryAfterSeconds: number;
}

interface Window {
  readonly scope: string;
  readonly startedAt: number;
  count: number;
}

/** How many keys the table holds before expired windows are swept out of it. */
const SWEEP_THRESHOLD = 1024;

/**
 * A fixed-window counter per scope and key, held in memory.
 *
 * Enough for a single-process deployment: the point is to make repeated requests
 * expensive for an attacker, not to be a distributed quota. Windows that have
 * passed are swept once the table grows, so a flood cannot grow it for ever.
 */
export class FixedWindowRateLimiter {
  private readonly rules: RateLimitRules;
  private readonly clock: Clock;
  private readonly windows = new Map<string, Window>();

  constructor(rules: RateLimitRules, clock: Clock) {
    this.rules = rules;
    this.clock = clock;
  }

  /** How many keys are being counted right now. */
  get size(): number {
    return this.windows.size;
  }

  consume(scope: string, key: string): RateLimitDecision {
    const rule = this.rules[scope];
    if (!rule) return { allowed: true, retryAfterSeconds: 0 };

    const now = this.clock.now().getTime();
    const startedAt = Math.floor(now / rule.windowMs) * rule.windowMs;
    const id = `${scope} ${key}`;

    let window = this.windows.get(id);
    if (window === undefined || window.startedAt !== startedAt) {
      if (this.windows.size >= SWEEP_THRESHOLD) this.sweep(now);
      window = { scope, startedAt, count: 0 };
      this.windows.set(id, window);
    }

    if (window.count >= rule.limit) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(1, Math.ceil((startedAt + rule.windowMs - now) / 1000)),
      };
    }
    window.count += 1;
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(now: number): void {
    for (const [id, window] of this.windows) {
      const rule = this.rules[window.scope];
      if (!rule || now - window.startedAt >= rule.windowMs) this.windows.delete(id);
    }
  }
}
