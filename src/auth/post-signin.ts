import type { OnboardingState } from '../domain/types.js';

export function postSigninPath(onboardingState: OnboardingState): string {
  switch (onboardingState) {
    case 'not_started':
      return '/onboarding/pick-topics';
    case 'topics_picked':
      return '/onboarding/delivery-time';
    case 'delivery_set':
    case 'completed':
      return '/topics';
  }
}
