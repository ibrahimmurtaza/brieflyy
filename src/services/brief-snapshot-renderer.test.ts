import { describe, expect, it } from 'vitest';
import { BriefSnapshotRenderer } from './brief-snapshot-renderer.js';
import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';
import { bulletsFrom, oneLinerFrom } from '../domain/cluster-text.js';
import type { Article } from '../domain/types.js';
import { makeArticle } from '../testing/fixtures.js';

const PLAN = {
  id: 'p1',
  topicId: 'topic-1',
  userId: 'u1',
  createdAt: new Date('2026-09-02T12:00:00Z'),
  clusterIds: ['c1'],
};

const TOPIC = { id: 'topic-1', slug: 'world-news', title: 'World news' };

function makeCluster(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    topicId: 'topic-1',
    title: 'Cluster 1',
    summary: 'Extractive summary',
    bulletPoints: ['b1'],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastSeenAt: new Date('2026-09-01T00:00:00Z'),
    articleCount: 1,
    velocity: 1,
    sourceIds: ['s1'],
    state: 'active',
    ...overrides,
  };
}

/** The Topic the renderer names and links to. Required: there is no id fallback. */
const topicRepo = { getById: async () => TOPIC } as never;

function clusterRepo(
  clusters: readonly Record<string, unknown>[],
  articlesByCluster: Readonly<Record<string, readonly Article[]>> = {},
): never {
  return {
    listByTopicId: async () => clusters,
    listArticlesByClusterId: async (id: string) => articlesByCluster[id] ?? [],
  } as never;
}

class MockLLMClient implements LLMSummaryClient {
  async generateSummary(
    _clusterTitle: string,
    _clusterSummary: string,
    _articles: readonly { url: string; title: string; body: string }[],
  ): Promise<LLMSummaryOutput | null> {
    return {
      summary: 'LLM generated summary',
      bulletPoints: [
        { text: 'Point one', articleUrl: 'https://example.com/article-1' },
      ],
    };
  }
}

describe('BriefSnapshotRenderer', () => {
  it('renders LLM summary when available', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster()], {
        c1: [makeArticle({ id: 'article-1' })],
      }),
      topicRepo,
      llmClient: new MockLLMClient(),
      maxLlmClusters: 5,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app');
    expect(html).toContain('LLM generated summary');
    expect(html).toContain('Point one');
    expect(html).toContain('https://example.com/article-1');
  });

  it('falls back to extractive when LLM client is missing', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app');
    expect(html).toContain('Extractive summary');
    expect(html).toContain('b1');
  });
});

describe('BriefSnapshotRenderer as a delivered document', () => {
  it('is a real document: doctype, language, viewport, and a width', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app');

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('max-width:600px');
  });

  it('names the Topic rather than calling every brief "Brief"', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html, subject } = await renderer.render(PLAN as never, 'https://app');

    expect(html).toContain('<h1 style="margin:8px 0 0 0;font-size:22px;line-height:1.25;color:#111827;">World news</h1>');
    expect(html).toContain('<title>World news - Brieflyy</title>');
    expect(subject).toBe('World news - Brieflyy');
    expect(html).not.toContain('<h1>Brief</h1>');
  });

  it('links into the app by slug, which is what the app routes on', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app');

    expect(html).toContain('href="https://app/topics/world-news"');
    expect(html).not.toContain('href="https://app/topics/topic-1"');
  });

  it('carries no unsubscribe link, because none of them resolve', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app');

    // The old footer emitted `/unsubscribe/topic?t=...&token=TOKEN` and
    // `/unsubscribe/all?token=TOKEN`. Neither route is registered, so both were
    // 404s wearing the costume of a working link.
    expect(html).not.toMatch(/unsubscribe/);
    expect(html).not.toContain('TOKEN');
    // What it offers instead are the pages that do exist.
    expect(html).toContain('href="https://app/settings/delivery"');
    expect(html).toContain('href="https://app/pick-topics"');
  });

  it('dates the brief, so two of them are tellable apart', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html, text } = await renderer.render(PLAN as never, 'https://app');

    expect(html).toContain('2 September 2026');
    expect(text).toContain('2 September 2026');
  });

  it('names the Topic in the subject and nowhere leaks the internal id', async () => {
    // The fallback this renderer used to have put `plan.topicId` in the link
    // when no Topic was loaded, so the call to action pointed at a URL form the
    // application does not serve and the heading read as an identifier. There is
    // no id to fall back to now: a brief that cannot name its Topic is not
    // rendered at all.
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo: { getById: async () => null } as never,
    });

    await expect(renderer.render(PLAN as never, 'https://app')).rejects.toThrow(
      /topic-1/,
    );
  });
});

