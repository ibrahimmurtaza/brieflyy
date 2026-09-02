import { z } from 'zod';

import {
  MAGIC_LINK_TTL_MS_DEFAULT,
  OAUTH_STATE_TTL_MS_DEFAULT,
  SESSION_TTL_MS_DEFAULT,
} from '../config.js';
import type { Clock } from '../domain/clock.js';
import {
  generateMagicLinkToken,
  generateOauthCodeVerifier,
  generateSessionId,
  hashMagicLinkToken,
  hashOauthCodeVerifier,
  hashOauthState,
  type RandomSource,
} from '../domain/crypto.js';
import type { EmailTransport } from '../email/transport.js';
import type { OAuthClient } from '../oauth/client.js';
import type {
  Account,
  Session,
  User,
} from '../domain/types.js';
import type { AccountRepo } from '../repos/account-repo.js';
import type { MagicLinkRepo } from '../repos/magic-link-repo.js';
import type { OAuthAccountRepo } from '../repos/oauth-account-repo.js';
import type { OAuthStateRepo } from '../repos/oauth-state-repo.js';
import type { SessionRepo } from '../repos/session-repo.js';
import type { UserRepo } from '../repos/user-repo.js';

export interface AuthServiceDeps {
  readonly userRepo: UserRepo;
  readonly accountRepo: AccountRepo;
  readonly sessionRepo: SessionRepo;
  readonly magicLinkRepo: MagicLinkRepo;
  readonly oauthStateRepo?: OAuthStateRepo | undefined;
  readonly oauthAccountRepo?: OAuthAccountRepo | undefined;
  readonly oauthClient?: OAuthClient | undefined;
  readonly emailTransport: EmailTransport;
  readonly clock: Clock;
  readonly random: RandomSource;
  readonly appBaseUrl: string;
  readonly magicLinkTtlMs?: number | undefined;
  readonly sessionTtlMs?: number | undefined;
  readonly oauthStateTtlMs?: number | undefined;
}

export const emailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .email()
  .max(254);

export type RequestMagicLinkInput = { readonly email: string };

export interface RequestMagicLinkOutcome {
  readonly email: string;
  readonly sentTo: 'existing' | 'new';
}

export const RequestMagicLinkError = {
  invalidEmail: 'invalid_email',
} as const;
export type RequestMagicLinkError =
  (typeof RequestMagicLinkError)[keyof typeof RequestMagicLinkError];

export class RequestMagicLinkValidationError extends Error {
  readonly kind: RequestMagicLinkError = 'invalid_email';
  constructor(message = 'Invalid email') {
    super(message);
    this.name = 'RequestMagicLinkValidationError';
  }
}

export interface VerifyMagicLinkInput {
  readonly token: string;
}

export type VerifyMagicLinkOutcome =
  | {
      readonly status: 'ok';
      readonly session: Session;
      readonly user: User;
      readonly account: Account;
    }
  | {
      readonly status: 'invalid';
      readonly reason: 'unknown_token' | 'expired' | 'already_used';
    };

export type DestroySessionOutcome =
  | { readonly status: 'ok' }
  | { readonly status: 'no_session' };

export interface CurrentAuth {
  readonly session: Session;
  readonly user: User;
  readonly account: Account;
}

export interface StartGoogleOAuthOutcome {
  readonly authorizationUrl: string;
  readonly state: string;
  readonly codeVerifier: string;
}

export interface CompleteGoogleInput {
  readonly code: string;
  readonly state: string;
  readonly stateHash: string;
  readonly codeVerifier: string;
  readonly redirectUri: string;
}

export type CompleteGoogleOutcome =
  | {
      readonly status: 'ok';
      readonly session: Session;
      readonly user: User;
      readonly account: Account;
    }
  | {
      readonly status: 'invalid';
      readonly reason:
        | 'unknown_state'
        | 'expired_state'
        | 'state_consumed'
        | 'verifier_mismatch'
        | 'unverified_email'
        | 'provider_exchange_failed';
    };

function makeMagicLinkUrl(appBaseUrl: string, token: string): string {
  const base = appBaseUrl.replace(/\/+$/, '');
  return `${base}/auth/magic-link/verify?token=${encodeURIComponent(token)}`;
}

function renderMagicLinkEmail(params: {
  magicLinkUrl: string;
  ttlMinutes: number;
}): { subject: string; text: string } {
  const { magicLinkUrl, ttlMinutes } = params;
  const subject = 'Sign in to Brieflyy';
  const text = [
    'Tap the link below to sign in to Brieflyy.',
    '',
    magicLinkUrl,
    '',
    `This link expires in ${ttlMinutes} minutes and can only be used once.`,
    "If you didn't request this, you can ignore this email.",
  ].join('\n');
  return { subject, text };
}

