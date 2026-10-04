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
import { countRows } from '../testing/db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { hashMagicLinkToken } from '../domain/crypto.js';

function makeService(opts?: {
  appBaseUrl?: string;
  magicLinkTtlMs?: number;
  sessionTtlMs?: number;
}) {
  const { db, driver } = createTestDb();
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
  const count = (table: 'users' | 'accounts'): number => countRows(driver, table);
  return { service, transport, db, driver, count, accountRepo, userRepo, sessionRepo, magicLinkRepo, tc };
}

function extractToken(message: EmailMessage): string {
  return extractMagicLinkToken(message.text);
}

describe('AuthService.requestMagicLink', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('sends a magic link for an address nobody has signed up with yet', async () => {
    const { service, transport, accountRepo, count } = makeService();

    const outcome = await service.requestMagicLink({ email: '  Iris@example.com  ' });

    expect(outcome.email).toBe('iris@example.com');

    const sent = transport.snapshot();
    expect(sent).toHaveLength(1);
    const message = sent[0]!;
    expect(message.to).toBe('iris@example.com');
    expect(message.subject).toMatch(/sign in/i);
    expect(message.text).toContain('https://app.brieflyy.test/auth/magic-link/verify?token=');
    expect(message.text).toMatch(/expires in \d+ minutes/);

    // Asking is not joining. Nothing about the address is retained yet.
    expect(await accountRepo.getByEmail('iris@example.com')).toBeNull();
    expect(count('users')).toBe(0);
    expect(count('accounts')).toBe(0);
  });

  it('answers the same way for an address that already has an account', async () => {
    const { service, transport } = makeService();
    const first = await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);
    await service.verifyMagicLink({ token });

    const second = await service.requestMagicLink({ email: 'iris@example.com' });

    expect(second).toEqual(first);
  });

  it('does not create a second User when the same address asks twice', async () => {
    const { service, transport, count } = makeService();

    await service.requestMagicLink({ email: 'Iris@example.com' });
    const first = extractToken(transport.snapshot()[0]!);
    await service.requestMagicLink({ email: 'iris@example.com' });
    const sent = transport.snapshot();
    const second = extractToken(sent[sent.length - 1]!);

    await service.verifyMagicLink({ token: first });
    await service.verifyMagicLink({ token: second });

    expect(count('users')).toBe(1);
    expect(count('accounts')).toBe(1);
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
    const { service, transport, userRepo, accountRepo, count } = makeService();
    await service.requestMagicLink({ email: 'newuser@example.com' });
    expect(count('users')).toBe(0);
    const token = extractToken(transport.snapshot()[0]!);

    const outcome = await service.verifyMagicLink({ token });
    expect(outcome.status).toBe('ok');
    if (outcome.status !== 'ok') throw new Error('expected ok');

    const user = await userRepo.getById(outcome.user.id);
    expect(user).not.toBeNull();
    const account = await accountRepo.getById(outcome.account.id);
    expect(account!.email).toBe('newuser@example.com');
    expect(account!.userId).toBe(user!.id);
    expect(count('users')).toBe(1);
    expect(count('accounts')).toBe(1);
  });

  it('points the verified link at the account it created', async () => {
    const { service, transport, magicLinkRepo } = makeService();
    await service.requestMagicLink({ email: 'newuser@example.com' });
    const token = extractToken(transport.snapshot()[0]!);

    const before = await magicLinkRepo.getByTokenHash(hashMagicLinkToken(token));
    expect(before?.accountId).toBeNull();
    expect(before?.email).toBe('newuser@example.com');

    const outcome = await service.verifyMagicLink({ token });
    if (outcome.status !== 'ok') throw new Error('expected ok');

    const after = await magicLinkRepo.getByTokenHash(hashMagicLinkToken(token));
    expect(after?.accountId).toBe(outcome.account.id);
  });

  it('reuses the existing account when a verified link names a known address', async () => {
    const { service, transport, count } = makeService();
    await service.requestMagicLink({ email: 'iris@example.com' });
    const first = extractToken(transport.snapshot()[0]!);
    const created = await service.verifyMagicLink({ token: first });
    if (created.status !== 'ok') throw new Error('expected ok');

    await service.requestMagicLink({ email: 'iris@example.com' });
    const sent = transport.snapshot();
    const second = extractToken(sent[sent.length - 1]!);
    const again = await service.verifyMagicLink({ token: second });
    if (again.status !== 'ok') throw new Error('expected ok');

    expect(again.user.id).toBe(created.user.id);
    expect(again.account.id).toBe(created.account.id);
    expect(count('users')).toBe(1);
  });

  it('gives overlapping verifications of the same link exactly one session', async () => {
    const { service, transport, driver } = makeService();
    await service.requestMagicLink({ email: 'iris@example.com' });
    const token = extractToken(transport.snapshot()[0]!);

    const [one, two] = await Promise.all([
      service.verifyMagicLink({ token }),
      service.verifyMagicLink({ token }),
    ]);

    const oks = [one, two].filter((o) => o.status === 'ok');
    const refused = [one, two].filter((o) => o.status === 'invalid');
    expect(oks).toHaveLength(1);
    expect(refused).toHaveLength(1);
    expect(refused[0]).toEqual({ status: 'invalid', reason: 'already_used' });
    expect(countRows(driver, 'sessions')).toBe(1);
  });

  it('gives two links for one fresh address the same account when both are opened', async () => {
    const { service, transport, count } = makeService();
    await service.requestMagicLink({ email: 'iris@example.com' });
    const first = extractToken(transport.snapshot()[0]!);
    await service.requestMagicLink({ email: 'iris@example.com' });
    const sent = transport.snapshot();
    const second = extractToken(sent[sent.length - 1]!);

    // Both verifications run at once, as two tabs would.
    const [one, two] = await Promise.all([
      service.verifyMagicLink({ token: first }),
      service.verifyMagicLink({ token: second }),
    ]);

    expect(one.status).toBe('ok');
    expect(two.status).toBe('ok');
    if (one.status !== 'ok' || two.status !== 'ok') throw new Error('expected ok');
    expect(one.user.id).toBe(two.user.id);
    expect(count('users')).toBe(1);
    expect(count('accounts')).toBe(1);
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