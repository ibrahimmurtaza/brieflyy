import { describe, expect, it } from 'vitest';

import { clusterSummaryOf, MAX_BULLET_POINTS } from './cluster-summary.js';
import { makeArticle } from '../testing/fixtures.js';

describe('MAX_BULLET_POINTS', () => {
  it('limits the bullets a Cluster carries', () => {
    expect(MAX_BULLET_POINTS).toBeGreaterThan(0);
  });
});

describe('clusterSummaryOf', () => {
  const representative = makeArticle({
    id: 'a-1',
    title: 'Acme Corp unveils Foo',
    body: 'Acme Corp unveiled an AI product called Foo today. Analysts were surprised by the launch.',
  });

  it('titles the Cluster by the headline of the representative Article', () => {
    expect(clusterSummaryOf([representative]).title).toBe('Acme Corp unveils Foo');
  });

  it('quotes the first statement of the representative Article as the one-liner', () => {
    expect(clusterSummaryOf([representative]).oneLiner).toBe(
      'Acme Corp unveiled an AI product called Foo today.',
    );
  });

  it('falls back to the title when the body has no usable sentence', () => {
    const headlineOnly = makeArticle({
      id: 'a-2',
      title: 'Acme Corp unveils Foo',
      body: '',
    });
    expect(clusterSummaryOf([headlineOnly]).oneLiner).toBe('Acme Corp unveils Foo');
  });

  it('gives an empty Cluster nothing', () => {
    expect(clusterSummaryOf([])).toEqual({
      title: '',
      oneLiner: '',
      bulletPoints: [],
    });
  });

  it('never repeats the one-liner or the title in the bullets', () => {
    const a2 = makeArticle({
      id: 'a-2',
      title: 'Regulators review the Acme Corp launch',
      body: 'Regulators opened a review into the Acme Corp launch.',
    });
    const { bulletPoints } = clusterSummaryOf([representative, a2]);
    expect(bulletPoints).not.toContain(clusterSummaryOf([representative, a2]).oneLiner);
    expect(bulletPoints).not.toContain(clusterSummaryOf([representative, a2]).title);
  });

  it('draws one bullet per Article rather than repeating one source', () => {
    const a2 = makeArticle({
      id: 'a-2',
      title: 'Regulators review the Acme Corp launch',
      body: 'Regulators opened a review into the Acme Corp launch.',
    });
    const { bulletPoints } = clusterSummaryOf([representative, a2]);
    expect(bulletPoints.length).toBeLessThanOrEqual(MAX_BULLET_POINTS);
    expect(bulletPoints).toContain('Regulators opened a review into the Acme Corp launch.');
  });

  it('does not repeat a statement two Articles share', () => {
    const shared = 'Acme Corp unveiled an AI product called Foo today.';
    const a2 = makeArticle({
      id: 'a-2',
      title: 'Foo is out',
      body: shared,
    });
    const { bulletPoints } = clusterSummaryOf([representative, a2]);
    const occurrences = bulletPoints.filter((b) => b === shared).length;
    expect(occurrences).toBeLessThanOrEqual(1);
  });
});
