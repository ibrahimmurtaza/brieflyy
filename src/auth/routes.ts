import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import {
  MAGIC_LINK_RATE_LIMIT_SCOPES,
  OAUTH_STATE_COOKIE_NAME,
  OAUTH_STATE_TTL_MS_DEFAULT,
  OAUTH_VERIFIER_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../config.js';
import type { AuthService, CurrentAuth } from './auth-service.js';
import { emailSchema, googleCallbackPath, makeGoogleCallbackUrl } from './auth-service.js';
import { postSigninPath } from './post-signin.js';
import { PUBLIC_ROUTE_CONFIG } from '../http/access.js';
import type { FixedWindowRateLimiter } from '../http/rate-limit.js';
import { hashOauthState } from '../domain/crypto.js';
import { escapeHtml } from '../domain/html.js';
import { layout } from '../pages/layout.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth?: CurrentAuth;
  }
}

export interface AuthRoutesOptions {
  readonly authService: AuthService;
  readonly sessionTtlMs: number;
  readonly cookieSecure: boolean;
  readonly appBaseUrl: string;
  readonly magicLinkRateLimiter: FixedWindowRateLimiter;
}

function readSessionCookie(req: FastifyRequest): string {
  const raw = req.cookies[SESSION_COOKIE_NAME];
  return typeof raw === 'string' ? raw : '';
}

interface WriteCookieOptions {
  readonly cookieSecure: boolean;
  readonly sessionTtlMs: number;
}

function writeSessionCookie(
  reply: FastifyReply,
  value: string,
  opts: WriteCookieOptions,
): void {
  reply.setCookie(SESSION_COOKIE_NAME, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.cookieSecure,
    path: '/',
    maxAge: Math.floor(opts.sessionTtlMs / 1000),
  });
}

function clearSessionCookie(reply: FastifyReply): void {
  reply.clearCookie(SESSION_COOKIE_NAME, {
    path: '/',
  });
}

function readOauthStateCookie(req: FastifyRequest): string {
  const raw = req.cookies[OAUTH_STATE_COOKIE_NAME];
  return typeof raw === 'string' ? raw : '';
}

function readOauthVerifierCookie(req: FastifyRequest): string {
  const raw = req.cookies[OAUTH_VERIFIER_COOKIE_NAME];
  return typeof raw === 'string' ? raw : '';
}

interface WriteOauthCookieOptions {
  readonly cookieSecure: boolean;
}

function writeOauthCookie(
  reply: FastifyReply,
  name: string,
  value: string,
  opts: WriteOauthCookieOptions,
): void {
  reply.setCookie(name, value, {
    httpOnly: true,
    sameSite: 'lax',
    secure: opts.cookieSecure,
    path: '/',
    maxAge: Math.floor(OAUTH_STATE_TTL_MS_DEFAULT / 1000),
  });
}

function clearOauthCookies(reply: FastifyReply): void {
  reply.clearCookie(OAUTH_STATE_COOKIE_NAME, { path: '/' });
  reply.clearCookie(OAUTH_VERIFIER_COOKIE_NAME, { path: '/' });
}

