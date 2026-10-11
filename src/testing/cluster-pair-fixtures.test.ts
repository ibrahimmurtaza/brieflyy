import { describe, expect, it } from 'vitest';

import {
  ALL_CLUSTER_PAIRS,
  corpusRefKey,
  DIFFERENT_EVENT_PAIRS,
  SAME_EVENT_PAIRS,
  type Boilerplate,
  type LabelledStoryPair,
} from './cluster-pair-fixtures.js';

/**
 * The two sets the benchmark scores against, held to the shape that makes them
 * worth scoring against.
 *
 * This is a guard on the fixture rather than on the rule: a benchmark measuring
 * an empty set, or an easy one, reports a number that looks like a measurement
 * and is not. What it cannot check without a corpus is whether an untagged
 * different-event pair really does share enough with its partner to be hard —
 * that is what the `note` on each one is for, and what the person who labelled
 * it is answerable for.
 */
export const GUARD = 'the labelled pairs are the shape the benchmark needs';

function refOf(pair: LabelledStoryPair, side: 'left' | 'right'): string {
  return corpusRefKey(pair[side].source, pair[side].externalId);
}

/** The most pairs a hand reviewer would label in one sitting. */
const REVIEWABLE_PAIR_COUNT = 120;

describe('the labelled Story pairs', () => {
  it('holds pairs in both sets, because recall and precision are different questions', () => {
    expect(SAME_EVENT_PAIRS.length).toBeGreaterThan(10);
    expect(DIFFERENT_EVENT_PAIRS.length).toBeGreaterThan(10);
  });

  it('stays small enough to be read and checked by a person', () => {
    expect(SAME_EVENT_PAIRS.length).toBeLessThanOrEqual(REVIEWABLE_PAIR_COUNT);
    expect(DIFFERENT_EVENT_PAIRS.length).toBeLessThanOrEqual(REVIEWABLE_PAIR_COUNT);
  });

  it('names two different Stories in every pair', () => {
    for (const pair of ALL_CLUSTER_PAIRS) {
      expect(refOf(pair, 'left'), pair.note).not.toBe(refOf(pair, 'right'));
    }
  });

  it('says why every pair carries the label it does', () => {
    for (const pair of ALL_CLUSTER_PAIRS) {
      expect(pair.note.length, refOf(pair, 'left')).toBeGreaterThan(10);
      expect(pair.left.headline.length).toBeGreaterThan(0);
      expect(pair.right.headline.length).toBeGreaterThan(0);
    }
  });

  it('carries the recurring-column cases a boilerplate-sensitive rule would fuse', () => {
    const classes = new Set(
      DIFFERENT_EVENT_PAIRS.map((pair) => pair.boilerplate).filter(
        (value): value is Boilerplate => value !== undefined,
      ),
    );

    expect([...classes].sort()).toEqual([
      'advice-column',
      'best-of-list',
      'daily-analyst-calls',
      'daily-newsletter',
      'deal-roundup',
      'market-wrap',
      'poll-series',
      'weekly-cartoon-roundup',
    ]);
  });

  it('tags no same-event pair with a boilerplate class, which belongs to the other set', () => {
    for (const pair of SAME_EVENT_PAIRS) {
      expect(pair.boilerplate).toBeUndefined();
    }
  });
});