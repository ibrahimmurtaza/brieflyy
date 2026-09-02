import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DrizzleAccountRepo } from './account-repo.js';
import { DrizzleOAuthAccountRepo } from './oauth-account-repo.js';
import { DrizzleOAuthStateRepo } from './oauth-state-repo.js';
import { DrizzleUserRepo } from './user-repo.js';
import { createTestDb, type TestDbHandle } from '../testing/test-db.js';
import {
  deterministicRandom,
  resetDeterministic,
} from '../testing/test-clocks.js';

function makeHandle(): TestDbHandle {
  resetDeterministic();
  return createTestDb();
}

describe('DrizzleOAuthStateRepo', () => {
  let handle: TestDbHandle;
  beforeEach(() => {
    handle = makeHandle();
  });
  afterEach(() => {
    handle.driver.close();
  });

  it('inserts and retrieves by state hash', async () => {
    const repo = new DrizzleOAuthStateRepo(handle.db);
    const now = new Date('2026-01-01T00:00:00Z');
    await repo.insert({
      id: deterministicRandom.uuid(),
      stateHash: 'hash-abc',
      codeVerifierHash: 'verifier-hash-abc',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
      consumedAt: null,
    });

    const fetched = await repo.getByStateHash('hash-abc');
    expect(fetched).not.toBeNull();
    expect(fetched!.stateHash).toBe('hash-abc');
    expect(fetched!.codeVerifierHash).toBe('verifier-hash-abc');
    expect(fetched!.consumedAt).toBeNull();
  });

  it('returns null for an unknown state hash', async () => {
    const repo = new DrizzleOAuthStateRepo(handle.db);
    expect(await repo.getByStateHash('nope')).toBeNull();
  });

  it('marks a state as consumed', async () => {
    const repo = new DrizzleOAuthStateRepo(handle.db);
    const now = new Date('2026-01-01T00:00:00Z');
    const id = deterministicRandom.uuid();
    await repo.insert({
      id,
      stateHash: 'hash-1',
      codeVerifierHash: 'verifier-hash-1',
      createdAt: now,
      expiresAt: new Date(now.getTime() + 600_000),
      consumedAt: null,
    });

    await repo.markConsumed(id, new Date('2026-01-01T00:01:00Z'));

    const fetched = await repo.getByStateHash('hash-1');
    expect(fetched!.consumedAt).not.toBeNull();
    expect(fetched!.consumedAt!.toISOString()).toBe('2026-01-01T00:01:00.000Z');
  });
});

describe('DrizzleOAuthAccountRepo', () => {
  let handle: TestDbHandle;
  beforeEach(() => {
    handle = makeHandle();
  });
  afterEach(() => {
    handle.driver.close();
  });

  it('inserts and retrieves by provider + subject', async () => {
    const userRepo = new DrizzleUserRepo(handle.db);
    const accountRepo = new DrizzleAccountRepo(handle.db);
    const repo = new DrizzleOAuthAccountRepo(handle.db);
    const now = new Date('2026-01-01T00:00:00Z');
    const userId = deterministicRandom.uuid();
    await userRepo.insert({
      id: userId,
      createdAt: now,
      onboardingState: 'not_started',
    });
    const accountId = deterministicRandom.uuid();
    await accountRepo.insert({
      id: accountId,
      userId,
      email: 'iris@example.com',
      emailVerifiedAt: null,
      createdAt: now,
    });
    await repo.insert({
      id: deterministicRandom.uuid(),
      accountId,
      provider: 'google',
      providerSubject: 'google-uid-123',
      createdAt: now,
    });

    const fetched = await repo.getByProviderSubject('google', 'google-uid-123');
    expect(fetched).not.toBeNull();
    expect(fetched!.accountId).toBe(accountId);
    expect(fetched!.provider).toBe('google');
    expect(fetched!.providerSubject).toBe('google-uid-123');
  });

  it('returns null for an unknown subject', async () => {
    const repo = new DrizzleOAuthAccountRepo(handle.db);
    expect(await repo.getByProviderSubject('google', 'unknown')).toBeNull();
  });
});