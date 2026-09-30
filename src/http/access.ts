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

export interface RequireAuthOptions {
  /** Answer with JSON rather than an HTML page, for the `/api` routes. */
  readonly json?: boolean;
}

/** A request the guard has established carries a session. */
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
  return {
    method: Array.isArray(options.method) ? options.method.join(',') : String(options.method),
    url: options.url,
    access: access === 'public' || access === 'authenticated' ? access : null,
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
        : { ...route, access: shadowed.access, autoHead: true },
    );
  });
}
