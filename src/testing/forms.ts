import type { FastifyInstance } from 'fastify';

import { REQUEST_TOKEN_COOKIE_NAME, REQUEST_TOKEN_FIELD } from '../config.js';

/** What `app.inject` answers with, named without reaching for its own package. */
type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>;

export interface SignedInCookies {
  /**
   * The `cookie` header a signed-in browser sends: its session and the request
   * token the application's first page set.
   *
   * Passed to `app.inject` for every request rather than only the pages: a page
   * that asked for no token would be a page asking for a forgery, which is not
   * what a test means to do.
   */
  readonly cookies: string;
  /** The value every POST form on a Brieflyy page echoes back. */
  readonly token: string;
}

/**
 * The cookies a signed-in browser holds, and the token they name.
 *
 * Every state-changing route refuses a submission the request-token cookie does
 * not agree with (ADR-0021), so a test that drives one has to carry the pair —
 * and should not have to know how it gets one. Asked of the application the way a
 * browser is: by being handed a page. A harness holding only a session cookie
 * cannot submit a form any more, which is the same rule the application is held
 * to, arrived at from the other side.
 */
export async function signedInCookies(
  app: FastifyInstance,
  sessionCookie: string,
): Promise<SignedInCookies> {
  const page = await app.inject({
    method: 'GET',
    url: '/topics',
    headers: { cookie: sessionCookie },
  });
  const raw = page.headers['set-cookie'];
  const cookies = Array.isArray(raw) ? raw : [raw];
  const tokenCookie = cookies
    .filter((c): c is string => typeof c === 'string')
    .find((c) => c.startsWith(`${REQUEST_TOKEN_COOKIE_NAME}=`));
  if (!tokenCookie) {
    throw new Error(
      `no ${REQUEST_TOKEN_COOKIE_NAME} cookie on the first signed-in page: a test harness has to hand itself a page`,
    );
  }
  const value = tokenCookie.split(';')[0]!;
  return { cookies: `${sessionCookie}; ${value}`, token: value.slice(value.indexOf('=') + 1) };
}

/**
 * The token the request-token cookie names, out of a `cookie` header.
 *
 * Read back rather than carried beside it, because the guard compares the two and
 * a helper that could be handed one value for the cookie and another for the body
 * is a helper that can make a test pass on a submission the application would
 * refuse.
 */
export function requestTokenOf(cookies: string): string {
  for (const pair of cookies.split(';')) {
    const [name, ...rest] = pair.trim().split('=');
    if (name === REQUEST_TOKEN_COOKIE_NAME) return rest.join('=');
  }
  throw new Error(
    `no ${REQUEST_TOKEN_COOKIE_NAME} in ${JSON.stringify(cookies)}: a signed-in browser has one`,
  );
}

/**
 * A form submitted the way a Brieflyy page submits one.
 *
 * The body is urlencoded and carries the hidden field every form on a signed-in
 * page carries, read out of the cookies the same browser holds. `fields` is
 * either a record of them or the urlencoded body a test has already written, for
 * the cases where the exact bytes are the point; sending JSON instead would still
 * be answered by the routes, but a form submission is not JSON and the tests
 * that care about a route reading its own fields are better off not being the
 * only place the shape is exercised.
 */
export async function submitForm(
  app: FastifyInstance,
  cookies: string,
  url: string,
  fields: Record<string, string | number | readonly string[]> | string = {},
): Promise<InjectResponse> {
  const body = new URLSearchParams(typeof fields === 'string' ? fields : '');
  if (typeof fields !== 'string') {
    for (const [name, value] of Object.entries(fields)) {
      for (const one of typeof value === 'object' ? value : [value]) {
        body.append(name, String(one));
      }
    }
  }
  body.set(REQUEST_TOKEN_FIELD, requestTokenOf(cookies));
  return app.inject({
    method: 'POST',
    url,
    headers: {
      cookie: cookies,
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload: body.toString(),
  });
}