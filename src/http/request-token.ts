import type { FastifyInstance, FastifyRequest } from 'fastify';

import { REQUEST_TOKEN_COOKIE_NAME, REQUEST_TOKEN_FIELD } from '../config.js';
import type { RandomSource } from '../domain/crypto.js';
import { escapeHtml } from '../domain/html.js';

declare module 'fastify' {
  interface FastifyRequest {
    /**
     * The token this request's page echoes into every one of its forms. Set for
     * every request the hooks below run on, so a renderer can read it rather
     * than being handed one.
     */
    requestToken?: string;
  }
}

export interface InstallRequestTokenOptions {
  readonly random: RandomSource;
  readonly secure: boolean;
}

/**
 * The request token: a value a page carries in every one of its forms and the
 * application echoes in a cookie, checked together before a submission is
 * allowed to change anything.
 *
 * The pair is the defence, and both halves are needed. A page on another site
 * can cause the browser to send this application's cookies, and it cannot read
 * them or guess one: the cookie is httpOnly so script on the page cannot read it,
 * and the value in the markup is one the page itself would have had to render.
 * A submission naming no token, or naming one the cookie does not, therefore
 * came from somewhere other than a page this application rendered.
 *
 * The token is random on its own account. It names no User, no session and no
 * address, so it tells a reader of the page nothing the page does not already
 * show them.
 *
 * What is not claimed: that the value in the markup is unreadable. It is in the
 * document, and anything in the document is readable by whatever can read the
 * document. The httpOnly cookie is the half that script on the page cannot get
 * at, which is why the check needs both.
 */
export function installRequestToken(
  app: FastifyInstance,
  opts: InstallRequestTokenOptions,
): void {
  app.decorateRequest('requestToken', '');
  app.addHook('preHandler', async (req) => {
    const fromCookie = req.cookies[REQUEST_TOKEN_COOKIE_NAME];
    if (typeof fromCookie === 'string' && fromCookie.length > 0) {
      req.requestToken = fromCookie;
      return;
    }
    req.requestToken = opts.random.uuid() + opts.random.uuid();
  });
  app.addHook('onSend', async (req, reply) => {
    // Set on the pages the browser will keep and on nothing else: the token
    // only matters where a form will echo it back, so a JSON answer or a
    // redirect has nothing to carry it for.
    if (req.cookies[REQUEST_TOKEN_COOKIE_NAME]) return;
    const contentType = reply.getHeader('content-type');
    if (typeof contentType !== 'string' || !contentType.includes('text/html')) {
      return;
    }
    reply.setCookie(REQUEST_TOKEN_COOKIE_NAME, req.requestToken!, {
      httpOnly: true,
      sameSite: 'lax',
      secure: opts.secure,
      path: '/',
    });
  });
}

/**
 * The hidden field a POST form carries.
 *
 * Written once here and read from the page builders rather than spelled out in
 * each of them, so the field name is one name: a form that echoed a field the
 * guard does not read would be a form the guard cannot check, and the two would
 * disagree without anybody noticing.
 */
export function requestTokenInput(token: string): string {
  return `<input type="hidden" name="${REQUEST_TOKEN_FIELD}" value="${escapeHtml(token)}">`;
}

/**
 * True when the submission does not name the token the cookie names.
 *
 * Missing on either side, or one value where the other names another, is a
 * refusal. Both halves are read rather than either, because a submission that
 * carried the field alone would pass a check that only looked at the form.
 */
export function requestTokenMismatch(req: FastifyRequest): boolean {
  const fromCookie = req.cookies[REQUEST_TOKEN_COOKIE_NAME];
  const body = (req.body ?? {}) as Record<string, unknown>;
  const fromBody = body[REQUEST_TOKEN_FIELD];
  if (typeof fromCookie !== 'string' || fromCookie.length === 0) return true;
  if (typeof fromBody !== 'string' || fromBody.length === 0) return true;
  return fromCookie !== fromBody;
}