describe('BriefSnapshotRenderer bullets', () => {
  const articles = [
    makeArticle({
      id: 'a-1',
      body: 'Acme Corp unveiled Foo today. Analysts were surprised by the launch.',
    }),
    makeArticle({
      id: 'a-2',
      body: 'Regulators opened a review into the Acme Corp launch.',
    }),
  ];
  const bulletPoints = bulletsFrom(articles, 3, oneLinerFrom(articles[0]!));
  const clusters = [makeCluster({ bulletPoints })];

  it('links every bullet it quotes, on the extractive path', async () => {
    // A bullet is a sentence lifted verbatim from an Article, so the Article it
    // came from is already known. Rendering it as plain text asks the reader to
    // take the attribution on trust, which is the one thing a brief quoting
    // Sources should not ask.
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo(clusters, { c1: articles }),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app');

    for (const bullet of bulletPoints) {
      expect(html).toContain(`>${bullet}</a>`);
    }
    expect(html).toContain('href="https://example.com/a-1"');
    expect(html).toContain('href="https://example.com/a-2"');
  });

  it('still quotes a bullet it cannot attribute, rather than dropping it', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo([makeCluster({ bulletPoints: ['A sentence no Article here says.'] })]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app');

    expect(html).toContain('A sentence no Article here says.');
  });

  it('will not link a URL in an unsafe scheme, on either path', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo(
        [makeCluster({ bulletPoints: ['Acme Corp unveiled Foo today.'] })],
        { c1: [makeArticle({ id: 'a-1', url: 'javascript:alert(1)', body: 'Acme Corp unveiled Foo today.' })] },
      ),
      topicRepo,
    });

    const { html, text } = await renderer.render(PLAN as never, 'https://app');

    expect(html).not.toContain('javascript:');
    expect(text).not.toContain('javascript:');
  });

  it('renders the Clusters in the order the Plan chose them', async () => {
    // The Plan is a selection *and an ordering*: the velocity it sorted by is a
    // decision taken at a moment, and a brief that re-derives its own order from
    // the Cluster table throws that decision away.
    const ordered = [
      makeCluster({ id: 'c-slow', title: 'Second story', summary: 'B summary' }),
      makeCluster({ id: 'c-fast', title: 'First story', summary: 'A summary' }),
    ];
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo(ordered),
      topicRepo,
    });

    const { html, text } = await renderer.render(
      { ...PLAN, clusterIds: ['c-fast', 'c-slow'] } as never,
      'https://app',
    );

    expect(html.indexOf('First story')).toBeLessThan(html.indexOf('Second story'));
    expect(text.indexOf('A summary')).toBeLessThan(text.indexOf('B summary'));
  });
});

describe('BriefSnapshotRenderer as a plain-text alternative', () => {
  const articles = [
    makeArticle({ id: 'a-1', body: 'Acme Corp unveiled Foo today. Analysts were surprised.' }),
  ];

  it('carries the same brief as the HTML, with no markup in it', async () => {
    // `EmailMessage.text` is required, and a client that falls back to it is
    // showing a reader the brief, not an error. So the text part is the brief
    // written in plain text rather than the HTML with tags stripped, and it
    // carries the same links.
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: clusterRepo(
        [makeCluster({ bulletPoints: ['Analysts were surprised.'] })],
        { c1: articles },
      ),
      topicRepo,
    });

    const { text } = await renderer.render(PLAN as never, 'https://app');

    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).toContain('World news');
    expect(text).toContain('2 September 2026');
    expect(text).toContain('https://app/topics/world-news');
    expect(text).toContain('Extractive summary');
    expect(text).toContain('Analysts were surprised.');
    expect(text).toContain('https://example.com/a-1');
  });
});
