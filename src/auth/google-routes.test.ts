import { generateKeyPairSync, createSign } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { GoogleOAuthClient } from '../oauth/google-client.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { hashOauthState } from '../domain/crypto.js';

const NOW_MS = new Date('2026-01-01T00:00:00Z').getTime();

function b64Url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64url');
}

const { privateKey: testPrivateKey, publicKey: testPublicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
});
const testJwk = testPublicKey.export({ format: 'jwk' }) as {
  kty: string;
  n: string;
  e: string;
};
const jwksResponse = {
  keys: [{ ...testJwk, alg: 'RS256' as const, kid: 'k', use: 'sig' as const }],
};

function makeSignedIdToken(claims: Record<string, unknown>): string {
  const header = b64Url(JSON.stringify({ alg: 'RS256', kid: 'k' }));
  const payload = b64Url(JSON.stringify(claims));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(testPrivateKey);
  return `${header}.${payload}.${b64Url(signature)}`;
}

interface TestAppHandle {
  readonly app: FastifyInstance;
  readonly transport: ConsoleEmailTransport;
  readonly db: ReturnType<typeof createTestDb>['db'];
  readonly driver: ReturnType<typeof createTestDb>['driver'];
  readonly fetchCalls: { count: number };
  setTokenEndpointResponse(response: { status: number; body?: string }): void;
}

async function makeTestApp(
  oauthOpts: { profile?: Partial<{ subject: string; email: string; emailVerified: boolean }> } = {},
): Promise<TestAppHandle> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const fetchCalls = { count: 0 };
  let tokenResponse: { status: number; body?: string } = {};
  const fetchImpl = (async (input: RequestInfo | URL, _init?: RequestInit) => {
    fetchCalls.count++;
    void _init;
    const url = String(input);
    const tokenClaims = {
      iss: 'https://accounts.google.com',
      aud: 'cid',
      sub: oauthOpts.profile?.subject ?? 'google-uid-1',
      email: oauthOpts.profile?.email ?? 'iris@example.com',
      email_verified: oauthOpts.profile?.emailVerified ?? true,
      exp: Math.floor(NOW_MS / 1000) + 3600,
    };
    const idToken = makeSignedIdToken(tokenClaims);
    if (url === 'https://www.googleapis.com/oauth2/v3/certs') {
      return new Response(JSON.stringify(jwksResponse), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = tokenResponse.body ?? JSON.stringify({ id_token: idToken });
      const status = tokenResponse.status ?? 200;
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  }) as unknown as typeof fetch;

  const oauthClient = new GoogleOAuthClient({
    clientId: 'cid',
    clientSecret: 'csecret',
    fetchImpl,
    clock: { now: () => new Date(NOW_MS) },
  });

  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(new Date(NOW_MS)).clock,
    random: deterministicRandom,
    oauthClient,
  });
  return {
    app,
    transport,
    db,
    driver,
    fetchCalls,
    setTokenEndpointResponse(r) {
      tokenResponse = r;
    },
  };
}

function pickCookie(headers: Record<string, unknown>, name: string): string | null {
  const raw = headers['set-cookie'];
  const list: string[] = Array.isArray(raw) ? (raw as string[]) : raw ? [raw as string] : [];
  for (const line of list) {
    const head = line.split(';')[0]!;
    const [k, v] = head.split('=');
    if (k === name) return v ?? null;
  }
  return null;
}

function cookieHeaderWith(
  headers: Record<string, unknown>,
  name: string,
): string | null {
  const value = pickCookie(headers, name);
  return value ? `${name}=${value}` : null;
}

