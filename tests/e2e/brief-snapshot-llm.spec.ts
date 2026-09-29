import { test, expect } from '@playwright/test';
import { BriefSnapshotRenderer } from '../../src/services/brief-snapshot-renderer.js';
import { EMPTY_SIGNATURE } from '../../src/domain/story-signature.js';
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
        signature: EMPTY_SIGNATURE,
        storyId: 'st-1',
      },
    ],
  } as any;
}

/** The Topic the brief is named after and links into the app by. */
const mockTopicRepo = {
  getById: async () => ({ id: 't-e2e', slug: 'ai-launch', title: 'AI launch' }),
} as any;

test('BriefSnapshot with LLM summary renders clickable bullet links', async ({ page }) => {
  const renderer = new BriefSnapshotRenderer({
    clusterRepo: createMockClusterRepo(),
    topicRepo: mockTopicRepo,
    llmClient: new MockLLMClient() as any,
    maxLlmClusters: 5,
  });

  const { html } = await renderer.render(
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

test('an extractive bullet is a real link too, not just the generated ones', async ({ page }) => {
  // The generated path is handed the Article each bullet came from. The
  // extractive path stores bare sentences and has to look the origin up itself,
  // and a browser is the only place "is this actually clickable" gets answered
  // rather than asserted about a string.
  const renderer = new BriefSnapshotRenderer({
    clusterRepo: {
      ...createMockClusterRepo(),
      listByTopicId: async () => [
        {
          id: 'c-llm-1',
          topicId: 't-e2e',
          title: 'AI Launch Cluster',
          summary: 'Extractive',
          // The mock Article's own title, which is a statement it offers when
          // its body has none, so the lookup has something real to find.
          bulletPoints: ['AI Launch'],
          createdAt: new Date(),
          lastSeenAt: new Date(),
          articleCount: 1,
          velocity: 1,
          sourceIds: ['src-ai'],
          state: 'active',
        },
      ],
    },
    topicRepo: mockTopicRepo,
  });

  const { html } = await renderer.render(
    { id: 'bp-e2e', topicId: 't-e2e', userId: 'u-e2e', createdAt: new Date(), clusterIds: ['c-llm-1'] } as any,
    'https://app',
  );

  const filePath = join(tmpdir(), `brief-snapshot-extractive-e2e-${Date.now()}.html`);
  writeFileSync(filePath, html);

  await page.goto(`file://${filePath}`);

  const link = page.locator('li a[href="https://example.com/article-ai"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveText('AI Launch');
  await expect(link).toHaveAttribute('rel', 'noopener');

  unlinkSync(filePath);
});
