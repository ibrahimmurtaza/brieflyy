import { resolveTier } from '../domain/tier.js';
import type { CurrentAuth } from '../auth/auth-service.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import { isEmailStopped } from '../services/unsubscribe-service.js';
import type { AuthenticatedRequest } from '../http/access.js';
import type { ShellAccount, ShellBrief } from './layout.js';

/**
 * How a route asks who is signed in.
 *
 * A curried function rather than a bare resolver because two route modules need
 * it and neither of them should be reaching into `OnboardingService` itself: the
 * header's contents are one question with one answer, and a route that assembled
 * them out of the repositories could answer it differently from the page beside
 * it.
 */
export function shellAccountFor(
  onboardingService: OnboardingService,
): (req: AuthenticatedRequest) => Promise<ShellAccount> {
  return (req) => resolveShellAccount(req.auth, onboardingService);
}

/**
 * The signed-in User as the shared header states them.
 *
 * One function, called once per request, because the header is on every page and
 * the three facts it carries are exactly the three a page would otherwise have to
 * work out for itself: who is signed in, which tier they are on, and when mail
 * next arrives. Two pages that each derived the next brief would be two chances
 * to show a different time, and the header is what a User believes from every
 * other page.
 *
 * The tier and the opt-out are read off the session rather than fetched again:
 * the User is loaded on every authenticated request already, so the values here
 * are in hand and a second query would only ever agree with them. The DeliveryTime
 * is not on the session, so that one is read — and only when it can matter, since
 * a User who has stopped their emails has nothing scheduled to look up.
 */
export async function resolveShellAccount(
  auth: CurrentAuth,
  onboardingService: OnboardingService,
): Promise<ShellAccount> {
  const account = { email: auth.account.email, tier: resolveTier(auth.user) };
  // `isEmailStopped` is the one answer to "is this stopped", so the header asks
  // it rather than reading the column itself. The scope is named by the null: the
  // header speaks for the whole User, and a Topic turned off on its own still
  // leaves the rest of their mail arriving.
  const stopped = isEmailStopped({
    userUnsubscribedAt: auth.user.unsubscribedAt,
    topicUnsubscribedAt: null,
  });
  if (stopped) return { ...account, brief: { kind: 'stopped' } };

  const next = await onboardingService.nextDeliverySlot(auth.user.id);
  if (!next) return { ...account, brief: { kind: 'unset' } };
  const brief: ShellBrief = {
    kind: 'scheduled',
    slot: next.slot,
    timezone: next.timezone,
  };
  return { ...account, brief };
}