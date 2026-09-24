import { describe, expect, it } from 'vitest';
import { BriefSnapshotRenderer } from './brief-snapshot-renderer.js';
import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';

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
            keyPhrases: [],
            fingerprint: 'fp1',
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
