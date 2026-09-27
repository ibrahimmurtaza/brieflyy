import { describe, expect, it } from 'vitest';

import { MAGIC_LINK_RATE_LIMIT_SCOPES } from '../config.js';
import { FixedWindowRateLimiter } from './rate-limit.js';
import { makeTestClock } from '../testing/test-clocks.js';

const { perAddress, perSource } = MAGIC_LINK_RATE_LIMIT_SCOPES;

const RULES = {
  [perAddress]: { limit: 2, windowMs: 1000 },
  [perSource]: { limit: 3, windowMs: 1000 },
};

describe('FixedWindowRateLimiter', () => {
  it('allows requests up to the limit and refuses the one after it', () => {
    const limiter = new FixedWindowRateLimiter(RULES, makeTestClock(new Date('2026-01-01T00:00:00Z')).clock);

    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(true);
    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(true);

    const refused = limiter.consume(perAddress, 'a@example.com');
    expect(refused.allowed).toBe(false);
    expect(refused.retryAfterSeconds).toBe(1);
  });

  it('counts each key separately', () => {
    const limiter = new FixedWindowRateLimiter(RULES, makeTestClock(new Date('2026-01-01T00:00:00Z')).clock);

    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(true);
    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(true);
    expect(limiter.consume(perAddress, 'b@example.com').allowed).toBe(true);
    expect(limiter.consume(perAddress, 'b@example.com').allowed).toBe(true);
    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(false);
    expect(limiter.consume(perAddress, 'b@example.com').allowed).toBe(false);
  });

  it('applies the limit of the scope it is asked about', () => {
    const limiter = new FixedWindowRateLimiter(RULES, makeTestClock(new Date('2026-01-01T00:00:00Z')).clock);

    for (let i = 0; i < 3; i++) {
      expect(limiter.consume(perSource, '10.0.0.1').allowed).toBe(true);
    }
    expect(limiter.consume(perSource, '10.0.0.1').allowed).toBe(false);
    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(true);
  });

  it('starts a new window once the old one has passed', () => {
    const tc = makeTestClock(new Date('2026-01-01T00:00:00Z'));
    const limiter = new FixedWindowRateLimiter(RULES, tc.clock);

    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(true);
    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(true);
    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(false);

    tc.advance(1000);

    expect(limiter.consume(perAddress, 'a@example.com').allowed).toBe(true);
  });

  it('rounds the retry hint up to whole seconds', () => {
    const tc = makeTestClock(new Date('2026-01-01T00:00:00Z'));
    const limiter = new FixedWindowRateLimiter(
      { slow: { limit: 1, windowMs: 60_000 } },
      tc.clock,
    );

    expect(limiter.consume('slow', 'k').allowed).toBe(true);
    tc.advance(1000);

    expect(limiter.consume('slow', 'k')).toEqual({ allowed: false, retryAfterSeconds: 59 });
  });

  it('allows anything in a scope it has no rule for', () => {
    const limiter = new FixedWindowRateLimiter(RULES, makeTestClock(new Date()).clock);
    expect(limiter.consume('unlimited', 'k')).toEqual({
      allowed: true,
      retryAfterSeconds: 0,
    });
  });

  it('forgets keys from windows that have passed, so the table cannot grow without bound', () => {
    const tc = makeTestClock(new Date('2026-01-01T00:00:00Z'));
    const limiter = new FixedWindowRateLimiter(RULES, tc.clock);

    for (let i = 0; i < 2000; i++) {
      limiter.consume(perAddress, `user-${i}@example.com`);
    }
    expect(limiter.size).toBeGreaterThan(1000);

    tc.advance(10_000);
    limiter.consume(perAddress, 'someone-else@example.com');

    expect(limiter.size).toBeLessThanOrEqual(1);
  });
});
