import { createHash, createVerify } from 'node:crypto';

import type {
  ExchangeGoogleCodeInput,
  ExchangeGoogleCodeOutcome,
  GoogleOAuthProfile,
  OAuthClient,
} from './client.js';

const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GOOGLE_AUTHZ_BASE = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_JWKS_URI = 'https://www.googleapis.com/oauth2/v3/certs';

export interface GoogleOAuthClientOptions {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly fetchImpl?: typeof fetch;
  readonly clock?: { now(): Date };
}

interface GoogleTokenResponse {
  readonly access_token?: string;
  readonly id_token?: string;
  readonly expires_in?: number;
  readonly error?: string;
  readonly error_description?: string;
}

interface Jwk {
  readonly kty: string;
  readonly alg?: string;
  readonly kid?: string;
  readonly use?: string;
  readonly n: string;
  readonly e: string;
}

interface Jwks {
  readonly keys: Jwk[];
}

export class GoogleOAuthClient implements OAuthClient {
  readonly providerName = 'google' as const;
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly fetchImpl: typeof fetch;
  private readonly clock: { now(): Date };

  constructor(opts: GoogleOAuthClientOptions) {
    this.clientId = opts.clientId;
    this.clientSecret = opts.clientSecret;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.clock = opts.clock ?? { now: () => new Date() };
  }

  buildAuthorizationUrl(input: {
    readonly state: string;
    readonly codeVerifier: string;
    readonly redirectUri: string;
  }): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'openid email',
      state: input.state,
      code_challenge: encodeBase64Url(sha256(input.codeVerifier)),
      code_challenge_method: 'S256',
      access_type: 'online',
      prompt: 'select_account',
    });
    return `${GOOGLE_AUTHZ_BASE}?${params.toString()}`;
  }

  async exchangeCode(
    input: ExchangeGoogleCodeInput,
  ): Promise<ExchangeGoogleCodeOutcome> {
    const body = new URLSearchParams({
      code: input.code,
      client_id: this.clientId,
      client_secret: this.clientSecret,
      redirect_uri: input.redirectUri,
      grant_type: 'authorization_code',
      code_verifier: input.codeVerifier,
    });

    const response = await this.fetchImpl(GOOGLE_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      return { status: 'invalid', reason: 'exchange_failed' };
    }
    const tokenJson = (await response.json()) as GoogleTokenResponse;
    if (!tokenJson.id_token) {
      return { status: 'invalid', reason: 'exchange_failed' };
    }
    const jwksResponse = await this.fetchImpl(GOOGLE_JWKS_URI, { method: 'GET' });
    if (!jwksResponse.ok) {
      return { status: 'invalid', reason: 'invalid_id_token' };
    }
    const jwks = (await jwksResponse.json()) as Jwks;
    const profile = verifyGoogleIdToken(tokenJson.id_token, {
      clientId: this.clientId,
      clock: this.clock,
      jwks: jwks.keys,
    });
    if (!profile) {
      return { status: 'invalid', reason: 'invalid_id_token' };
    }
    return { status: 'ok', profile };
  }
}

function encodeBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  const b64 = (typeof btoa === 'function'
    ? btoa(binary)
    : Buffer.from(binary, 'binary').toString('base64')
  ).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  return b64;
}

function sha256(input: string): Uint8Array {
  return new Uint8Array(createHash('sha256').update(input).digest());
}

interface GoogleIdTokenClaims {
  readonly iss?: string;
  readonly aud?: string | string[];
  readonly azp?: string;
  readonly sub?: string;
  readonly email?: string;
  readonly email_verified?: boolean | string;
  readonly exp?: number;
}

interface VerifyIdTokenOptions {
  readonly clientId: string;
  readonly clock: { now(): Date };
  readonly jwks: Jwk[];
}

function verifyGoogleIdToken(
  jwt: string,
  opts: VerifyIdTokenOptions,
): GoogleOAuthProfile | null {
  const parts = jwt.split('.');
  if (parts.length !== 3) return null;
  let header: { alg?: string; kid?: string };
  let claims: GoogleIdTokenClaims;
  try {
    header = JSON.parse(decodeBase64Url(parts[0]!)) as { alg?: string; kid?: string };
    claims = JSON.parse(decodeBase64Url(parts[1]!)) as GoogleIdTokenClaims;
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const jwk = opts.jwks.find((k) => k.kid === header.kid);
  if (!jwk) return null;
  if (jwk.kty !== 'RSA' || jwk.alg !== 'RS256') return null;
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${parts[0]}.${parts[1]}`);
  const signature = Buffer.from(
    parts[2]!.replace(/-/g, '+').replace(/_/g, '/') +
      '='.repeat((4 - (parts[2]!.length % 4)) % 4),
    'base64',
  );
  let valid: boolean;
  try {
    valid = verifier.verify({ key: jwk, format: 'jwk' }, signature);
  } catch {
    return null;
  }
  if (!valid) return null;
  const expectedAud = opts.clientId;
  if (Array.isArray(claims.aud)) {
    if (!claims.aud.includes(expectedAud)) return null;
  } else if (claims.aud !== expectedAud) {
    return null;
  }
  if (claims.iss !== 'https://accounts.google.com' && claims.iss !== 'accounts.google.com') {
    return null;
  }
  if (typeof claims.exp !== 'number') return null;
  if (claims.exp * 1000 <= opts.clock.now().getTime()) return null;
  if (!claims.sub || !claims.email) return null;
  return {
    provider: 'google',
    subject: claims.sub,
    email: claims.email,
    emailVerified: claims.email_verified === true || claims.email_verified === 'true',
  };
}

function decodeBase64Url(input: string): string {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/') +
    '='.repeat((4 - (input.length % 4)) % 4);
  if (typeof atob === 'function') return atob(padded);
  return Buffer.from(padded, 'base64').toString('binary');
}

export const __test_only__ = { verifyGoogleIdToken, encodeBase64Url };