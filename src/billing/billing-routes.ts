import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { escapeHtml } from '../domain/html.js';
import type { CheckoutRefusal, PaymentEventOutcome } from './billing-service.js';
import type { BillingService } from './billing-service.js';
import {
  AUTHENTICATED_WRITE_ROUTE_CONFIG,
  PUBLIC_ROUTE_CONFIG,
  requireAuthPage,
} from '../http/access.js';
import { layout, type ShellAccount } from '../pages/layout.js';
import { resolveShellAccount } from '../pages/shell.js';
import type { OnboardingService } from '../onboarding/onboarding-service.js';
import { BILLING_WEBHOOK_PATH, CHECKOUT_PATH } from './paths.js';
import { STRIPE_SIGNATURE_HEADER } from './stripe-payment-provider.js';

export interface BillingRoutesOptions {
  readonly billingService: BillingService;
  /** The shell's header and the way back, for the page a refusal answers with. */
  readonly onboardingService: OnboardingService;
}

/**
 * The two billing routes, which have almost nothing in common and are registered
 * together for one reason: they are the whole public-ish surface of the layer, and
 * a second file would be a second place to look for what it can reach.
 *
 * One is a page's write and lives behind the session and the cross-site guard.
 * The other is nobody's write but the provider's, and is public for the same
 * reason the magic link is.
 */
export async function registerBillingRoutes(
  fastify: FastifyInstance,
  opts: BillingRoutesOptions,
): Promise<void> {
  const { billingService, onboardingService } = opts;

  fastify.post(CHECKOUT_PATH, AUTHENTICATED_WRITE_ROUTE_CONFIG, async (req, reply) => {
    if (!requireAuthPage(req, reply)) return reply;
    const outcome = await billingService.startCheckout(req.auth.user, req.auth.account);
    if (outcome.status === 'started') {
      return reply.code(302).header('location', outcome.url).send();
    }
    return refuseCheckout(
      reply,
      outcome.reason,
      await resolveShellAccount(req.auth, onboardingService),
      req.requestToken ?? null,
    );
  });

  await registerWebhookRoute(fastify, billingService);
}

/**
 * The event the payment provider sends when a Checkout completes.
 *
 * Public, and necessarily so: the provider is not signed in and cannot be. It
 * authorises by signature rather than by session, which is why the raw bytes are
 * what it reads — a parsed body can be re-serialised into something equal as JSON
 * and different as a message, and a check against the re-serialised form would be
 * a check of something nobody signed.
 *
 * Registered in its own encapsulated scope so the JSON parser that hands it the
 * body as a string cannot change for anything else: the application's own JSON
 * surface keeps parsing into objects, and this one keeps the exact bytes.
 */
async function registerWebhookRoute(
  fastify: FastifyInstance,
  billingService: BillingService,
): Promise<void> {
  await fastify.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser(
      'application/json',
      { parseAs: 'string' as const },
      (_req, body: string, done) => {
        done(null, { raw: body });
      },
    );

    scope.post(
      BILLING_WEBHOOK_PATH,
      // Public by declaration, and named in PUBLIC_ROUTES with the reason. It
      // changes state and is not behind the cross-site guard, which is written
      // down in WRITE_GUARD_EXEMPTIONS: there is no Brieflyy page behind a
      // provider, so there is no field to echo the request token in.
      PUBLIC_ROUTE_CONFIG,
      async (req: FastifyRequest, reply: FastifyReply) => {
        const outcome = await billingService.applySignedRequest({
          body: rawBody(req),
          signature: header(req, STRIPE_SIGNATURE_HEADER),
        });
        return answerWebhook(reply, outcome, req);
      },
    );
  });
}

/**
 * The exact bytes of this request, as the parser above left them.
 *
 * An empty string rather than a missing field when the parser did not run, so a
 * request that arrives in some other shape is a signature over nothing and is
 * refused — which is the answer — rather than a crash in a function whose whole
 * job is to be sure.
 */
