import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { PUBLIC_ROUTE_CONFIG } from '../http/access.js';
import { escapeHtml } from '../domain/html.js';
import { layout } from '../pages/layout.js';
import type { Topic, UnsubscribeScope } from '../domain/types.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type {
  UnsubscribeOutcome,
  UnsubscribeRefusal,
  UnsubscribeService,
} from './unsubscribe-service.js';
import { UNSUBSCRIBE_ALL_PATH, UNSUBSCRIBE_TOPIC_PATH } from './unsubscribe-links.js';

export interface UnsubscribeRoutesOptions {
  readonly unsubscribeService: UnsubscribeService;
  /**
   * The Topics, so the confirmation page can name the one that was stopped. The
   * outcome already carries the id; the title is what a reader recognises.
   */
  readonly topicRepo: TopicRepo;
}

interface UnsubscribeQuery {
  readonly token?: string;
}

interface UnsubscribeBody {
  readonly token?: string;
}

/**
 * The two ways a reader stops the mail.
 *
 * One-click clients never render the link in the body: they read
 * `List-Unsubscribe` and POST to it themselves, without the reader doing
 * anything. Every other client — and every reader who pastes the link into a
 * browser, which is what happens when a provider strips the headers — follows it
 * as a GET. Both are registered, and both do the same thing, because a reader who
 * has just followed the only stop control a brief offers has asked to stop the
 * mail whether or not their client was helpful enough to do it for them.
 *
 * Public, and necessarily so: the token is the authorisation, and a reader
 * following a link in their inbox is by definition not signed in. What the token
 * resolves to decides whose subscription changes, and nothing in the URL is
 * believed about that.
 */
export async function registerUnsubscribeRoutes(
  fastify: FastifyInstance,
  opts: UnsubscribeRoutesOptions,
): Promise<void> {
  const { unsubscribeService, topicRepo } = opts;

  const stop = async (
    req: FastifyRequest,
    scope: UnsubscribeScope,
  ): Promise<UnsubscribeOutcome> => {
    const token = readToken(req);
    if (token === null) {
      return { status: 'invalid', reason: 'unknown_token' };
    }
    return scope === 'this_topic'
      ? unsubscribeService.unsubscribeFromTopic(token)
      : unsubscribeService.unsubscribeFromAll(token);
  };

  // One path and one scope per entry, and each gets both methods. Registering
  // the pair from a table rather than four times over is what keeps the two
  // scopes honest about being the same feature: there is no way for one of them
  // to end up with a GET and the other with only a POST.
  const SCOPES: readonly { readonly path: string; readonly scope: UnsubscribeScope }[] = [
    { path: UNSUBSCRIBE_TOPIC_PATH, scope: 'this_topic' },
    { path: UNSUBSCRIBE_ALL_PATH, scope: 'global' },
  ];

  for (const { path, scope } of SCOPES) {
    // A browser visit. The reader followed the only stop control the brief
    // offered, so it does what it says.
    fastify.get<{ Querystring: UnsubscribeQuery }>(
      path,
      PUBLIC_ROUTE_CONFIG,
      async (req, reply) => {
        const outcome = await stop(req, scope);
        // Null for a global unsubscribe, which names no Topic, so the page can
        // ask the same question either way.
        const topic =
          outcome.status === 'ok' && outcome.topicId !== null
            ? await topicRepo.getById(outcome.topicId)
            : null;
        return reply
          .code(outcome.status === 'ok' ? 200 : 400)
          .type('text/html; charset=utf-8')
          .send(
            confirmationPage({
              outcome,
              scope,
              topic,
              account: accountFor(req, outcome),
            }),
          );
      },
    );

    // The one-click POST. No page, no session, and only the status is read.
    fastify.post<{ Querystring: UnsubscribeQuery; Body: UnsubscribeBody }>(
      path,
      PUBLIC_ROUTE_CONFIG,
      async (req, reply) => {
        const outcome = await stop(req, scope);
        return reply
          .code(outcome.status === 'ok' ? 200 : 400)
          .type('text/plain; charset=utf-8')
          .send(oneClickBody(outcome));
      },
    );
  }
}

/**
 * The token, from the query string the client POSTs to or from a form body.
 *
 * The query string is the one that matters: it is the URL in `List-Unsubscribe`,
 * and a one-click client POSTs to that URL as it stands. The body is read too
 * because a form post is the other shape a browser can produce, and refusing it
 * would mean the same link worked or not depending on how the reader got there.
 */
function readToken(req: FastifyRequest): string | null {
  const fromQuery = (req.query as UnsubscribeQuery | undefined)?.token;
  if (typeof fromQuery === 'string' && fromQuery.length > 0) return fromQuery;
  const fromBody = (req.body as UnsubscribeBody | undefined)?.token;
  if (typeof fromBody === 'string' && fromBody.length > 0) return fromBody;
  return null;
}

/**
 * The account whose navigation to show, if any.
 *
 * Only when the signed-in User is the one the token unsubscribed. A forwarded
 * brief opened while signed in as somebody else would otherwise put another
 * person's name and sign-out button on a page about somebody else's
 * subscription.
 */
function accountFor(
  req: FastifyRequest,
  outcome: UnsubscribeOutcome,
): string | null {
  const auth = req.auth;
  if (!auth) return null;
  return outcome.status === 'ok' && auth.user.id === outcome.userId
    ? auth.account.email
    : null;
}

/** What a one-click client is told. It reads the status and nothing else. */
function oneClickBody(outcome: UnsubscribeOutcome): string {
  if (outcome.status === 'ok') {
    return outcome.scope === 'this_topic'
      ? 'Unsubscribed from this topic.'
      : 'Unsubscribed from all Brieflyy emails.';
  }
  return humanRefusal(outcome.reason);
}

function humanRefusal(reason: UnsubscribeRefusal): string {
  switch (reason) {
    case 'expired':
      return 'This unsubscribe link has expired. Open Brieflyy to manage your topics.';
    case 'already_used':
      return 'This unsubscribe link has already been used.';
    case 'unknown_token':
      return 'This unsubscribe link is not valid.';
  }
}

function confirmationPage(input: {
  readonly outcome: UnsubscribeOutcome;
  readonly scope: UnsubscribeScope;
  readonly topic: Topic | null;
  readonly account: string | null;
}): string {
  const { outcome } = input;
  if (outcome.status !== 'ok') {
    return layout({
      title: 'Unsubscribe link',
      width: 'narrow',
      account: input.account,
      body: `    <h1>Unsubscribe link</h1>
    <div class="error-summary" role="alert">
      <p>${escapeHtml(humanRefusal(outcome.reason))}</p>
    </div>
    <p class="actions"><a class="button" href="/settings/briefs">Manage your emails</a></p>`,
    });
  }

  const subject = input.scope === 'this_topic' ? input.topic?.title : null;
  const headline =
    subject === null
      ? 'You have stopped all Brieflyy emails'
      : `You have stopped ${subject} briefs`;
  const what =
    subject === null
      ? 'No Brieflyy email will be sent to you again. Your topics are all still here, and any brief already sent is still readable.'
      : `No more briefs on ${subject}. The rest of your topics keep arriving as before.`;

  return layout({
    title: 'Unsubscribed',
    width: 'narrow',
    account: input.account,
    body: `    <h1>${escapeHtml(headline)}</h1>
    <div class="callout callout--success" role="status"><p>${escapeHtml(what)}</p></div>
    <p>Changed your mind? You can turn them back on at any time.</p>
    <p class="actions"><a class="button" href="/settings/briefs">Manage your emails</a></p>`,
  });
}
