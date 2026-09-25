import { describe, it, expect } from 'vitest';
import { ArchiveSearchService } from './archive-search-service.js';

describe('ArchiveSearchService', () => {
  it('enforces 30-day window for free tier on clusters', () => {
    const svc = new ArchiveSearchService({
      tier: 'free',
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
    const svc = new ArchiveSearchService({
      tier: 'free',
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'snapshot', id: 'snap-old', createdAt: new Date('2026-01-01T00:00:00Z') },
      ],
    });
    const results = svc.search({ query: '' });
    expect(results.items.map((i) => i.id)).toContain('snap-old');
  });

  it('paid tier returns all archive items regardless of age', () => {
    const svc = new ArchiveSearchService({
      tier: 'paid',
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
      tier: 'paid',
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'cluster', id: 'c1', entities: ['Tesla'] },
        { kind: 'cluster', id: 'c2', entities: ['Apple'] },
      ],
    });
    const results = svc.search({ entity: 'Tesla' });
    expect(results.items.map((i) => i.id)).toEqual(['c1']);
  });

  it('filters by date range', () => {
    const svc = new ArchiveSearchService({
      tier: 'paid',
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
      tier: 'free',
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [],
    });
    const results = svc.search({ query: '' });
    expect(results.items).toHaveLength(0);
  });

  it('searches text across cluster summaries and snapshot html', () => {
    const svc = new ArchiveSearchService({
      tier: 'paid',
      now: new Date('2026-09-25T00:00:00Z'),
      archiveItems: [
        { kind: 'cluster', id: 'c1', summary: 'Tesla earnings rise' },
        { kind: 'snapshot', id: 'snap1', html: '<p>Apple earnings fall</p>' },
      ],
    });
    const teslaResults = svc.search({ query: 'Tesla' });
    expect(teslaResults.items.map((i) => i.id)).toContain('c1');

    const appleResults = svc.search({ query: 'Apple' });
    expect(appleResults.items.map((i) => i.id)).toContain('snap1');
  });
});