export async function registerAuthRoutes(
  fastify: FastifyInstance,
  opts: AuthRoutesOptions,
): Promise<void> {
  const { authService } = opts;

  fastify.decorateRequest('auth', null as unknown as CurrentAuth | undefined);

  fastify.addHook('preHandler', async (req) => {
    const sessionId = readSessionCookie(req);
    if (sessionId) {
      const auth = await authService.getCurrentAuth(sessionId);
      if (auth) {
        req.auth = auth;
      }
    }
  });

  fastify.post(
    '/auth/magic-link/request',
    PUBLIC_ROUTE_CONFIG,
    async (req, reply) => {
      const body = (req.body ?? {}) as { email?: unknown };
      const parsed = typeof body.email === 'string' ? emailSchema.safeParse(body.email) : null;
      if (!parsed?.success) {
        return reply.code(400).send({ error: 'invalid_email' });
      }
      // Counted against the address and the caller, so neither one address nor
      // one caller can use this endpoint to send mail in bulk. The address is
      // checked first, and the caller's quota is only spent when the address
      // still has room: a flood at one address should not lock out everyone else
      // behind the same caller.
      const byAddress = opts.magicLinkRateLimiter.consume(
        MAGIC_LINK_RATE_LIMIT_SCOPES.perAddress,
        parsed.data,
      );
      const limited = byAddress.allowed
        ? opts.magicLinkRateLimiter.consume(
            MAGIC_LINK_RATE_LIMIT_SCOPES.perSource,
            req.ip,
          )
        : byAddress;
      if (!limited.allowed) {
        return reply
          .code(429)
          .header('retry-after', String(limited.retryAfterSeconds))
          .send({ error: 'rate_limited' });
      }
      try {
        const outcome = await authService.requestMagicLink({ email: parsed.data });
        // The same body whatever the address turns out to be: a response that
        // varied would tell a stranger who has an account here.
        return reply.code(202).send({ email: outcome.email });
      } catch (err) {
        if (err instanceof Error && err.name === 'RequestMagicLinkValidationError') {
          return reply.code(400).send({ error: 'invalid_email' });
        }
        throw err;
      }
    },
  );

  fastify.get<{ Querystring: { token?: string } }>(
    '/auth/magic-link/verify',
    PUBLIC_ROUTE_CONFIG,
    async (req, reply) => {
      const token = req.query.token;
      if (typeof token !== 'string' || token.length === 0) {
        return reply.code(400).type('text/html').send(invalidLinkPage('Missing token'));
      }
      const outcome = await authService.verifyMagicLink({ token });
      if (outcome.status === 'invalid') {
        return reply
          .code(400)
          .type('text/html')
          .send(invalidLinkPage(humanReason(outcome.reason)));
      }
      writeSessionCookie(reply, outcome.session.id, {
        cookieSecure: opts.cookieSecure,
        sessionTtlMs: opts.sessionTtlMs,
      });
      reply
        .code(302)
        .header('location', postSigninPath(outcome.user.onboardingState))
        .send();
      return reply;
    },
  );

  fastify.post('/auth/logout', PUBLIC_ROUTE_CONFIG, async (req, reply) => {
    const sessionId = readSessionCookie(req);
    if (sessionId) {
      await authService.destroySession(sessionId);
    }
    clearSessionCookie(reply);
    return reply.code(302).header('location', '/').send();
  });

  fastify.get('/auth/google/start', PUBLIC_ROUTE_CONFIG, async (_req, reply) => {
    const start = await authService.startGoogleOAuth();
    const stateHash = hashOauthState(start.state);
    writeOauthCookie(reply, OAUTH_STATE_COOKIE_NAME, stateHash, {
      cookieSecure: opts.cookieSecure,
    });
    writeOauthCookie(reply, OAUTH_VERIFIER_COOKIE_NAME, start.codeVerifier, {
      cookieSecure: opts.cookieSecure,
    });
    return reply.code(302).header('location', start.authorizationUrl).send();
  });

  fastify.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/auth/google/callback',
    PUBLIC_ROUTE_CONFIG,
    async (req, reply) => {
      clearOauthCookies(reply);
      if (typeof req.query.error === 'string') {
        return reply
          .code(400)
          .type('text/html')
          .send(oauthFailurePage('Google sign-in was cancelled or denied.'));
      }
      const code = req.query.code;
      const state = req.query.state;
      const stateHash = readOauthStateCookie(req);
      const codeVerifier = readOauthVerifierCookie(req);
      if (
        typeof code !== 'string' ||
        typeof state !== 'string' ||
        !stateHash ||
        !codeVerifier
      ) {
        return reply
          .code(400)
          .type('text/html')
          .send(oauthFailurePage('Google sign-in was incomplete. Please try again.'));
      }
      const outcome = await authService.completeWithGoogle({
        code,
        state,
        stateHash,
        codeVerifier,
        redirectUri: makeGoogleCallbackUrl(opts.appBaseUrl),
      });
      if (outcome.status === 'invalid') {
        return reply
          .code(400)
          .type('text/html')
          .send(oauthFailurePage(humanOauthReason(outcome.reason)));
      }
      writeSessionCookie(reply, outcome.session.id, {
        cookieSecure: opts.cookieSecure,
        sessionTtlMs: opts.sessionTtlMs,
      });
      return reply
        .code(302)
        .header('location', postSigninPath(outcome.user.onboardingState))
        .send();
    },
  );
}

function humanReason(reason: 'unknown_token' | 'expired' | 'already_used'): string {
  switch (reason) {
    case 'expired':
      return 'This sign-in link has expired. Request a new one.';
    case 'already_used':
      return 'This sign-in link has already been used. Request a new one.';
    case 'unknown_token':
      return 'This sign-in link is invalid.';
  }
}

function humanOauthReason(
  reason:
    | 'unknown_state'
    | 'expired_state'
    | 'state_consumed'
    | 'verifier_mismatch'
    | 'unverified_email'
    | 'provider_exchange_failed',
): string {
  switch (reason) {
    case 'unknown_state':
      return 'We could not verify this Google sign-in. Please try again.';
    case 'expired_state':
      return 'This Google sign-in attempt expired before it could complete. Please try again.';
    case 'state_consumed':
      return 'This Google sign-in has already been completed.';
    case 'verifier_mismatch':
      return 'This Google sign-in was tampered with. Please try again.';
    case 'unverified_email':
      return 'Your Google account email is not verified. Verify it with Google, then try again.';
    case 'provider_exchange_failed':
      return 'Google could not complete the sign-in. Please try again.';
  }
}

function oauthFailurePage(message: string): string {
  return layout({
    title: 'Sign-in failed',
    width: 'narrow',
    // Reached on the way in, so there is no signed-in User to put a header on.
    account: null,
    body: `    <h1>Sign-in failed</h1>
    <div class="error-summary" role="alert">
      <p>${escapeHtml(message)}</p>
    </div>
    <p class="actions"><a class="button" href="/signup">Try again</a></p>`,
  });
}

function invalidLinkPage(message: string): string {
  return layout({
    title: 'Invalid link',
    width: 'narrow',
    // Reached on the way in, so there is no signed-in User to put a header on.
    account: null,
    body: `    <h1>Invalid sign-in link</h1>
    <div class="error-summary" role="alert">
      <p>${escapeHtml(message)}</p>
    </div>
    <p class="actions"><a class="button" href="/signup">Request a new link</a></p>`,
  });
}