export class AuthService {
  private readonly userRepo: UserRepo;
  private readonly accountRepo: AccountRepo;
  private readonly sessionRepo: SessionRepo;
  private readonly magicLinkRepo: MagicLinkRepo;
  private readonly oauthStateRepo: OAuthStateRepo | null;
  private readonly oauthAccountRepo: OAuthAccountRepo | null;
  private readonly oauthClient: OAuthClient | null;
  private readonly emailTransport: EmailTransport;
  private readonly clock: Clock;
  private readonly random: RandomSource;
  private readonly appBaseUrl: string;
  private readonly magicLinkTtlMs: number;
  private readonly sessionTtlMs: number;
  private readonly oauthStateTtlMs: number;

  constructor(deps: AuthServiceDeps) {
    this.userRepo = deps.userRepo;
    this.accountRepo = deps.accountRepo;
    this.sessionRepo = deps.sessionRepo;
    this.magicLinkRepo = deps.magicLinkRepo;
    this.oauthStateRepo = deps.oauthStateRepo ?? null;
    this.oauthAccountRepo = deps.oauthAccountRepo ?? null;
    this.oauthClient = deps.oauthClient ?? null;
    this.emailTransport = deps.emailTransport;
    this.clock = deps.clock;
    this.random = deps.random;
    this.appBaseUrl = deps.appBaseUrl;
    this.magicLinkTtlMs = deps.magicLinkTtlMs ?? MAGIC_LINK_TTL_MS_DEFAULT;
    this.sessionTtlMs = deps.sessionTtlMs ?? SESSION_TTL_MS_DEFAULT;
    this.oauthStateTtlMs = deps.oauthStateTtlMs ?? OAUTH_STATE_TTL_MS_DEFAULT;
  }

  async requestMagicLink(
    input: RequestMagicLinkInput,
  ): Promise<RequestMagicLinkOutcome> {
    const parsed = emailSchema.safeParse(input.email);
    if (!parsed.success) {
      throw new RequestMagicLinkValidationError();
    }
    const email = parsed.data;
    const now = this.clock.now();

    let account = await this.accountRepo.getByEmail(email);
    let sentTo: 'existing' | 'new';
    if (!account) {
      const user: User = {
        id: this.random.uuid(),
        createdAt: now,
        onboardingState: 'not_started',
      };
      account = {
        id: this.random.uuid(),
        userId: user.id,
        email,
        emailVerifiedAt: null,
        createdAt: now,
      };
      await this.userRepo.insert(user);
      await this.accountRepo.insert(account);
      sentTo = 'new';
    } else {
      sentTo = 'existing';
    }

    const token = generateMagicLinkToken(this.random);
    const tokenHash = hashMagicLinkToken(token);
    const magicLink = {
      id: this.random.uuid(),
      accountId: account.id,
      tokenHash,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.magicLinkTtlMs),
      consumedAt: null,
    };
    await this.magicLinkRepo.insert(magicLink);

    const url = makeMagicLinkUrl(this.appBaseUrl, token);
    const ttlMinutes = Math.round(this.magicLinkTtlMs / 60000);
    const { subject, text } = renderMagicLinkEmail({
      magicLinkUrl: url,
      ttlMinutes,
    });
    await this.emailTransport.send({
      to: account.email,
      subject,
      text,
    });

