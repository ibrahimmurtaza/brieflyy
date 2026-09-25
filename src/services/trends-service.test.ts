import { describe, it, expect } from 'vitest';
import { TrendsService } from './trends-service.js';

function mockClock(dateStr: string) {
  const d = new Date(dateStr);
  return { now: () => d };
}

describe('TrendsService', () => {
  it('builds a 7d observation / 30d baseline window', () => {
    const svc = new TrendsService({ clock: mockClock('2024-06-15T12:00:00Z') });
    const w = svc.buildTrendWindow();
    expect(w.observationStart.toISOString()).toBe('2024-06-08T12:00:00.000Z');
    expect(w.observationEnd.toISOString()).toBe('2024-06-15T12:00:00.000Z');
    expect(w.baselineStart.toISOString()).toBe('2024-05-09T12:00:00.000Z');
    expect(w.baselineEnd.toISOString()).toBe('2024-06-08T12:00:00.000Z');
  });

  it('computes lift correctly', () => {
    const svc = new TrendsService({ clock: mockClock('2024-06-15') });
    expect(svc.computeLift(14, 7, 15, 30)).toBeCloseTo(4, 5);
    expect(svc.computeLift(0, 7, 0, 30)).toBe(0);
    expect(svc.computeLift(7, 7, 0, 30)).toBe(Infinity);
  });

  it('filters free tier to last 3 days', () => {
    const svc = new TrendsService({ clock: mockClock('2024-06-15') });
    const trend = {
      topicId: 't1',
      computedAt: new Date(),
      volumeOverTime: [
        { date: '2024-06-10', count: 1 },
        { date: '2024-06-13', count: 2 },
        { date: '2024-06-14', count: 3 },
      ],
      entities: [],
    };
    const free = svc.filterForTier(trend, 'free', new Date('2024-06-15'));
    expect(free.volumeOverTime.map((v) => v.date)).toEqual([
      '2024-06-13',
      '2024-06-14',
    ]);
  });

  it('keeps full history for paid tier', () => {
    const svc = new TrendsService({ clock: mockClock('2024-06-15') });
    const trend = {
      topicId: 't1',
      computedAt: new Date(),
      volumeOverTime: [{ date: '2024-01-01', count: 1 }],
      entities: [],
    };
    const paid = svc.filterForTier(trend, 'paid', new Date('2024-06-15'));
    expect(paid.volumeOverTime.length).toBe(1);
  });

  it('sorts emerging entities by lift descending', () => {
    const svc = new TrendsService({ clock: mockClock('2024-06-15') });
    const entities = [
      { entityId: 'e1', canonicalName: 'A', lift: 2 },
      { entityId: 'e2', canonicalName: 'B', lift: 5 },
      { entityId: 'e3', canonicalName: 'C', lift: 1 },
    ];
    const sorted = svc.sortEmergingEntities(entities);
    expect(sorted.map((e) => e.entityId)).toEqual(['e2', 'e1', 'e3']);
  });
});
