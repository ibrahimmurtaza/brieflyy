import { beforeEach, describe, expect, it } from 'vitest';

import {
  AuthService,
} from './auth-service.js';
import type {
  ExchangeGoogleCodeInput,
  ExchangeGoogleCodeOutcome,
  OAuthClient,
  GoogleOAuthProfile,
} from '../oauth/client.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { DrizzleAccountRepo } from '../repos/account-repo.js';
import { DrizzleMagicLinkRepo } from '../repos/magic-link-repo.js';
import { DrizzleOAuthAccountRepo } from '../repos/oauth-account-repo.js';
import { DrizzleOAuthStateRepo } from '../repos/oauth-state-repo.js';
import { DrizzleSessionRepo } from '../repos/session-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import {
  hashOauthCodeVerifier,
  hashOauthState,
} from '../domain/crypto.js';

interface StubOAuthOptions {
  readonly nextExchange?: ExchangeGoogleCodeOutcome;
  readonly fixedProfile?: Partial<GoogleOAuthProfile>;
}

function makeStubOAuthClient(opts: StubOAuthOptions = {}): OAuthClient & {
  readonly lastExchange: { input: ExchangeGoogleCodeInput } | null;
} {
  let last: { input: ExchangeGoogleCodeInput } | null = null;
  const client: OAuthClient & {
    readonly lastExchange: { input: ExchangeGoogleCodeInput } | null;
  } = {
    providerName: 'google',
    lastExchange: null,
    buildAuthorizationUrl(input) {
      return `https://accounts.google.test/auth?state=${encodeURIComponent(input.state)}`;
    },
    async exchangeCode(input) {
      last = { input };
      if (opts.nextExchange) return opts.nextExchange;
      return {
        status: 'ok',
        profile: {
          provider: 'google',
          subject: opts.fixedProfile?.subject ?? 'google-uid',
          email: opts.fixedProfile?.email ?? 'iris@example.com',
          emailVerified: opts.fixedProfile?.emailVerified ?? true,
        },
      };
    },
  };
  Object.defineProperty(client, 'lastExchange', {
    get(): { input: ExchangeGoogleCodeInput } | null {
      return last;
    },
  });
  return client;
}

function makeService(opts?: {
  oauthClient?: OAuthClient;
  sessionTtlMs?: number;
  oauthStateTtlMs?: number;
}) {
  const { db } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const userRepo = new DrizzleUserRepo(db);
  const accountRepo = new DrizzleAccountRepo(db);
  const sessionRepo = new DrizzleSessionRepo(db);
  const magicLinkRepo = new DrizzleMagicLinkRepo(db);
  const oauthStateRepo = new DrizzleOAuthStateRepo(db);
  const oauthAccountRepo = new DrizzleOAuthAccountRepo(db);
  const tc = makeTestClock(new Date('2026-01-01T00:00:00Z'));
  const oauthClient = opts?.oauthClient ?? makeStubOAuthClient();
  const service = new AuthService({
    userRepo,
    accountRepo,
    sessionRepo,
    magicLinkRepo,
    oauthStateRepo,
    oauthAccountRepo,
    oauthClient,
    emailTransport: transport,
    clock: tc.clock,
    random: deterministicRandom,
    appBaseUrl: 'https://app.brieflyy.test',
    sessionTtlMs: opts?.sessionTtlMs,
    oauthStateTtlMs: opts?.oauthStateTtlMs,
  });
  return {
    service,
    transport,
    db,
    accountRepo,
    userRepo,
    sessionRepo,
    magicLinkRepo,
    oauthStateRepo,
    oauthAccountRepo,
    tc,
    oauthClient,
  };
}

async function startAndCapture(ctx: Awaited<ReturnType<typeof makeService>>) {
  const start = await ctx.service.startGoogleOAuth();
  const stateHash = hashOauthState(start.state);
  const stateRow = await ctx.oauthStateRepo.getByStateHash(stateHash);
  expect(stateRow).not.toBeNull();
  const codeVerifierHash = hashOauthCodeVerifier(start.codeVerifier);
  expect(stateRow!.codeVerifierHash).toBe(codeVerifierHash);
  return { start, stateHash, stateRow: stateRow! };
}