    return { email, sentTo };
  }

  async verifyMagicLink(
    input: VerifyMagicLinkInput,
  ): Promise<VerifyMagicLinkOutcome> {
    if (!input.token || input.token.length < 16) {
      return { status: 'invalid', reason: 'unknown_token' };
    }
    const tokenHash = hashMagicLinkToken(input.token);
    const link = await this.magicLinkRepo.getByTokenHash(tokenHash);
    if (!link) {
      return { status: 'invalid', reason: 'unknown_token' };
    }
    const now = this.clock.now();
    if (link.consumedAt !== null) {
      return { status: 'invalid', reason: 'already_used' };
    }
    if (link.expiresAt.getTime() <= now.getTime()) {
      return { status: 'invalid', reason: 'expired' };
    }

    const account = await this.accountRepo.getById(link.accountId);
    if (!account) {
      return { status: 'invalid', reason: 'unknown_token' };
    }
    const user = await this.userRepo.getById(account.userId);
    if (!user) {
      return { status: 'invalid', reason: 'unknown_token' };
    }

    const sessionId = generateSessionId(this.random);
    const session: Session = {
      id: sessionId,
      userId: user.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.sessionTtlMs),
      revokedAt: null,
    };
    await this.sessionRepo.insert(session);

    if (account.emailVerifiedAt === null) {
      await this.accountRepo.markEmailVerified(account.id, now);
    }
    await this.magicLinkRepo.markConsumed(link.id, now);

    return { status: 'ok', session, user, account };
  }

  async getCurrentAuth(sessionId: string): Promise<CurrentAuth | null> {
    if (!sessionId) return null;
    const session = await this.sessionRepo.getById(sessionId);
    if (!session) return null;
    if (session.revokedAt !== null) return null;
    if (session.expiresAt.getTime() <= this.clock.now().getTime()) return null;
    const user = await this.userRepo.getById(session.userId);
    if (!user) return null;
    const account = await this.accountRepo.getByUserId(user.id);
    if (!account) return null;
    return { session, user, account };
  }

  async destroySession(sessionId: string): Promise<DestroySessionOutcome> {
    if (!sessionId) {
      return { status: 'no_session' };
    }
    const session = await this.sessionRepo.getById(sessionId);
    if (!session) {
      return { status: 'no_session' };
    }
    if (session.revokedAt === null) {
      await this.sessionRepo.revoke(session.id, this.clock.now());
    }
    return { status: 'ok' };
  }

  async startGoogleOAuth(): Promise<StartGoogleOAuthOutcome> {
    if (!this.oauthClient || !this.oauthStateRepo) {
      throw new Error('Google OAuth is not configured on this AuthService');
    }
    const state = generateOauthCodeVerifier(this.random);
    const codeVerifier = generateOauthCodeVerifier(this.random);
    const now = this.clock.now();
    await this.oauthStateRepo.insert({
      id: this.random.uuid(),
      stateHash: hashOauthState(state),
      codeVerifierHash: hashOauthCodeVerifier(codeVerifier),
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.oauthStateTtlMs),
      consumedAt: null,
    });
    const redirectUri = makeGoogleCallbackUri(this.appBaseUrl);
    const authorizationUrl = this.oauthClient.buildAuthorizationUrl({
      state,
      codeVerifier,
      redirectUri,
    });
    return { authorizationUrl, state, codeVerifier };
  }

  async completeWithGoogle(
    input: CompleteGoogleInput,
  ): Promise<CompleteGoogleOutcome> {
    if (!this.oauthClient || !this.oauthStateRepo || !this.oauthAccountRepo) {
      throw new Error('Google OAuth is not configured on this AuthService');
    }
    if (hashOauthState(input.state) !== input.stateHash) {
      return { status: 'invalid', reason: 'unknown_state' };
    }
    const stateRow = await this.oauthStateRepo.getByStateHash(input.stateHash);
    if (!stateRow) {
      return { status: 'invalid', reason: 'unknown_state' };
    }
    const now = this.clock.now();
    if (stateRow.consumedAt !== null) {
      return { status: 'invalid', reason: 'state_consumed' };
    }
    if (stateRow.expiresAt.getTime() <= now.getTime()) {
      return { status: 'invalid', reason: 'expired_state' };
    }
    if (
      hashOauthCodeVerifier(input.codeVerifier) !== stateRow.codeVerifierHash
    ) {
      return { status: 'invalid', reason: 'verifier_mismatch' };
    }

    const exchange = await this.oauthClient.exchangeCode({
      code: input.code,
      codeVerifier: input.codeVerifier,
      redirectUri: input.redirectUri,
    });
    if (exchange.status !== 'ok') {
      return { status: 'invalid', reason: 'provider_exchange_failed' };
    }
    if (!exchange.profile.emailVerified) {
      return { status: 'invalid', reason: 'unverified_email' };
    }

    await this.oauthStateRepo.markConsumed(stateRow.id, now);

    const existingLink = await this.oauthAccountRepo.getByProviderSubject(
      exchange.profile.provider,
      exchange.profile.subject,
    );
    let account: Account;
    let user: User;
    if (existingLink) {
      account = (await this.accountRepo.getById(existingLink.accountId))!;
      user = (await this.userRepo.getById(account.userId))!;
    } else {
      const email = exchange.profile.email;
      const found = await this.accountRepo.getByEmail(email);
      if (found) {
        account = found;
        user = (await this.userRepo.getById(account.userId))!;
      } else {
        user = {
          id: this.random.uuid(),
          createdAt: now,
          onboardingState: 'not_started',
        };
        account = {
          id: this.random.uuid(),
          userId: user.id,
          email,
          emailVerifiedAt: now,
          createdAt: now,
        };
        await this.userRepo.insert(user);
        await this.accountRepo.insert(account);
      }
      await this.oauthAccountRepo.insert({
        id: this.random.uuid(),
        accountId: account.id,
        provider: exchange.profile.provider,
        providerSubject: exchange.profile.subject,
        createdAt: now,
      });
    }

    if (account.emailVerifiedAt === null) {
      await this.accountRepo.markEmailVerified(account.id, now);
    }

    const sessionId = generateSessionId(this.random);
    const session: Session = {
      id: sessionId,
      userId: user.id,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.sessionTtlMs),
      revokedAt: null,
    };
    await this.sessionRepo.insert(session);

    return { status: 'ok', session, user, account };
  }
}

function makeGoogleCallbackUri(appBaseUrl: string): string {
  const base = appBaseUrl.replace(/\/+$/, '');
  return `${base}/auth/google/callback`;
}

export const googleCallbackPath = '/auth/google/callback';
export function makeGoogleCallbackUrl(appBaseUrl: string): string {
  return makeGoogleCallbackUri(appBaseUrl);
}