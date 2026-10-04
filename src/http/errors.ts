import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { OnboardingService } from '../onboarding/onboarding-service.js';
import { isJsonSurface } from './access.js';
import { layout, type ShellAccount } from '../pages/layout.js';
import { resolveShellAccount } from '../pages/shell.js';

/**
 * What an unexpected failure answers.
 *
 * The application had no error handler, so any thrown error became Fastify's own
 * reply: `{"statusCode":500,"error":"Internal Server Error","message":"sqlite: no
 * such column: accounts.emial"}` — a document, with the failure itself inside it,
 * for a User who had asked a page. The one handler that existed was the not-found
 * handler, and it answered the wrong question: an address that leads nowhere is
 * not a route that failed.
 *
 * The rule is the one the not-found handler already follows, because the two
 * answer the same way round: `/api/` is a JSON surface and answers JSON, and
 * everything else is a page. A User gets a page they can read and leave; a
 * machine gets a body it can branch on. `isJsonSurface` is that rule in one place,
 * read from both handlers rather than written out in each.
 *
 * What is never sent is the failure itself. It goes to the request log, which the
 * server entrypoint turns on, and a SQL message is not something to hand to
 * whoever asked the page. `pnpm dev` builds the application with the same handler,
 * so a developer reads the error where it was logged rather than in the browser.
 */
export interface ErrorHandlerOptions {
  readonly onboardingService: OnboardingService;
}

export function setApplicationErrorHandler(
  fastify: FastifyInstance,
  opts: ErrorHandlerOptions,
): void {
  fastify.setErrorHandler(async (error, req, reply) => {
    const status = statusOf(error);
    req.log.error({ err: error, statusCode: status }, 'request failed');
    // Nothing can be said once the bytes have gone, which is what a stream that
    // failed midway looks like.
    if (reply.sent) return;
    if (isJsonSurface(req.url)) {
      return reply.code(status).send({ error: jsonErrorFor(status) });
    }
    const account = await accountForFailedRequest(req, opts.onboardingService);
    return reply
      .code(status)
      .type('text/html; charset=utf-8')
      .send(failedRequestPage(account, status));
  });
}

/**
 * The status the failure is reported under.
 *
 * A 4xx carries one of its own: a body that would not parse or a media type that
 * is not accepted is the caller's mistake, and answering 500 says the application
 * broke over it. Anything without a usable one is a 500, whatever the error object
 * claims.
 */
function statusOf(error: unknown): number {
  const claimed =
    typeof error === 'object' && error !== null
      ? (error as { statusCode?: unknown }).statusCode
      : undefined;
  if (
    typeof claimed !== 'number' ||
    !Number.isInteger(claimed) ||
    claimed < 400 ||
    claimed > 599
  ) {
    return 500;
  }
  return claimed;
}

/**
 * The one-word reason a machine gets, in the vocabulary the `/api` routes already
 * answer with.
 *
 * Named per status rather than collapsed into one word for every 4xx: a caller
 * handed `bad_request` for a rate limit has been told something false, and
 * `unauthorized` and `not_found` are the codes those routes use for those answers
 * when they refuse a request themselves.
 */
function jsonErrorFor(status: number): string {
  if (status >= 500) return 'internal_error';
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 413:
      return 'payload_too_large';
    case 415:
      return 'unsupported_media_type';
    case 429:
      return 'rate_limited';
    default:
      return 'bad_request';
  }
}

/**
 * The signed-in User for the shell of this page, or null when there is not one.
 *
 * A failure can arrive before the session is resolved — the session lookup is a
 * database read like any other, and can be the thing that fails — so `req.auth` is
 * not a promise. Asking the shell resolver again can fail the same way, and a
 * header is not worth turning one failed request into two.
 */
async function accountForFailedRequest(
  req: FastifyRequest,
  onboardingService: OnboardingService,
): Promise<ShellAccount | null> {
  const auth = req.auth;
  if (!auth) return null;
  try {
    return await resolveShellAccount(auth, onboardingService);
  } catch (err) {
    req.log.error({ err }, 'the shell could not be resolved for the error page');
    return null;
  }
}

/**
 * A request the application could not complete, as a page.
 *
 * Two shapes, because the two situations are not the same and a page that says
 * Brieflyy failed is untrue of a request Brieflyy refused. A 4xx is the caller's to
 * fix, so it is told so; anything else is ours, and says so. The status is in the
 * `<title>`, and neither copy is a diagnosis, so there is nothing in the page for a
 * reader to quote back as a reason.
 */
function failedRequestPage(account: ShellAccount | null, status: number): string {
  const ours = status >= 500;
  return layout({
    title: ours ? 'Something went wrong' : 'Request not accepted',
    width: 'narrow',
    // The header is on every page when there is a signed-in User to put it on, and
    // this page is reached as often inside the application as on the way in — so it
    // carries the navigation when there is one and does not when there is not, for
    // the reason ADR-0009 records rather than by omission.
    account,
    body: `    <h1>${ours ? 'Something went wrong' : 'That request could not be completed'}</h1>
    <div class="error-summary" role="alert">
      <p>${
        ours
          ? 'Brieflyy could not finish that. Please try again.'
          : 'Check what you sent and try again.'
      }</p>
    </div>
    <p class="actions"><a class="button" href="${
      account === null ? '/signup' : '/topics'
    }">${account === null ? 'Sign in' : 'Back to your topics'}</a></p>`,
  });
}