describe('HTTP /auth/google/start', () => {
  let handle: TestAppHandle;
  beforeEach(async () => {
    handle = await makeTestApp();
  });
  afterEach(async () => {
    await handle.app.close();
    handle.driver.close();
  });

  it('redirects to Google and sets the OAuth state + verifier cookies', async () => {
    const response = await handle.app.inject({ method: 'GET', url: '/auth/google/start' });
    expect(response.statusCode).toBe(302);
    const location = response.headers['location'];
    expect(location).toMatch(/^https:\/\/accounts\.google\.com\//);
    const stateCookie = pickCookie(response.headers as Record<string, unknown>, 'brieflyy_oauth_state');
    const verifierCookie = pickCookie(
      response.headers as Record<string, unknown>,
      'brieflyy_oauth_verifier',
    );
    expect(stateCookie).toBeTruthy();
    expect(verifierCookie).toBeTruthy();

    const params = new URL(location as string).searchParams;
    const state = params.get('state')!;
    expect(state).toBeTruthy();
    expect(hashOauthState(state)).toBe(stateCookie);
  });
});

describe('HTTP /auth/google/callback', () => {
  let handle: TestAppHandle;
  beforeEach(async () => {
    handle = await makeTestApp();
  });
  afterEach(async () => {
    await handle.app.close();
    handle.driver.close();
  });

  async function startOAuth(): Promise<{ stateCookie: string; verifierCookie: string; location: string }> {
    const start = await handle.app.inject({ method: 'GET', url: '/auth/google/start' });
    return {
      stateCookie: pickCookie(start.headers as Record<string, unknown>, 'brieflyy_oauth_state')!,
      verifierCookie: pickCookie(start.headers as Record<string, unknown>, 'brieflyy_oauth_verifier')!,
      location: start.headers['location'] as string,
    };
  }

  it('completes the flow, sets the session cookie, and clears the OAuth cookies', async () => {
    const { stateCookie, verifierCookie, location } = await startOAuth();
    const state = new URL(location).searchParams.get('state')!;
    const cookie = `brieflyy_oauth_state=${stateCookie}; brieflyy_oauth_verifier=${verifierCookie}`;

    const response = await handle.app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    if (response.statusCode !== 302) {
      throw new Error(`Got ${response.statusCode}: ${response.body}`);
    }
    expect(response.statusCode).toBe(302);
    expect(response.headers['location']).toBe('/onboarding/pick-topics');

    const setCookieRaw = response.headers['set-cookie'];
    const setCookieText = Array.isArray(setCookieRaw) ? setCookieRaw.join(';') : (setCookieRaw ?? '');
    expect(setCookieText).toMatch(/brieflyy_session=[A-Za-z0-9_-]+/);
    expect(setCookieText).toMatch(/brieflyy_oauth_state=;/);
    expect(setCookieText).toMatch(/brieflyy_oauth_verifier=;/);
  });

  it('redirects back to onboarding with an authenticated session after Google sign-in', async () => {
    const { stateCookie, verifierCookie, location } = await startOAuth();
    const state = new URL(location).searchParams.get('state')!;
    const cookie = `brieflyy_oauth_state=${stateCookie}; brieflyy_oauth_verifier=${verifierCookie}`;

    const callback = await handle.app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    const sessionCookie = cookieHeaderWith(
      callback.headers as Record<string, unknown>,
      'brieflyy_session',
    );
    expect(sessionCookie).not.toBeNull();

    const onboarding = await handle.app.inject({
      method: 'GET',
      url: '/onboarding/pick-topics',
      headers: { cookie: sessionCookie! },
    });
    expect(onboarding.statusCode).toBe(200);
    expect(onboarding.body).toContain('iris@example.com');
  });

  it('renders an error page when the state cookie is missing', async () => {
    const { location } = await startOAuth();
    const state = new URL(location).searchParams.get('state')!;
    const response = await handle.app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Sign-in failed');
  });

  it('renders an error page when Google returns an error', async () => {
    const response = await handle.app.inject({
      method: 'GET',
      url: '/auth/google/callback?error=access_denied&state=fake',
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Sign-in failed');
  });

  it('renders an error page when the state does not match the cookie', async () => {
    const { stateCookie, verifierCookie } = await startOAuth();
    const cookie = `brieflyy_oauth_state=${stateCookie}; brieflyy_oauth_verifier=${verifierCookie}`;
    const response = await handle.app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=auth-code&state=completely-different',
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
  });

  it('renders an error page when Google rejects the code exchange', async () => {
    handle.setTokenEndpointResponse({ status: 400, body: JSON.stringify({ error: 'invalid_grant' }) });
    const { stateCookie, verifierCookie, location } = await startOAuth();
    const state = new URL(location).searchParams.get('state')!;
    const cookie = `brieflyy_oauth_state=${stateCookie}; brieflyy_oauth_verifier=${verifierCookie}`;
    const response = await handle.app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=bad-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(response.statusCode).toBe(400);
    expect(response.body).toContain('Sign-in failed');
  });

  it('refuses to complete the flow twice with the same state', async () => {
    const { stateCookie, verifierCookie, location } = await startOAuth();
    const state = new URL(location).searchParams.get('state')!;
    const cookie = `brieflyy_oauth_state=${stateCookie}; brieflyy_oauth_verifier=${verifierCookie}`;

    const first = await handle.app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(first.statusCode).toBe(302);

    const second = await handle.app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=auth-code&state=${encodeURIComponent(state)}`,
      headers: { cookie },
    });
    expect(second.statusCode).toBe(400);
  });
});

describe('HTTP: Google login button on signup page', () => {
  let handle: TestAppHandle;
  beforeEach(async () => {
    handle = await makeTestApp();
  });
  afterEach(async () => {
    await handle.app.close();
    handle.driver.close();
  });

  it('renders a "Sign in with Google" button pointing at /auth/google/start', async () => {
    const response = await handle.app.inject({ method: 'GET', url: '/signup' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('Sign in with Google');
    expect(response.body).toContain('href="/auth/google/start"');
  });
});