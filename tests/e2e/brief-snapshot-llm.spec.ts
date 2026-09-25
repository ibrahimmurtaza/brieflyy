import { test, expect } from '@playwright/test';
import { BriefSnapshotRenderer } from '../../src/services/brief-snapshot-renderer.js';
import type { LLMSummaryOutput } from '../../src/domain/llm.js';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

class MockLLMClient {
  async generateSummary(
    _clusterTitle: string,
    _clusterSummary: string,
    _articles: readonly { url: string; title: string; body: string }[],
  ): Promise<LLMSummaryOutput | null> {
    return {
      summary: 'LLM generated snapshot summary',
      bulletPoints: [
        { text: 'AI launch details', articleUrl: 'https://example.com/article-ai' },
      ],
    };
  }
}

function createMockClusterRepo() {
  return {
    listByTopicId: async () => [
      {
        id: 'c-llm-1',
        topicId: 't-e2e',
        title: 'AI Launch Cluster',
        summary: 'Extractive',
        bulletPoints: ['extractive bullet'],
        createdAt: new Date(),
        lastSeenAt: new Date(),
        articleCount: 1,
        velocity: 1,
        sourceIds: ['src-ai'],
        state: 'active',
      },
    ],
    listArticlesByClusterId: async () => [
      {
        id: 'a-1',
        sourceId: 'src-ai',
        externalId: 'ext-1',
        url: 'https://example.com/article-ai',
        title: 'AI Launch',
        body: 'Body text',
        publishedAt: new Date(),
        ingestedAt: new Date(),
        entities: [],
        keyPhrases: [],
        fingerprint: 'fp-ai',
        storyId: 'st-1',
      },
    ],
  } as any;
}

test('BriefSnapshot with LLM summary renders clickable bullet links', async ({ page }) => {
  const renderer = new BriefSnapshotRenderer({
    clusterRepo: createMockClusterRepo(),
    llmClient: new MockLLMClient() as any,
    maxLlmClusters: 5,
  });

  const html = await renderer.render(
    { id: 'bp-e2e', topicId: 't-e2e', userId: 'u-e2e', createdAt: new Date(), clusterIds: ['c-llm-1'] } as any,
    'https://app',
  );

  const filePath = join(tmpdir(), `brief-snapshot-e2e-${Date.now()}.html`);
  writeFileSync(filePath, html);

  await page.goto(`file://${filePath}`);

  const link = page.locator('li a[href="https://example.com/article-ai"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');

  unlinkSync(filePath);
});
