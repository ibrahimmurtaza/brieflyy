import type { OnboardingState } from '../domain/types.js';
import { dayKey } from '../domain/trends.js';

export interface SignInIngestWindowInput {
  /** The instant the sign-in completed. */
  readonly now: Date;
  /** When the account was created, which is the start of the window. */
  readonly createdAt: Date;
  readonly onboardingState: OnboardingState;
}

/**
 * Whether a sign-in is one of the moments that runs an ingest cycle.
 *
 * Two things have to hold, and they are not the same question.
 *
 * **The Topics have to exist.** Ingest reads the union of every live Topic's
 * Sources, so a sign-in from someone who has not picked any has nothing to poll —
 * it is a cycle that reports zero Sources and looks like a failure without being
 * one. The condition here is exactly the one `postSigninPath` uses to send them to
 * the picker instead of the dashboard, so the trigger and the redirect agree by
 * construction: a sign-in that sends someone to pick Topics never also pretends to
 * have refreshed their corpus.
 *
 * **It has to be the day they signed up.** A new User is the one Reader for whom a
 * six-hour-old corpus is visibly wrong — they are being shown the whole of
 * everything, and the stories that arrived since they last closed the tab are the
 * entire reason they came back. So a sign-in refreshes for them on the day they
 * signed up, and after that the interval loop is enough.
 *
 * The comparison is `dayKey`, the UTC day every trend series is already bucketed
 * by, rather than a 24-hour span. A window measured in instants would open and
 * close at a moment no page ever renders, and would make the boundary depend on
 * the hour a stranger happened to arrive. A day boundary is something a Reader can
 * be told plainly — "today" — and matches how the rest of the app buckets time.
 *
 * The cost of getting this wrong is only ever a stale corpus, never a wrong one:
 * inside the window an extra cycle runs, and outside it the six-hour loop still
 * runs on its own.
 */
export function signInRunsIngestCycle(input: SignInIngestWindowInput): boolean {
  if (input.onboardingState === 'not_started') return false;
  return dayKey(input.now) === dayKey(input.createdAt);
}
