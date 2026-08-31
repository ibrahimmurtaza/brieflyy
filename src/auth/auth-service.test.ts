import { beforeEach, describe, expect, it } from 'vitest';

import {
  AuthService,
  RequestMagicLinkValidationError,
} from './auth-service.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { DrizzleAccountRepo } from '../repos/account-repo.js';
import { DrizzleMagicLinkRepo } from '../repos/magic-link-repo.js';
import { DrizzleSessionRepo } from '../repos/session-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type { EmailMessage } from '../email/transport.js';
import { hashMagicLinkToken } from '../domain/crypto.js';

function makeService(opts?: {
  appBaseUrl?: string;
  magicLinkTtlMs?: number;
  sessionTtlMs?: number;
}) {
  const { db } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const userRepo = new DrizzleUserRepo(db);
  const accountRepo = new DrizzleAccountRepo(db);
  const sessionRepo = new DrizzleSessionRepo(db);
  const magicLinkRepo = new DrizzleMagicLinkRepo(db);
  const tc = makeTestClock(new Date('2026-01-01T00:00:00Z'));
  const service = new AuthService({
    userRepo,
    accountRepo,
    sessionRepo,
    magicLinkRepo,
    emailTransport: transport,
    clock: tc.clock,
    random: deterministicRandom,
    appBaseUrl: opts?.appBaseUrl ?? 'https://app.brieflyy.test',
    magicLinkTtlMs: opts?.magicLinkTtlMs,
    sessionTtlMs: opts?.sessionTtlMs,
  });
  return { service, transport, db, accountRepo, userRepo, sessionRepo, magicLinkRepo, tc };
}

function extractToken(message: EmailMessage): string {
  const match = message.text.match(/\btoken=([^\s&]+)/);
  if (!match) throw new Error('token not found in magic link email');
  return decodeURIComponent(match[1]!);
}

describe('AuthService.requestMagicLink', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('creates a User + Account and sends a magic link for a new email', async () => {
    const { service, transport } = makeService();

    const outcome = await service.requestMagicLink({ email: '  Iris@example.com  ' });

    expect(outcome.sentTo).toBe('new');
    expect(outcome.email).toBe('iris@example.com');

    const sent = transport.snapshot();
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message.to).toBe('iris@example.com');
    expect(message.subject).toMatch(/sign in/i);
    expect(message.text).toContain('https://app.brieflyy.test/auth/magic-link/verify?token=');
    expect(message.text).toMatch(/expires in \d+ minutes/);
  });

  it('does not create a duplicate User when the email already exists', async () => {
    const { service, accountRepo, userRepo } = makeService();

    await service.requestMagicLink({ email: 'Iris@example.com' });
    await service.requestMagicLink({ email: 'iris@example.com' });

    const account = await accountRepo.getByEmail('iris@example.com');
    expect(account).not.toBeNull();
    const user = await userRepo.getById(account!.userId);
    expect(user).not.toBeNull();
    expect(user!.onboardingState).toBe('not_started');
  });

  it('rejects an invalid email with a validation error', async () => {
    const { service } = makeService();

    await expect(
      service.requestMagicLink({ email: 'not-an-email' }),
    ).rejects.toBeInstanceOf(RequestMagicLinkValidationError);
  });

  it('rejects empty input with a validation error', async () => {
    const { service } = makeService();

    await expect(
      service.requestMagicLink({ email: '' }),
    ).rejects.toBeInstanceOf(RequestMagicLinkValidationError);
  });

  it('uses the configured appBaseUrl in the magic link', async () => {
    const { service, transport } = makeService({
      appBaseUrl: 'https://brieflyy.example.com/',
    });

    await service.requestMagicLink({ email: 'iris@example.com' });

    const text = transport.snapshot()[0]!.text;
    expect(text).toContain(
      'https://brieflyy.example.com/auth/magic-link/verify?token=',
    );
  });
});

