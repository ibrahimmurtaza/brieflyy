import { beforeAll, describe, it, expect } from 'vitest';
import { ArchiveSearchService } from './archive-search-service.js';
import { tierOfPersistedUser } from '../testing/tier.js';
import type { Tier } from '../domain/types.js';

/**
 * The tier comes from a User that was written to a database and read back, not
 * from a literal in the test. A paywall that only works when the branch is
 * reached by hand is not a paywall.
 */
const tier: Record<Tier, Tier> = { free: 'free', paid: 'paid' };
let free: Tier;
let paid: Tier;

beforeAll(async () => {
  free = await tierOfPersistedUser('free');
  paid = await tierOfPersistedUser('paid');
});

describe('ArchiveSearchService', () => {
  it('enforces 30-day window for free tier on clusters', async () => {
    const svc = new ArchiveSearchService({
      tier: free,
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'cluster', id: 'c-old', createdAt: new Date('2026-08-01T00:00:00Z') },
        { kind: 'cluster', id: 'c-new', createdAt: new Date('2026-09-20T00:00:00Z') },
      ],
    });
    const results = svc.search({ query: '' });
    expect(results.items.map((i) => i.id)).toContain('c-new');
    expect(results.items.map((i) => i.id)).not.toContain('c-old');
  });

  it('always includes BriefSnapshots regardless of tier and age', () => {
    const snapshot = {
      kind: 'snapshot' as const,
      id: 'snap-old',
      createdAt: new Date('2026-01-01T00:00:00Z'),
    };
    for (const [name, t] of Object.entries({ free, paid })) {
      const svc = new ArchiveSearchService({
        tier: t,
        now: new Date('2026-09-25T00:00:00Z'),
        archiveItems: [snapshot],
      });
      expect(
        svc.search({ query: '' }).items.map((i) => i.id),
        `${name} tier drops a BriefSnapshot`,
      ).toContain('snap-old');
    }
  });

  it('paid tier returns all archive items regardless of age', () => {
    const svc = new ArchiveSearchService({
      tier: paid,
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'cluster', id: 'c-old', createdAt: new Date('2026-01-01T00:00:00Z') },
      ],
    });
    const results = svc.search({ query: '' });
    expect(results.items.map((i) => i.id)).toContain('c-old');
  });

  it('filters by entity', () => {
    const svc = new ArchiveSearchService({
      tier: paid,
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'cluster', id: 'c1', entities: ['Tesla'], createdAt: new Date('2026-09-20T00:00:00Z') },
        { kind: 'cluster', id: 'c2', entities: ['Apple'], createdAt: new Date('2026-09-20T00:00:00Z') },
      ],
    });
    const results = svc.search({ entity: 'Tesla' });
    expect(results.items.map((i) => i.id)).toEqual(['c1']);
  });

  it('filters by date range', () => {
    const svc = new ArchiveSearchService({
      tier: paid,
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'cluster', id: 'c1', createdAt: new Date('2026-09-10T00:00:00Z') },
        { kind: 'cluster', id: 'c2', createdAt: new Date('2026-09-20T00:00:00Z') },
      ],
    });
    const results = svc.search({ from: new Date('2026-09-15T00:00:00Z') });
    expect(results.items.map((i) => i.id)).toEqual(['c2']);
  });

  it('returns empty state when no archive data', () => {
    const svc = new ArchiveSearchService({
      tier: free,
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [],
    });
    const results = svc.search({ query: '' });
    expect(results.items).toHaveLength(0);
  });

  it('searches text across cluster summaries and snapshot html', () => {
    const svc = new ArchiveSearchService({
      tier: paid,
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'cluster', id: 'c1', summary: 'Tesla earnings rise', createdAt: new Date('2026-09-20T00:00:00Z') },
        { kind: 'snapshot', id: 'snap1', html: '<p>Apple earnings fall</p>', createdAt: new Date('2026-09-20T00:00:00Z') },
      ],
    });
    const teslaResults = svc.search({ query: 'Tesla' });
    expect(teslaResults.items.map((i) => i.id)).toContain('c1');

    const appleResults = svc.search({ query: 'Apple' });
    expect(appleResults.items.map((i) => i.id)).toContain('snap1');
  });

  it('keeps a snapshot the caller named on a free user who is otherwise cut off', () => {
    const svc = new ArchiveSearchService({
      tier: tier.free,
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'cluster', id: 'c-ancient', createdAt: new Date('2020-01-01T00:00:00Z') },
        { kind: 'snapshot', id: 'snap-ancient', createdAt: new Date('2020-01-01T00:00:00Z') },
      ],
    });
    expect(svc.search({}).items.map((i) => i.id)).toEqual(['snap-ancient']);
  });
});
