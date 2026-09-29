import { describe, expect, it } from 'vitest';
import { BriefSnapshotRenderer } from './brief-snapshot-renderer.js';
import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';

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
      clusterRepo: {
        listByTopicId: async () => [
          {
            id: 'c1',
            topicId: 't1',
            title: 'Cluster 1',
            summary: 'Extractive',
            bulletPoints: ['b1'],
            createdAt: new Date(),
            lastSeenAt: new Date(),
            articleCount: 1,
            velocity: 1,
            sourceIds: ['s1'],
            state: 'active',
          },
        ],
        listArticlesByClusterId: async () => [
          {
            id: 'a1',
            sourceId: 's1',
            externalId: 'e1',
            url: 'https://example.com/article-1',
            title: 'Article 1',
            body: 'Body',
            publishedAt: new Date(),
            ingestedAt: new Date(),
            entities: [],
            signature: EMPTY_SIGNATURE,
            storyId: 'st1',
          },
        ],
      } as any,
      llmClient: new MockLLMClient(),
      maxLlmClusters: 5,
    });

    const html = await renderer.render({ id: 'p1', topicId: 't1', userId: 'u1', createdAt: new Date(), clusterIds: ['c1'] } as any, 'https://app');
    expect(html).toContain('LLM generated summary');
    expect(html).toContain('Point one');
    expect(html).toContain('https://example.com/article-1');
  });

  it('falls back to extractive when LLM client is missing', async () => {
    const renderer = new BriefSnapshotRenderer({
      clusterRepo: {
        listByTopicId: async () => [
          {
            id: 'c1',
            topicId: 't1',
            title: 'Cluster 1',
            summary: 'Extractive summary',
            bulletPoints: ['b1'],
            createdAt: new Date(),
            lastSeenAt: new Date(),
            articleCount: 1,
            velocity: 1,
            sourceIds: ['s1'],
            state: 'active',
          },
        ],
        listArticlesByClusterId: async () => [],
      } as any,
    });

    const html = await renderer.render({ id: 'p1', topicId: 't1', userId: 'u1', createdAt: new Date(), clusterIds: ['c1'] } as any, 'https://app');
    expect(html).toContain('Extractive summary');
    expect(html).toContain('b1');
  });
});

describe('BriefSnapshotRenderer as a delivered document', () => {
  const plan = {
    id: 'p1',
    topicId: 'topic-1',
    userId: 'u1',
    createdAt: new Date('2026-09-02T12:00:00Z'),
    clusterIds: ['c1'],
  } as any;

  function clusterRepo() {
    return {
      listByTopicId: async () => [
        {
          id: 'c1',
          topicId: 'topic-1',
          title: 'Cluster 1',
          summary: 'Extractive summary',
          bulletPoints: ['b1'],
          createdAt: new Date(),
          lastSeenAt: new Date(),
          articleCount: 1,
          velocity: 1,
          sourceIds: ['s1'],
          state: 'active',
        },
      ],
      listArticlesByClusterId: async () => [],
    } as any;
  }

  const topicRepo = {
    getById: async () => ({ id: 'topic-1', slug: 'world-news', title: 'World news' }),
  } as any;

  it('is a real document: doctype, language, viewport, and a width', async () => {
    const renderer = new BriefSnapshotRenderer({ clusterRepo: clusterRepo() });

    const html = await renderer.render(plan, 'https://app');

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('max-width:600px');
  });

  it('names the Topic rather than calling every brief "Brief"', async () => {
    const renderer = new BriefSnapshotRenderer({ clusterRepo: clusterRepo(), topicRepo });

    const html = await renderer.render(plan, 'https://app');

    expect(html).toContain('<h1 style="margin:8px 0 0 0;font-size:22px;line-height:1.25;color:#111827;">World news</h1>');
    expect(html).toContain('<title>World news - Brieflyy</title>');
    expect(html).not.toContain('<h1>Brief</h1>');
  });

  it('links into the app by slug, which is what the app routes on', async () => {
    const renderer = new BriefSnapshotRenderer({ clusterRepo: clusterRepo(), topicRepo });

    const html = await renderer.render(plan, 'https://app');

    expect(html).toContain('href="https://app/topics/world-news"');
    expect(html).not.toContain('href="https://app/topics/topic-1"');
  });

  it('carries no unsubscribe link, because none of them resolve', async () => {
    const renderer = new BriefSnapshotRenderer({ clusterRepo: clusterRepo(), topicRepo });

    const html = await renderer.render(plan, 'https://app');

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
    const renderer = new BriefSnapshotRenderer({ clusterRepo: clusterRepo(), topicRepo });

    const html = await renderer.render(plan, 'https://app');

    expect(html).toContain('2 September 2026');
  });
});
