import { describe, expect, it } from 'vitest';

import { buildTrendWindow, filterTrendForTier } from '../domain/trends.js';
import type {
  ClusterId,
  EmergingEntity,
  RollupEntity,
  Topic,
  TopicTrend,
  TrendsRollup,
} from '../domain/types.js';
import { makeTopic } from '../testing/fixtures.js';
import type { ShellAccount } from '../pages/layout.js';
import {
  rollupBlock,
  trendsOverviewPage,
  trendsPage,
  TRENDS_PATH,
} from './page.js';

const NOW = new Date('2024-06-15T12:00:00Z');
const WINDOW = buildTrendWindow(NOW);

const account: ShellAccount = {
  email: 'iris@example.com',
  tier: 'free',
  brief: { kind: 'stopped' },
};

const topic: Topic = makeTopic({ id: 't1', userId: 'u1', title: 'World news' });

function entity(overrides: Partial<EmergingEntity> = {}): EmergingEntity {
  return {
    entityId: 'e1',
    canonicalName: 'Acme Corp',
    lift: 3.4,
    observationMentions: 14,
    baselineMentions: 4,
    daily: [
      { date: '2024-06-13', mentions: 1 },
      { date: '2024-06-14', mentions: 8 },
      { date: '2024-06-15', mentions: 5 },
    ],
    ...overrides,
  };
}

function trend(overrides: Partial<TopicTrend> = {}): TopicTrend {
  return {
    topicId: 't1',
    computedAt: NOW,
    window: WINDOW,
    volumeOverTime: [
      { date: '2024-06-13', articles: 4, stories: 2 },
      { date: '2024-06-14', articles: 6, stories: 3 },
      { date: '2024-06-15', articles: 1, stories: 1 },
    ],
    spikes: [{ date: '2024-06-14', articles: 9, clusterIds: ['c1' as ClusterId] }],
    entities: [entity()],
    ...overrides,
  };
}

function clustersById(entries: readonly (readonly [ClusterId, string])[]) {
  return new Map(entries);
}

describe('the per-Topic trends page', () => {
  it('draws the volume of Articles and Stories over time', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([['c1' as ClusterId, 'Acme unveils Foo']]),
      historyDays: null,
    });
    expect(html).toContain('class="trend-chart"');
    expect(html).toContain('trend-chart__articles');
    expect(html).toContain('trend-chart__stories');
  });

  it('gives every Emerging Entity a sparkline', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([]),
      historyDays: null,
    });
    expect(html.match(/class="sparkline"/g)).toHaveLength(1);
  });

  it('annotates each spike with the Clusters that arrived, and links to them', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([['c1' as ClusterId, 'Acme unveils Foo']]),
      historyDays: null,
    });
    expect(html).toContain('Acme unveils Foo');
    // A link to that Cluster on the LivingBrief, which is where a User reads it.
    expect(html).toContain('href="/topics/world-news#cluster-c1"');
    expect(html).toContain('spike-marker');
  });

  it('says the date a spike was on, so the list and the chart can be read together', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([['c1' as ClusterId, 'Acme unveils Foo']]),
      historyDays: null,
    });
    expect(html).toContain('2024-06-14');
  });

  it('names no lift for a User whose tier cannot see the baseline it came from', () => {
    // Rendered from what the tier filter left, exactly as the route does it: the
    // lift and the two window counts are null, so the page has nothing to print.
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: filterTrendForTier(trend(), 'free', NOW),
      clustersById: clustersById([]),
      historyDays: 3,
    });
    expect(html).toContain('3 days');
    expect(html).not.toContain('more often than the baseline');
  });

  it('tells a paid User how much louder each Entity has got', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([]),
      historyDays: null,
    });
    expect(html).toContain('3.4');
    expect(html).toContain('full history');
  });

  it('offers the upgrade where the history is being held back', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([]),
      historyDays: 3,
    });
    expect(html).toContain('href="/upgrade"');
  });

  it('carries the numbers behind the chart, for a reader who cannot see it', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([]),
      historyDays: null,
    });
    expect(html).toContain('<table');
    expect(html).toContain('2024-06-14');
    expect(html).toContain('6');
  });

  it('says so when nothing has been published in the window at all', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend({ volumeOverTime: [], spikes: [], entities: [] }),
      clustersById: clustersById([]),
      historyDays: null,
    });
    expect(html).toContain('Nothing has been published');
  });

  it('keeps a spike whose Cluster has gone, without linking to nothing', () => {
    // A Cluster outside the Topic's own window is not retained, so an annotation
    // can outlive its Cluster. Dropping the whole spike would hide a real jump;
    // linking to an id that resolves to nothing would be worse.
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([]),
      historyDays: null,
    });
    expect(html).toContain('2024-06-14');
    expect(html).not.toContain('#cluster-c1');
  });

  it('leads back to the LivingBrief and to the other topics', () => {
    const html = trendsPage({
      account,
      topic,
      topicSlug: 'world-news',
      trend: trend(),
      clustersById: clustersById([]),
      historyDays: null,
    });
    expect(html).toContain('href="/topics/world-news"');
    expect(html).toContain(`href="${TRENDS_PATH}"`);
  });
});

