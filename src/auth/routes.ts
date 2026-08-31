import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import { SESSION_COOKIE_NAME } from '../config.js';
import type { AuthService, CurrentAuth } from './auth-service.js';
import { escapeHtml } from '../pages/html.js';

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

  fastify.post('/auth/magic-link/request', async (req, reply) => {
    const body = (req.body ?? {}) as { email?: unknown };
    if (typeof body.email !== 'string') {
      return reply.code(400).send({ error: 'invalid_email' });
    }
    try {
      const outcome = await authService.requestMagicLink({ email: body.email });
      return reply.code(202).send(outcome);
    } catch (err) {
      if (err instanceof Error && err.name === 'RequestMagicLinkValidationError') {
        return reply.code(400).send({ error: 'invalid_email' });
      }
      throw err;
    }
  });

  fastify.get<{ Querystring: { token?: string } }>(
    '/auth/magic-link/verify',
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
        .header('location', '/onboarding/pick-topics')
        .send();
      return reply;
    },
  );

  fastify.post('/auth/logout', async (req, reply) => {
    const sessionId = readSessionCookie(req);
    if (sessionId) {
      await authService.destroySession(sessionId);
    }
    clearSessionCookie(reply);
    return reply.code(204).send();
  });
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

function invalidLinkPage(message: string): string {
  const safe = escapeHtml(message);
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Invalid link</title></head>
<body>
  <main style="font-family: system-ui, sans-serif; max-width: 480px; margin: 4rem auto; padding: 0 1rem;">
    <h1>Invalid sign-in link</h1>
    <p>${safe}</p>
    <p><a href="/signup">Request a new link</a></p>
  </main>
</body>
</html>`;
}