import { describe, expect, it } from 'vitest';

import { postSigninPath } from '../auth/post-signin.js';
import type { OnboardingState } from '../domain/types.js';
import { dayKey } from '../domain/trends.js';
import { signInRunsIngestCycle } from './signin-ingest-window.js';

const SIGNED_UP = new Date('2026-09-02T23:40:00Z');
const ALL_STATES: readonly OnboardingState[] = [
  'not_started',
  'topics_picked',
  'delivery_set',
  'completed',
];

describe('the window a sign-in runs an ingest cycle in', () => {
  it('does not run one before any Topic has been picked', () => {
    // The whole point of the guard: ingest reads the union of every live Topic's
    // Sources, so a cycle here would report zero Sources and look broken.
    expect(
      signInRunsIngestCycle({
        now: SIGNED_UP,
        createdAt: SIGNED_UP,
        onboardingState: 'not_started',
      }),
    ).toBe(false);
  });

  it('runs one on the sign-up day for an account that has picked Topics', () => {
    for (const onboardingState of ALL_STATES.filter((s) => s !== 'not_started')) {
      expect(
        signInRunsIngestCycle({ now: SIGNED_UP, createdAt: SIGNED_UP, onboardingState }),
        onboardingState,
      ).toBe(true);
    }
  });

  it('runs one at any hour of the sign-up day, and at no hour of the next', () => {
    // Late in the day and early the next morning are the two cases a 24-hour
    // instant-based window and a day-based one disagree about, and the day-based
    // one is the one that is written down.
    const lastMoment = new Date('2026-09-02T23:59:59Z');
    const firstMoment = new Date('2026-09-03T00:00:00Z');

    expect(
      signInRunsIngestCycle({
        now: lastMoment,
        createdAt: SIGNED_UP,
        onboardingState: 'topics_picked',
      }),
    ).toBe(true);
    expect(
      signInRunsIngestCycle({
        now: firstMoment,
        createdAt: SIGNED_UP,
        onboardingState: 'topics_picked',
      }),
    ).toBe(false);
  });

  it('runs one again on a later day for an account signed up on that day', () => {
    // The window is relative to each account, not a global install-wide grace
    // period: somebody joining on the 9th is a new Reader on the 9th.
    expect(
      signInRunsIngestCycle({
        now: new Date('2026-09-09T08:00:00Z'),
        createdAt: new Date('2026-09-09T07:59:00Z'),
        onboardingState: 'delivery_set',
      }),
    ).toBe(true);
  });

  it('buckets by the same UTC day as every trend series', () => {
    expect(dayKey(SIGNED_UP)).toBe('2026-09-02');
    expect(
      signInRunsIngestCycle({
        now: new Date('2026-09-02T00:00:00Z'),
        createdAt: new Date('2026-09-02T23:59:59Z'),
        onboardingState: 'topics_picked',
      }),
      'an account created at 23:59 is still inside its own day at 00:00 that same UTC day',
    ).toBe(true);
  });

  it('agrees with the redirect it sits next to', () => {
    // The failure this guards against is a sign-in that sends somebody to pick
    // Topics and then also runs a refresh as though they had some. The two read
    // the same field, so they cannot drift apart without a test noticing.
    for (const onboardingState of ALL_STATES) {
      const sentToPick = postSigninPath(onboardingState) === '/onboarding/pick-topics';
      const runs = signInRunsIngestCycle({
        now: SIGNED_UP,
        createdAt: SIGNED_UP,
        onboardingState,
      });
      expect(runs, onboardingState).toBe(!sentToPick);
    }
  });
});
