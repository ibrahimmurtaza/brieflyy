import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
  preHandlerHookHandler,
} from 'fastify';

import type { OnboardingService } from '../onboarding/onboarding-service.js';
import { requestRefusedPage } from '../pages/refused.js';
import { accountForUnaskedPage } from '../pages/shell.js';
import { isJsonSurface } from './access.js';
import { requestTokenMismatch } from './request-token.js';

export interface WriteGuardOptions {
  readonly onboardingService: OnboardingService;
}

/**
 * The cross-site guard, in one hook rather than a line in every write.
 *
 * ADR-0021 put the check in the Feedback route and left the rest visibly
 * without it, which was the right shape while there was one route to prove it on
 * and the wrong shape once the claim had to be true of the application: a check
 * per route is a check a route can leave out. Here the route says what it is
 * (`config: { stateChange: 'guarded' }`) and this says what that means, so the
 * declaration cannot be quietly untrue — and
 * `src/http/write-guard.test.ts` enumerates the routes the application
 * registers and fails the build for one that declares nothing and is not a named
 * exemption.
 *
 * The check is a route-level hook, which is what makes it run where it does. It
 * lands after the instance hooks have resolved the session, so the refusal can
 * carry the shell, and before the handler, so a submission is refused before the
 * body is read for anything: what a forged submission says about a Topic is not
 * worth answering.
 *
 * A request with no session is left to the route. There is nothing for it to
 * spend — an authenticated route sends it to `/signup` before it reaches a
 * handler, and the one public write that reads a session cookie finds none — so
 * answering it here would replace the true answer with a false one, and would
 * take it away from `src/http/route-guard.test.ts` to hold. What a page elsewhere
 * can cause always carries the session cookie, which is why that is the case the
 * guard reads.
 */
export function installWriteGuard(
  app: FastifyInstance,
  opts: WriteGuardOptions,
): void {
  app.addHook('onRoute', (routeOptions) => {
    const options = routeOptions as RouteOptions;
    if (options.config?.stateChange !== 'guarded') return;
    const guard: preHandlerHookHandler = async (req: FastifyRequest, reply: FastifyReply) => {
      if (!req.auth) return undefined;
      if (!requestTokenMismatch(req)) return undefined;
      if (isJsonSurface(req.url)) {
        return reply.code(403).send({ error: 'forbidden' });
      }
      return reply
        .code(403)
        .type('text/html; charset=utf-8')
        .send(
          requestRefusedPage({
            account: await accountForUnaskedPage(req, opts.onboardingService),
            requestToken: req.requestToken ?? null,
          }),
        );
    };
    // Appended rather than assigned, because a route is allowed to bring its own
    // preHandler and a guard that replaced it would be a guard that silently
    // switched one of them off.
    const existing = options.preHandler;
    options.preHandler =
      existing === undefined
        ? guard
        : (Array.isArray(existing) ? [...existing, guard] : [existing, guard]);
  });
}