describe('AuthService.startGoogleOAuth', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('returns an authorization URL, state, and code verifier, and persists the state hash server-side', async () => {
    const ctx = makeService();
    const { start, stateRow } = await startAndCapture(ctx);

    expect(start.authorizationUrl).toMatch(/^https:\/\/accounts\.google\.test\//);
    expect(start.state).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(start.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(start.authorizationUrl).toContain(encodeURIComponent(start.state));
    expect(stateRow.consumedAt).toBeNull();
    expect(stateRow.expiresAt.getTime()).toBeGreaterThan(stateRow.createdAt.getTime());
  });
});

describe('AuthService.completeWithGoogle', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('creates a User + Account for a brand-new Google identity and issues a session', async () => {
    const ctx = makeService();
    const { start, stateHash } = await startAndCapture(ctx);

    const outcome = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.account.email).toBe('iris@example.com');
    expect(outcome.account.emailVerifiedAt).not.toBeNull();
    expect(outcome.user.onboardingState).toBe('not_started');
    expect(outcome.session.userId).toBe(outcome.user.id);

    const fetched = await ctx.sessionRepo.getById(outcome.session.id);
    expect(fetched).not.toBeNull();
  });

  it('links the Google account to an existing email-based User instead of creating a duplicate', async () => {
    const ctx = makeService();
    await ctx.service.requestMagicLink({ email: 'iris@example.com' });

    const { start, stateHash } = await startAndCapture(ctx);
    const outcome = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');

    expect(outcome.account.userId).toBe(outcome.user.id);

    const userRow = await ctx.userRepo.getById(outcome.user.id);
    expect(userRow).not.toBeNull();

    const link = await ctx.oauthAccountRepo.getByProviderSubject(
      'google',
      'google-uid',
    );
    expect(link).not.toBeNull();
    expect(link!.accountId).toBe(outcome.account.id);
  });

  it('marks the existing magic-link email as verified on first Google sign-in', async () => {
    const ctx = makeService();
    await ctx.service.requestMagicLink({ email: 'iris@example.com' });
    const accountBefore = await ctx.accountRepo.getByEmail('iris@example.com');
    expect(accountBefore!.emailVerifiedAt).toBeNull();

    const { start, stateHash } = await startAndCapture(ctx);
    await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });

    const accountAfter = await ctx.accountRepo.getByEmail('iris@example.com');
    expect(accountAfter!.emailVerifiedAt).not.toBeNull();
  });

  it('is a no-op when the same Google subject signs in again', async () => {
    const ctx = makeService();
    const { start, stateHash } = await startAndCapture(ctx);
    const first = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });
    if (first.status !== 'ok') throw new Error('expected ok');

    const secondStart = await ctx.service.startGoogleOAuth();
    const secondStateHash = hashOauthState(secondStart.state);
    const second = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: secondStart.state,
      stateHash: secondStateHash,
      codeVerifier: secondStart.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });

    expect(second.status).toBe('ok');
    if (second.status !== 'ok') throw new Error('expected ok');
    expect(second.user.id).toBe(first.user.id);
    expect(second.account.id).toBe(first.account.id);
  });

  it('refuses to create an account when the Google email is unverified', async () => {
    const ctx = makeService({
      oauthClient: makeStubOAuthClient({
        fixedProfile: { emailVerified: false },
      }),
    });
    const { start, stateHash } = await startAndCapture(ctx);

    const outcome = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });

    expect(outcome.status).toBe('invalid');
    if (outcome.status !== 'invalid') throw new Error('expected invalid');
    expect(outcome.reason).toBe('unverified_email');
  });

  it('returns invalid when the state is not in the database', async () => {
    const ctx = makeService();
    const start = await ctx.service.startGoogleOAuth();
    const outcome = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash: 'a'.repeat(64),
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status !== 'invalid') throw new Error('expected invalid');
    expect(outcome.reason).toBe('unknown_state');
  });

  it('returns invalid when the state has expired', async () => {
    const ctx = makeService({ oauthStateTtlMs: 60_000 });
    const { start, stateHash } = await startAndCapture(ctx);
    ctx.tc.advance(120_000);

    const outcome = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });

    expect(outcome.status).toBe('invalid');
    if (outcome.status !== 'invalid') throw new Error('expected invalid');
    expect(outcome.reason).toBe('expired_state');
  });

  it('returns invalid when the codeVerifier does not match the stored hash', async () => {
    const ctx = makeService();
    const { start, stateHash } = await startAndCapture(ctx);
    const outcome = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: 'a'.repeat(start.codeVerifier.length),
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status !== 'invalid') throw new Error('expected invalid');
    expect(outcome.reason).toBe('verifier_mismatch');
  });

  it('returns invalid for a state that has already been consumed', async () => {
    const ctx = makeService();
    const { start, stateHash } = await startAndCapture(ctx);
    const first = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });
    expect(first.status).toBe('ok');

    const second = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });
    expect(second.status).toBe('invalid');
    if (second.status !== 'invalid') throw new Error('expected invalid');
    expect(second.reason).toBe('state_consumed');
  });

  it('returns invalid when the OAuth client fails to exchange the code', async () => {
    const ctx = makeService({
      oauthClient: makeStubOAuthClient({
        nextExchange: { status: 'invalid', reason: 'exchange_failed' },
      }),
    });
    const { start, stateHash } = await startAndCapture(ctx);
    const outcome = await ctx.service.completeWithGoogle({
      code: 'auth-code',
      state: start.state,
      stateHash,
      codeVerifier: start.codeVerifier,
      redirectUri: 'https://app.brieflyy.test/auth/google/callback',
    });
    expect(outcome.status).toBe('invalid');
    if (outcome.status !== 'invalid') throw new Error('expected invalid');
    expect(outcome.reason).toBe('provider_exchange_failed');
  });
});