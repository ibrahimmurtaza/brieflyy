import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
  RouteOptions,
  RouteShorthandOptions,
} from 'fastify';

import { escapeHtml } from '../pages/html.js';
import type { CurrentAuth } from '../auth/auth-service.js';

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
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Sign in required</title></head>
<body>
  <main style="font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem;">
    <h1>Sign in required</h1>
    <p>${escapeHtml('This page is only available to a signed-in user.')}</p>
    <p><a href="/signup">Sign in</a></p>
  </main>
</body>
</html>`;
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