function rawBody(req: FastifyRequest): string {
  const raw = (req.body as { raw?: unknown } | undefined)?.raw;
  return typeof raw === 'string' ? raw : '';
}

/** One header as a string, or empty when it is absent or repeated. */
function header(req: FastifyRequest, name: string): string {
  const value = req.headers[name];
  return typeof value === 'string' ? value : '';
}

/**
 * What a signed event is answered with.
 *
 * Two answers, and the split between them is a claim to the provider: a request
 * whose signature did not hold is refused with a 400, which is how a caller is
 * told the message is not one to retry, and everything else — including an event
 * this application cannot act on, and a replay of one it already acted on — is
 * answered 200 so the provider stops delivering it. Retrying a forged request
 * forever would be noise; refusing a genuine one would leave a paid User unpaid.
 */
function answerWebhook(
  reply: FastifyReply,
  outcome: PaymentEventOutcome,
  req: FastifyRequest,
): FastifyReply {
  switch (outcome.status) {
    case 'accepted':
      req.log.info({ userId: outcome.userId }, 'checkout completed; the user is on the paid tier');
      return reply.code(200).type('text/plain; charset=utf-8').send('Paid.');
    case 'replayed':
      req.log.info({ eventId: outcome.eventId }, 'payment event already applied');
      return reply.code(200).type('text/plain; charset=utf-8').send('Already applied.');
    case 'unsigned':
      req.log.warn('a payment event arrived with a signature that did not hold');
      return reply.code(400).type('text/plain; charset=utf-8').send('Signature mismatch.');
    case 'unrecognised':
      // The signature held, so this genuinely came from the provider — it is about
      // something other than a completed Checkout. Acknowledged so the provider
      // stops delivering it; a 5xx here would have it retry for days.
      req.log.info('a payment event arrived for something this application does not act on');
      return reply.code(200).type('text/plain; charset=utf-8').send('Ignored.');
    case 'unknown_checkout':
      // The signature held, so this really was sent by the provider — it is about
      // a Checkout this application has no record of starting. Logged rather than
      // refused, because a 5xx would have the provider retry for days something
      // no retry can fix.
      req.log.warn(
        { reference: outcome.reference },
        'a payment event named a checkout reference this application never issued',
      );
      return reply.code(200).type('text/plain; charset=utf-8').send('Ignored.');
    case 'not_configured':
      req.log.warn('a payment event arrived at an instance with no payment provider');
      return reply.code(503).type('text/plain; charset=utf-8').send('Billing is not configured.');
  }
}

/**
 * A Checkout that could not be started.
 *
 * A page rather than a bare status, because the caller is a person mid-submission
 * on a Brieflyy page: they pressed a button and something went wrong, and the two
 * refusals are told apart so they are not both sent to the same dead end. 503 for
 * the instance that has no PaymentProvider — the route exists and the deployment
 * is what is incomplete, which is the same answer `/auth/google/*` gives on an
 * instance with no Provider — and 502 when a configured provider was asked and
 * could not answer, which is a fact about somebody else's service.
 */
function refuseCheckout(
  reply: FastifyReply,
  reason: CheckoutRefusal,
  account: ShellAccount,
  requestToken: string | null,
): FastifyReply {
  const { code, headline, what } =
    reason === 'not_configured'
      ? {
          code: 503,
          headline: 'Payments are not set up on this Brieflyy',
          what: 'This instance has no payment provider configured, so there is nowhere to pay. Nothing has been charged.',
        }
      : {
          code: 502,
          headline: 'We could not reach the payment provider',
          what: 'Your card was not charged. Try again in a moment.',
        };
  return reply.code(code).type('text/html; charset=utf-8').send(
    layout({
      title: headline,
      width: 'narrow',
      account,
      requestToken,
      body: `    <h1>${escapeHtml(headline)}</h1>
    <div class="error-summary" role="alert"><p>${escapeHtml(what)}</p></div>
    <p class="actions"><a class="button" href="/upgrade">Back to upgrade</a></p>`,
    }),
  );
}