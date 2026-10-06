import { TIERS, type Tier } from './types.js';

/**
 * What a User's tier entitles them to, in one place.
 *
 * The glossary is the source of these numbers: FreeTier is 3 Topics, 30-day
 * Archive retention and 3 days of trends; PaidTier is unlimited Topics,
 * indefinite retention and the full trends history. A `null` duration means
 * "no limit" rather than "zero", so a caller never has to invent a sentinel.
 */
export interface TierEntitlements {
  /** How many Topics a User may hold at once. */
  readonly topicCap: number;
  /** How far back the Archive reaches, or null for everything. */
  readonly archiveRetentionDays: number | null;
  /** How far back the trends view reaches, or null for the whole history. */
  readonly trendHistoryDays: number | null;
  /**
   * Always null. A BriefSnapshot is the record of what was actually sent, so it
   * is retained forever on both tiers and no retention sweep may touch it. It is
   * spelled out here rather than left implicit so the exemption cannot be lost
   * when the other two durations are retuned.
   */
  readonly snapshotRetentionDays: null;
}

const ENTITLEMENTS: Readonly<Record<Tier, TierEntitlements>> = Object.freeze({
  free: Object.freeze({
    topicCap: 3,
    archiveRetentionDays: 30,
    trendHistoryDays: 3,
    snapshotRetentionDays: null,
  }),
  paid: Object.freeze({
    topicCap: Number.POSITIVE_INFINITY,
    archiveRetentionDays: null,
    trendHistoryDays: null,
    snapshotRetentionDays: null,
  }),
});

/** The tier a User is on until something says otherwise. */
export const DEFAULT_TIER: Tier = 'free';

export function isTier(value: unknown): value is Tier {
  return typeof value === 'string' && (TIERS as readonly string[]).includes(value);
}

export function entitlementsFor(tier: Tier): TierEntitlements {
  return ENTITLEMENTS[tier];
}

export function topicCapFor(tier: Tier): number {
  return ENTITLEMENTS[tier].topicCap;
}

/**
 * How far past their cap a User is holding Topics, or null for one who is not.
 *
 * The counterpart to the paywall, and deliberately a different comparison. "At the
 * cap" is the refusal to add another Topic and holds for `held >= cap`; this is
 * the question of what happens to the Topics somebody already holds once their cap
 * is lower than the number of them, and it holds for `held > cap`. A User at
 * exactly the cap has nothing over it and is asked nothing.
 *
 * Derived rather than stored, from the tier and a count, because that is all it is:
 * a paid User who ends up over the free cap is in exactly this state whether they
 * cancelled, whether the provider ended the Subscription, or whether a development
 * switch moved them — and one rule that covers all three is a rule that cannot be
 * right for two of them and wrong for the third.
 */
export interface TopicCapOverflow {
  /** How many Topics this tier holds at once. */
  readonly cap: number;
  /** How many the User holds now. */
  readonly held: number;
  /** How many of them are over the cap. */
  readonly overBy: number;
}

export function topicCapOverflow(tier: Tier, held: number): TopicCapOverflow | null {
  const cap = topicCapFor(tier);
  return held > cap ? { cap, held, overBy: held - cap } : null;
}

/**
 * The tier of the User in hand. Services that gate on tier take the result of
 * this rather than a literal, so a test exercising a paywall has to put a User
 * on the tier it is testing rather than assert that a branch works.
 */
export function resolveTier(user: { readonly tier: Tier }): Tier {
  return user.tier;
}
