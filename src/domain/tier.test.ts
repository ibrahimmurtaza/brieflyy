import { describe, expect, it } from 'vitest';

import {
  DEFAULT_TIER,
  entitlementsFor,
  isTier,
  resolveTier,
  topicCapFor,
} from './tier.js';
import { TIERS } from './types.js';

describe('tier', () => {
  it('has exactly the two tiers the glossary names', () => {
    expect([...TIERS].sort()).toEqual(['free', 'paid']);
  });

  it('starts a User with no stated tier on the free tier', () => {
    expect(DEFAULT_TIER).toBe('free');
  });

  it('caps a FreeTier User at three Topics and does not cap a PaidTier User', () => {
    expect(topicCapFor('free')).toBe(3);
    expect(topicCapFor('paid')).toBe(Number.POSITIVE_INFINITY);
  });

  it('keeps the free tier to 30 days of Archive and 3 days of trends', () => {
    const free = entitlementsFor('free');
    expect(free.archiveRetentionDays).toBe(30);
    expect(free.trendHistoryDays).toBe(3);
  });

  it('gives the paid tier indefinite Archive retention and full trends history', () => {
    const paid = entitlementsFor('paid');
    expect(paid.archiveRetentionDays).toBeNull();
    expect(paid.trendHistoryDays).toBeNull();
  });

  it('retains BriefSnapshots forever on both tiers, because a snapshot is what was sent', () => {
    for (const tier of TIERS) {
      expect(
        entitlementsFor(tier).snapshotRetentionDays,
        `${tier} tier snapshot retention`,
      ).toBeNull();
    }
  });

  it('reads the tier off a User rather than a literal', () => {
    expect(resolveTier({ tier: 'free' })).toBe('free');
    expect(resolveTier({ tier: 'paid' })).toBe('paid');
  });

  it('recognises a tier name, and refuses anything else', () => {
    for (const tier of TIERS) {
      expect(isTier(tier), tier).toBe(true);
    }
    for (const other of ['Free', 'premium', '', 'FREE', null, 7]) {
      expect(isTier(other), String(other)).toBe(false);
    }
  });

  it('does not let a caller reach past the tier record by mutating it', () => {
    const free = entitlementsFor('free');
    expect(Object.isFrozen(entitlementsFor('free'))).toBe(true);
    expect(Object.isFrozen(free)).toBe(true);
  });
});
