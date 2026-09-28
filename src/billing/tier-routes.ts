import type { FastifyInstance } from 'fastify';

import { isTier } from '../domain/tier.js';
import { AUTHENTICATED_ROUTE_CONFIG, requireAuthPage } from '../http/access.js';
import type { UserRepo } from '../repos/user-repo.js';

export interface TierRoutesOptions {
  readonly userRepo: UserRepo;
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
  const { userRepo } = opts;

  fastify.post<{ Body: { tier?: string } }>(
    '/dev/tier',
    AUTHENTICATED_ROUTE_CONFIG,
    async (req, reply) => {
      if (!requireAuthPage(req, reply)) return reply;
      const requested = (req.body ?? {}).tier;
      if (!isTier(requested)) {
        return reply
          .code(400)
          .type('text/html')
          .send(badTierPage(String(requested ?? '')));
      }
      await userRepo.setTier(req.auth.user.id, requested);
      // Back to a real screen rather than a bare confirmation, so the change is
      // visible where it takes effect.
      return reply.code(302).header('location', '/topics').send();
    },
  );
}

function badTierPage(requested: string): string {
  const safe = escape(requested);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Unknown tier &middot; Brieflyy</title>
  <style>
    body { font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem; }
    h1 { font-size: 1.4rem; }
    p { color: #b00020; }
    a { color: #1f6feb; }
  </style>
</head>
<body>
  <main>
    <h1>Unknown tier</h1>
    <p>&ldquo;${safe}&rdquo; is not a tier. Use <code>free</code> or <code>paid</code>.</p>
    <p>Your tier has not been changed.</p>
    <p><a href="/topics">Back to your topics</a></p>
  </main>
</body>
</html>`;
}

function escape(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
