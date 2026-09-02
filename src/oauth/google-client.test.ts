import { createHash, generateKeyPairSync, createSign } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { GoogleOAuthClient, __test_only__ } from './google-client.js';

interface TestKey {
  readonly privatePem: string;
  readonly jwk: { kty: 'RSA'; alg: 'RS256'; kid: string; use: 'sig'; n: string; e: string };
}

function makeTestKey(kid: string): TestKey {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as {
    kty: string;
    n: string;
    e: string;
  };
  return {
    privatePem: privateKey.export({ type: 'pkcs8', format: 'pem' }) as string,
    jwk: {
      kty: 'RSA',
      alg: 'RS256',
      kid,
      use: 'sig',
      n: jwk.n,
      e: jwk.e,
    },
  };
}

function b64Url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

function signIdToken(key: TestKey, claims: Record<string, unknown>): string {
  const header = b64Url(JSON.stringify({ alg: 'RS256', kid: key.jwk.kid }));
  const payload = b64Url(JSON.stringify(claims));
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${payload}`);
  signer.end();
  const signature = signer.sign(key.privatePem);
  return `${header}.${payload}.${b64Url(signature)}`;
}

interface FetchCall {
  readonly url: string;
  readonly init: RequestInit;
}

function makeFetch(impl: (call: FetchCall) => Promise<Response>): typeof fetch {
  return ((input: RequestInfo | URL, init?: RequestInit) =>
    impl({ url: String(input), init: init ?? {} })) as unknown as typeof fetch;
}

const FIXED_NOW = new Date('2026-01-01T00:00:00Z');

describe('GoogleOAuthClient.buildAuthorizationUrl', () => {
  it('builds a URL with required OIDC params and PKCE S256 challenge', () => {
    const client = new GoogleOAuthClient({
      clientId: 'cid',
      clientSecret: 'csecret',
      clock: { now: () => FIXED_NOW },
    });
    const url = client.buildAuthorizationUrl({
      state: 'state-token',
      codeVerifier: 'verifier-bytes',
      redirectUri: 'https://app.example/auth/google/callback',
    });

    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(parsed.searchParams.get('client_id')).toBe('cid');
    expect(parsed.searchParams.get('redirect_uri')).toBe(
      'https://app.example/auth/google/callback',
    );
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('scope')).toBe('openid email');
    expect(parsed.searchParams.get('state')).toBe('state-token');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
    const expectedChallenge = __test_only__.encodeBase64Url(
      new Uint8Array(createHash('sha256').update('verifier-bytes').digest()),
    );
    expect(parsed.searchParams.get('code_challenge')).toBe(expectedChallenge);
  });
});

describe('GoogleOAuthClient.exchangeCode', () => {
  const testKey = makeTestKey('test-kid-1');
  const baseClaims = {
    iss: 'https://accounts.google.com',
    aud: 'cid',
    sub: 'google-uid-42',
    email: 'iris@example.com',
    email_verified: true,
    exp: Math.floor(FIXED_NOW.getTime() / 1000) + 3600,
  };

  let fetchCalls: FetchCall[];
  let nextJwksBody: { status: number; body: string };

  beforeEach(() => {
    fetchCalls = [];
    nextJwksBody = { status: 200, body: JSON.stringify({ keys: [testKey.jwk] }) };
  });

  function makeClientWithFetch(fetchImpl: typeof fetch): GoogleOAuthClient {
    return new GoogleOAuthClient({
      clientId: 'cid',
      clientSecret: 'csecret',
      fetchImpl,
      clock: { now: () => FIXED_NOW },
    });
  }

  function defaultTokenEndpointFetch(): typeof fetch {
    return makeFetch(async (call) => {
      fetchCalls.push(call);
      if (call.url === 'https://oauth2.googleapis.com/token') {
        const token = signIdToken(testKey, baseClaims);
        return new Response(JSON.stringify({ id_token: token }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(nextJwksBody.body, {
          status: nextJwksBody.status,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
  }

  it('returns ok with profile on successful token exchange', async () => {
    const client = makeClientWithFetch(defaultTokenEndpointFetch());
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.profile.subject).toBe('google-uid-42');
    expect(outcome.profile.email).toBe('iris@example.com');
    expect(outcome.profile.emailVerified).toBe(true);
    expect(fetchCalls.map((c) => c.url)).toEqual([
      'https://oauth2.googleapis.com/token',
      'https://www.googleapis.com/oauth2/v3/certs',
    ]);
  });

  it('returns exchange_failed when the token endpoint returns a non-2xx status', async () => {
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ error: 'invalid_grant' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'exchange_failed' });
  });

  it('returns exchange_failed when no id_token is returned', async () => {
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ access_token: 'no-id-token' }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'exchange_failed' });
  });

  it('returns invalid_id_token when the JWKS endpoint fails', async () => {
    nextJwksBody = { status: 500, body: '{}' };
    const client = makeClientWithFetch(defaultTokenEndpointFetch());
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_id_token' });
  });

  it('returns invalid_id_token when the id_token is not signed with a published Google key', async () => {
    const unsignedToken = `${b64Url(JSON.stringify({ alg: 'RS256', kid: 'test-kid-1' }))}.${b64Url(
      JSON.stringify(baseClaims),
    )}.${b64Url('not-a-real-signature')}`;
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: unsignedToken }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_id_token' });
  });

  it('returns invalid_id_token when the id_token is signed by an unknown kid', async () => {
    const otherKey = makeTestKey('other-kid');
    const token = signIdToken(otherKey, baseClaims);
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_id_token' });
  });

  it('returns invalid_id_token when the id_token aud does not match', async () => {
    const token = signIdToken(testKey, { ...baseClaims, aud: 'other-client' });
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_id_token' });
  });

  it('returns invalid_id_token when the id_token has expired', async () => {
    const token = signIdToken(testKey, {
      ...baseClaims,
      exp: Math.floor(FIXED_NOW.getTime() / 1000) - 1,
    });
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_id_token' });
  });

  it('returns invalid_id_token for a non-RS256 id_token', async () => {
    const header = b64Url(JSON.stringify({ alg: 'HS256', kid: 'test-kid-1' }));
    const payload = b64Url(JSON.stringify(baseClaims));
    const token = `${header}.${payload}.${b64Url('fake-hmac')}`;
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_id_token' });
  });

  it('accepts id_tokens whose aud is an array containing our client id', async () => {
    const token = signIdToken(testKey, { ...baseClaims, aud: ['cid', 'other-client'] });
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome.status).toBe('ok');
  });

  it('accepts id_tokens issued by accounts.google.com (no https)', async () => {
    const token = signIdToken(testKey, { ...baseClaims, iss: 'accounts.google.com' });
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome.status).toBe('ok');
  });

  it('treats email_verified="true" (string) as verified', async () => {
    const token = signIdToken(testKey, { ...baseClaims, email_verified: 'true' });
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.profile.emailVerified).toBe(true);
  });

  it('treats email_verified=false as unverified', async () => {
    const token = signIdToken(testKey, { ...baseClaims, email_verified: false });
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: token }), { status: 200 });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.profile.emailVerified).toBe(false);
  });

  it('returns invalid_id_token when the id_token has fewer than three segments', async () => {
    const fetchImpl = makeFetch(async (call) => {
      if (call.url === 'https://oauth2.googleapis.com/token') {
        return new Response(JSON.stringify({ id_token: 'not.a.jwt.at.all' }), {
          status: 200,
        });
      }
      if (call.url === 'https://www.googleapis.com/oauth2/v3/certs') {
        return new Response(JSON.stringify({ keys: [testKey.jwk] }), { status: 200 });
      }
      return new Response('{}', { status: 404 });
    });
    const client = makeClientWithFetch(fetchImpl);
    const outcome = await client.exchangeCode({
      code: 'auth-code',
      codeVerifier: 'verifier',
      redirectUri: 'https://app.example/auth/google/callback',
    });
    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_id_token' });
  });
});