describe('AuthService.verifyMagicLink', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('issues a session for a valid token and marks the magic link consumed', async () => {
    const { service, transport, sessionRepo, accountRepo, magicLinkRepo } = makeService();

    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);

    const outcome = await service.verifyMagicLink({ token });

    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');
    expect(outcome.account.email).toBe('iris@example.com');
    expect(outcome.user.onboardingState).toBe('not_started');
    expect(outcome.session.userId).toBe(outcome.user.id);

    const stored = await sessionRepo.getById(outcome.session.id);
    expect(stored).not.toBeNull();

    const account = await accountRepo.getById(outcome.account.id);
    expect(account!.emailVerifiedAt).not.toBeNull();

    const link = await magicLinkRepo.getByTokenHash(
      hashMagicLinkToken(token),
    );
    expect(link!.consumedAt).not.toBeNull();
  });

  it('returns invalid for a single-use token that has already been verified', async () => {
    const { service, transport } = makeService();

    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);

    const first = await service.verifyMagicLink({ token });
    expect(first.status).toBe('ok');

    const second = await service.verifyMagicLink({ token });
    expect(second.status).toBe('invalid');
    if (second.status !== 'invalid') throw new Error('expected invalid');
    expect(second.reason).toBe('already_used');
  });

  it('returns invalid for a token past its expiry', async () => {
    const { service, transport, tc } = makeService({
      magicLinkTtlMs: 60 * 1000,
    });

    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);

    tc.advance(2 * 60 * 1000);

    const result = await service.verifyMagicLink({ token });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('expected invalid');
    expect(result.reason).toBe('expired');
  });

  it('returns invalid for an unknown token', async () => {
    const { service } = makeService();

    const result = await service.verifyMagicLink({
      token: 'this-token-is-not-in-the-database-but-long-enough-to-pass-shape-checks-okay',
    });

    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('expected invalid');
    expect(result.reason).toBe('unknown_token');
  });

  it('returns invalid for a malformed token', async () => {
    const { service } = makeService();
    const result = await service.verifyMagicLink({ token: 'short' });
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') throw new Error('expected invalid');
    expect(result.reason).toBe('unknown_token');
  });

  it('creates a User and Account for a brand-new email on first verification', async () => {
    const { service, transport, userRepo, accountRepo } = makeService();
    await service.requestMagicLink({ email: 'newuser@example.com' });
    const token = extractToken(transport.snapshot()[0]!);

    const outcome = await service.verifyMagicLink({ token });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');

    const user = await userRepo.getById(outcome.user.id);
    expect(user).not.toBeNull();
    const account = await accountRepo.getById(outcome.account.id);
    expect(account!.email).toBe('newuser@example.com');
    expect(account!.userId).toBe(user!.id);
  });
});

describe('AuthService.getCurrentAuth', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('returns the authenticated user + account for an active session id', async () => {
    const { service, transport } = makeService();
    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);
    const verified = await service.verifyMagicLink({ token });
    if (verified.status !== 'ok') throw new Error('expected ok');

    const auth = await service.getCurrentAuth(verified.session.id);
    expect(auth).not.toBeNull();
    expect(auth!.user.id).toBe(verified.user.id);
    expect(auth!.account.email).toBe('iris@example.com');
  });

  it('returns null for an empty session id', async () => {
    const { service } = makeService();
    expect(await service.getCurrentAuth('')).toBeNull();
  });

  it('returns null for a session that has been revoked', async () => {
    const { service, transport } = makeService();
    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);
    const verified = await service.verifyMagicLink({ token });
    if (verified.status !== 'ok') throw new Error('expected ok');
    await service.destroySession(verified.session.id);

    expect(await service.getCurrentAuth(verified.session.id)).toBeNull();
  });

  it('returns null for a session past its expiry', async () => {
    const { service, transport, tc } = makeService({ sessionTtlMs: 1000 });
    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);
    const verified = await service.verifyMagicLink({ token });
    if (verified.status !== 'ok') throw new Error('expected ok');
    tc.advance(2000);

    expect(await service.getCurrentAuth(verified.session.id)).toBeNull();
  });
});

describe('AuthService.destroySession', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('revokes an active session', async () => {
    const { service, transport } = makeService();
    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);
    const verified = await service.verifyMagicLink({ token });
    if (verified.status !== 'ok') throw new Error('expected ok');

    const result = await service.destroySession(verified.session.id);
    expect(result.status).toBe('ok');
    expect(await service.getCurrentAuth(verified.session.id)).toBeNull();
  });

  it('is a no-op for an unknown session id', async () => {
    const { service } = makeService();
    const result = await service.destroySession('does-not-exist');
    expect(result.status).toBe('no_session');
  });

  it('is a no-op when called twice', async () => {
    const { service, transport } = makeService();
    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);
    const verified = await service.verifyMagicLink({ token });
    if (verified.status !== 'ok') throw new Error('expected ok');

    await service.destroySession(verified.session.id);
    const second = await service.destroySession(verified.session.id);
    expect(second.status).toBe('ok');
  });
});