describe('the rollup block', () => {
  const paidEntity: RollupEntity = {
    entityId: 'e1',
    canonicalName: 'Acme Corp',
    lift: 3.4,
    baselineMentions: 4,
    topicId: 't1',
    topicSlug: 'world-news',
    topicTitle: 'World news',
  };

  const rollup = (overrides: Partial<TrendsRollup> = {}): TrendsRollup => ({
    window: WINDOW,
    volumeOverTime: [
      { date: '2024-06-14', articles: 6, stories: 3 },
      { date: '2024-06-15', articles: 2, stories: 1 },
    ],
    entities: [paidEntity],
    ...overrides,
  });

  it('shows the aggregate volume and the top emerging Entities', () => {
    const html = rollupBlock({ rollup: rollup(), headingLevel: 2 });
    expect(html).toContain('class="trend-chart"');
    expect(html).toContain('Acme Corp');
    expect(html).toContain('href="/topics/world-news/trends"');
  });

  it('adds up what every topic reported rather than showing one topic', () => {
    const html = rollupBlock({ rollup: rollup(), headingLevel: 2 });
    expect(html).toContain('8');
  });

  it('names each Entity with the topic it rose in, so the link goes somewhere', () => {
    const html = rollupBlock({ rollup: rollup(), headingLevel: 2 });
    expect(html).toContain('World news');
  });

  it('says nothing is emerging rather than showing an empty heading', () => {
    const html = rollupBlock({
      rollup: rollup({ entities: [] }),
      headingLevel: 2,
    });
    expect(html).toContain('Nothing is emerging');
  });

  it('prints no lift for an entry the tier has taken the lift from', () => {
    // A null lift is the paywall declining to show the baseline the ratio came
    // from, so the page prints nothing rather than a `0×` claim about the Entity.
    const html = rollupBlock({
      rollup: rollup({
        entities: [{ ...paidEntity, lift: null, baselineMentions: null }],
      }),
      headingLevel: 2,
    });
    expect(html).toContain('Acme Corp');
    expect(html).not.toContain('more often than the baseline');
    expect(html).not.toContain('New in this window');
  });

  it('names a paid entry by how much louder it has got', () => {
    const html = rollupBlock({ rollup: rollup(), headingLevel: 2 });
    expect(html).toContain('3.4');
  });
});

describe('the across-your-topics trends page', () => {
  it('offers a way into each topic trends page', () => {
    const html = trendsOverviewPage({
      account,
      topics: [
        makeTopic({ id: 'world-news', userId: 'u1', title: 'World news' }),
        makeTopic({ id: 'fusion-energy', userId: 'u1', title: 'Fusion energy' }),
      ],
      rollup: {
        window: WINDOW,
        volumeOverTime: [],
        entities: [],
      },
      historyDays: null,
    });
    expect(html).toContain('href="/topics/world-news/trends"');
    expect(html).toContain('href="/topics/fusion-energy/trends"');
  });

  it('is the page the shell navigation links to', () => {
    const html = trendsOverviewPage({
      account,
      topics: [],
      rollup: { window: WINDOW, volumeOverTime: [], entities: [] },
      historyDays: null,
    });
    expect(html).toContain('aria-current="page"');
  });

  it('offers a way to add a topic when there are none to chart', () => {
    const html = trendsOverviewPage({
      account,
      topics: [],
      rollup: { window: WINDOW, volumeOverTime: [], entities: [] },
      historyDays: null,
    });
    expect(html).toContain('href="/pick-topics"');
  });
});

describe('the tier filter the page is rendered from', () => {
  it('is the same filter the service applies, so a page cannot show more than the response', () => {
    const stored = trend({
      volumeOverTime: [
        { date: '2024-06-10', articles: 9, stories: 4 },
        { date: '2024-06-14', articles: 2, stories: 1 },
      ],
    });
    const narrowed = filterTrendForTier(stored, 'free', NOW);
    expect(narrowed.volumeOverTime.map((p) => p.date)).toEqual(['2024-06-14']);
  });
});