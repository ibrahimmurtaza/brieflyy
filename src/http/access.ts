import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
  RouteShorthandOptions,
} from 'fastify';

import { layout } from '../pages/layout.js';
import type { CurrentAuth } from '../auth/auth-service.js';
import { UNSUBSCRIBE_ALL_PATH, UNSUBSCRIBE_TOPIC_PATH } from '../services/unsubscribe-links.js';
import { BILLING_WEBHOOK_PATH } from '../billing/paths.js';

/**
 * How much of the application a route exposes. Every route declares one, and
 * `src/http/route-guard.test.ts` fails the build for a route that declares
 * neither, so an unguarded route cannot be added quietly.
 */
export type RouteAccess = 'public' | 'authenticated';

/**
 * The whole public surface of the application, as `METHOD /path`. A route may
 * be reachable without a session only if it appears here, which makes adding a
 * public route a deliberate, reviewable act.
 */
export const PUBLIC_ROUTES: ReadonlySet<string> = new Set([
  'GET /',
  'GET /signup',
  'POST /auth/magic-link/request',
  'GET /auth/magic-link/verify',
  'POST /auth/logout',
  'GET /auth/google/start',
  'GET /auth/google/callback',
  'GET /api/onboarding/templates',
  // The links a brief carries. Public because the token in the URL is the whole
  // authorisation: a reader following a link in their inbox is by definition not
  // signed in, and the token decides whose subscription changes. Named rather
  // than written out, because a path spelled here and again where the route is
  // registered is a public surface that can drift from the one that exists.
  `GET ${UNSUBSCRIBE_TOPIC_PATH}`,
  `POST ${UNSUBSCRIBE_TOPIC_PATH}`,
  `GET ${UNSUBSCRIBE_ALL_PATH}`,
  `POST ${UNSUBSCRIBE_ALL_PATH}`,
  // The payment provider telling Brieflyy a Checkout completed. Public for the
  // same reason the magic link is: the provider is not signed in and cannot be,
  // so it authorises by signature over the bytes it sent rather than by a
  // session. Named here, with the route named in `WRITE_GUARD_EXEMPTIONS` and the
  // reasoning in `docs/adr/`, because a public route that moves a User onto the
  // paid tier is the one place in the application where "reachable without a
  // session" has to be a decision somebody wrote down rather than a default.
  `POST ${BILLING_WEBHOOK_PATH}`,
]);

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: RouteAccess;
  }
}

export const PUBLIC_ROUTE_CONFIG: RouteShorthandOptions = { config: { access: 'public' } };
export const AUTHENTICATED_ROUTE_CONFIG: RouteShorthandOptions = {
  config: { access: 'authenticated' },
};

/**
 * How much of a state-changing route the cross-site guard is responsible for.
 *
 * One level, because the other answer is not a level but a named exemption: a
 * route either changes something behind the guard, or it is written down in
 * `WRITE_GUARD_EXEMPTIONS` with the reason it cannot be behind it. A route with
 * no level and no entry is a route `src/http/write-guard.test.ts` fails the
 * build over, so the two together are the whole of the decision.
 */
export type RouteStateChange = 'guarded';

declare module 'fastify' {
  interface FastifyContextConfig {
    stateChange?: RouteStateChange;
  }
}

/**
 * The state-changing routes behind a session, which therefore also carry the
 * cross-site guard: a page on another site can spend a session cookie, and the
 * guard is what a submission has to agree with before it is allowed to.
 */
export const AUTHENTICATED_WRITE_ROUTE_CONFIG: RouteShorthandOptions = {
  config: { access: 'authenticated', stateChange: 'guarded' },
};

/**
 * The state-changing route a page on another site can reach without a session.
 *
 * Signing out is one: `POST /auth/logout` reads the session cookie and destroys
 * it, so a stranger's page could otherwise end a User's session by submitting a
 * form, which is a state change like any other and gets the same answer.
 */
export const PUBLIC_WRITE_ROUTE_CONFIG: RouteShorthandOptions = {
  config: { access: 'public', stateChange: 'guarded' },
};

/**
 * The state-changing routes the guard does not sit in front of, as `METHOD /path`,
 * each with the reason it cannot be.
 *
 * A list rather than a judgement inside the guard, so adding a write is a
 * decision somebody wrote down: `src/http/write-guard.test.ts` fails the build
 * for a route that declares no level and is not named here, and for a name here
 * that no longer resolves to a route.
 *
 * There are three, and what they have in common is that there is no Brieflyy page
 * whose submission they could be:
 *
 * - A one-click unsubscribe is a mail client acting on `List-Unsubscribe`, with
 *   no session and no Brieflyy document to carry a field. The token in the URL is
 *   the whole authorisation, and ADR-0012 promises the link works from an inbox.
 * - A magic-link request comes from the sign-in page's own script, and that script
 *   cannot read the httpOnly half of the pair: there is no signed-in User, so no
 *   page carries the field. It spends no session either — it writes a row an
 *   emailed token will one day be spent on, for an address the caller supplied —
 *   and the per-address and per-caller rate limits are what stand in front of it.
 * - The payment provider's webhook is a server calling a URL, with no session and
 *   no Brieflyy document anywhere in the exchange. The signature over the raw body
 *   is the authorisation, checked before a byte of the payload is read, and the
 *   reference the event names is one this application minted — see ADR-0023.
 *
 * Nothing else is exempt. An operator surface called by a script is still a write
 * against a User's session, and `POST /api/ingest/tick` runs a whole ingest cycle
 * when it is answered, so the caller fetches a page and echoes the token like any
 * other submission would.
 */
