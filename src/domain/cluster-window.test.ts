import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CLUSTER_WINDOW_DAYS,
  MAX_CLUSTER_WINDOW_DAYS,
  MIN_CLUSTER_WINDOW_DAYS,
  clampClusterWindowDays,
  clusterWindowStart,
} from './cluster-window.js';

describe('the Topic Cluster window', () => {
  it('defaults to the seven days the glossary names', () => {
    expect(DEFAULT_CLUSTER_WINDOW_DAYS).toBe(7);
  });

  it('looks back seven days from the end of the window by default', () => {
    const end = new Date('2026-09-02T12:00:00Z');

    expect(clusterWindowStart(end, DEFAULT_CLUSTER_WINDOW_DAYS).toISOString()).toBe(
      '2026-08-26T12:00:00.000Z',
    );
  });

  it('looks back the days the Topic asks for', () => {
    const end = new Date('2026-09-02T12:00:00Z');

    expect(clusterWindowStart(end, 3).toISOString()).toBe('2026-08-30T12:00:00.000Z');
  });

  it('clamps a window that would cluster nothing to the shortest one', () => {
    expect(clampClusterWindowDays(0)).toBe(MIN_CLUSTER_WINDOW_DAYS);
    expect(clampClusterWindowDays(-5)).toBe(MIN_CLUSTER_WINDOW_DAYS);
    expect(clusterWindowStart(new Date('2026-09-02T12:00:00Z'), 0).toISOString()).toBe(
      '2026-09-01T12:00:00.000Z',
    );
  });

  it('clamps a window that would swallow the Topic history to the longest one', () => {
    expect(clampClusterWindowDays(999)).toBe(MAX_CLUSTER_WINDOW_DAYS);
  });

  it('falls back to the default rather than trusting a nonsense value', () => {
    expect(clampClusterWindowDays(Number.NaN)).toBe(DEFAULT_CLUSTER_WINDOW_DAYS);
    expect(clampClusterWindowDays(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_CLUSTER_WINDOW_DAYS,
    );
  });
});
