import type { FastifyInstance } from 'fastify';

import { escapeHtml } from '../domain/html.js';
import { isTier } from '../domain/tier.js';
import { AUTHENTICATED_ROUTE_CONFIG, requireAuthPage } from '../http/access.js';
import { layout, type ShellAccount } from '../pages/layout.js';
import { resolveShellAccount } from '../pages/shell.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import type { UserRepo } from '../repos/user-repo.js';

export interface TierRoutesOptions {
  readonly userRepo: UserRepo;
  /** What the shell's header says about the signed-in User. */
  readonly onboardingService: OnboardingService;
}

/**
 * The supported way to put a User on a tier during development and testing.
 *
 * Billing is not connected, so there is nothing to charge for; that makes the
 * paywalls untestable end to end unless a User can be moved onto the paid tier
 * deliberately. This is that switch: it writes the same column the application
 * reads, so a test that uses it exercises the real path rather than a special
 * case. It is only registered when the dev tools are on, so a production
 * instance has no route to flip a User's tier at all.
 */
export async function registerTierRoutes(
  fastify: FastifyInstance,
  opts: TierRoutesOptions,
): Promise<void> {
  const { userRepo, onboardingService } = opts;

  fastify.post<{ Body: { tier?: string } }>(
    '/dev/tier',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const requested = (req.body ?? {}).tier;
      if (!isTier(requested)) {
        return reply.code(400).type('text/html').send(
          badTierPage(
            String(requested ?? ''),
            await resolveShellAccount(req.auth, onboardingService),
            req.requestToken ?? null,
          ),
        );
      }
      await userRepo.setTier(req.auth.user.id, requested);
      // Back to a real screen rather than a bare confirmation, so the change is
      // visible where it takes effect.
      return reply.code(302).header('location', '/topics').send();
    },
  );
}

/**
 * The refused switch, rendered through the shell.
 *
 * It used to be a standalone document with its own `<style>` block and no
 * navigation, which is the one thing the application shell exists to prevent: a
 * User who mistyped a development switch landed on a page with no way back into
 * the product, on a screen that looked nothing like the one they came from.
 */
function badTierPage(requested: string, account: ShellAccount, requestToken: string | null): string {
  return layout({
    title: 'Unknown tier',
    width: 'narrow',
    account,
    requestToken,
    body: `    <h1>Unknown tier</h1>
    <p class="error-summary" role="alert"><strong>&ldquo;${escapeHtml(
      requested,
    )}&rdquo; is not a tier.</strong> Use <code>free</code> or <code>paid</code>.</p>
    <p>Your tier has not been changed.</p>
    <p class="actions"><a class="button" href="/topics">Back to your topics</a></p>`,
  });
}
