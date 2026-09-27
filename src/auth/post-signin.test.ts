import { describe, expect, it } from 'vitest';

import { postSigninPath } from './post-signin.js';
import type { OnboardingState } from '../domain/types.js';

describe('postSigninPath', () => {
  it('sends a brand-new user to topic selection', () => {
    expect(postSigninPath('not_started')).toBe('/onboarding/pick-topics');
  });

  it('sends a user who picked topics to the delivery-time step', () => {
    expect(postSigninPath('topics_picked')).toBe('/onboarding/delivery-time');
  });

  it('sends a set-up user straight to their topics', () => {
    expect(postSigninPath('delivery_set')).toBe('/topics');
  });

  it('sends a completed user to their topics', () => {
    expect(postSigninPath('completed')).toBe('/topics');
  });

  it('covers every onboarding state', () => {
    const states: readonly OnboardingState[] = [
      'not_started',
      'topics_picked',
      'delivery_set',
      'completed',
    ];
    for (const state of states) {
      expect(postSigninPath(state)).toBeTruthy();
    }
  });
});