export const WRITE_GUARD_EXEMPTIONS: ReadonlyMap<string, string> = new Map([
  [
    'POST /auth/magic-link/request',
    'the sign-in page\'s own script: no signed-in User, so no page carries the field it would echo, and it spends no session',
  ],
  [
    `POST ${UNSUBSCRIBE_TOPIC_PATH}`,
    'a one-click mail client: the token in the URL is the authorisation and there is no page',
  ],
  [
    `POST ${UNSUBSCRIBE_ALL_PATH}`,
    'a one-click mail client: the token in the URL is the authorisation and there is no page',
  ],
  [
    `POST ${BILLING_WEBHOOK_PATH}`,
    'the payment provider is not a browser and has no Brieflyy page to carry a field; the signature over the raw body is the authorisation',
  ],
]);

export interface RequireAuthOptions {
  /** Answer with JSON rather than an HTML page, for the `/api` routes. */
  readonly json?: boolean;
}

/**
 * Whether an address belongs to a JSON surface.
 *
 * One rule with two readers: the not-found handler and the error handler both
 * answer a page for everything else and a body for this, because handing a machine
 * a document is the same class of mistake as handing a page a JSON error. Written
 * once here so the two cannot answer differently about the same address.
 */
export function isJsonSurface(url: string): boolean {
  return url.startsWith('/api/');
}

/**
 * A request the guard has established carries a session.
 */
export type AuthenticatedRequest = FastifyRequest & { auth: CurrentAuth };

/**
 * Reject a request that has no session. Returns true when the caller may carry
 * on. A 401 rather than a redirect, so an operator poking at an admin endpoint
 * finds out it is refused instead of being bounced to a sign-up form.
 */
export function requireAuth(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: RequireAuthOptions = {},
): req is AuthenticatedRequest {
  if (req.auth) return true;
  if (opts.json === true) {
    reply.code(401).send({ error: 'unauthorized' });
    return false;
  }
  reply.code(401).type('text/html; charset=utf-8').send(signInRequiredPage());
  return false;
}

/**
 * The same refusal for a page in the signed-in flow: send the visitor to sign up
 * rather than showing them a dead end.
 */
export function requireAuthPage(
  req: FastifyRequest,
  reply: FastifyReply,
): req is AuthenticatedRequest {
  if (req.auth) return true;
  reply.code(302).header('location', '/signup').send();
  return false;
}

function signInRequiredPage(): string {
  return layout({
    title: 'Sign in required',
    width: 'narrow',
    // Shown precisely because there is no session, so there is no account to put
    // the navigation and sign-out on.
    account: null,
    body: `    <h1>Sign in required</h1>
    <p>This page is only available to a signed-in user.</p>
    <p class="actions"><a class="button" href="/signup">Sign in</a></p>`,
  });
}

export interface RegisteredRoute {
  readonly method: string;
  readonly url: string;
  /** Null when the route forgot to declare an access level. */
  readonly access: RouteAccess | null;
  /** Null when the route declares no state-change level. */
  readonly stateChange: RouteStateChange | null;
  /** True for the HEAD route Fastify generates for every GET. */
  readonly autoHead: boolean;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Every route registered on this instance, in registration order. */
    routeManifest: readonly RegisteredRoute[];
  }
}

function describeRoute(options: RouteOptions): RegisteredRoute {
  const access = options.config?.access;
  const stateChange = options.config?.stateChange;
  return {
    method: Array.isArray(options.method) ? options.method.join(',') : String(options.method),
    url: options.url,
    access: access === 'public' || access === 'authenticated' ? access : null,
    stateChange: stateChange === 'guarded' ? stateChange : null,
    autoHead: false,
  };
}

/**
 * Record every route the instance registers. The manifest is what the guard test
 * enumerates, so it has to be built from the real application rather than from a
 * parallel description of it.
 */
export function attachRouteManifest(app: FastifyInstance): void {
  const manifest: RegisteredRoute[] = [];
  app.decorate('routeManifest', manifest);
  app.addHook('onRoute', (options) => {
    const route = describeRoute(options as RouteOptions);
    // Fastify answers HEAD from the GET handler of the same path. The generated
    // route carries no handler of its own, so it is recorded as the shadow of the
    // route it answers, access level included.
    const shadowed =
      route.method === 'HEAD'
        ? manifest.find((other) => other.url === route.url && other.method !== 'HEAD')
        : undefined;
    manifest.push(
      shadowed === undefined
        ? route
        : { ...route, access: shadowed.access, stateChange: shadowed.stateChange, autoHead: true },
    );
  });
}
