import { test, expect } from '@playwright/test';
import { BriefSnapshotRenderer } from '../../src/services/brief-snapshot-renderer.js';
import { EMPTY_SIGNATURE } from '../../src/domain/story-signature.js';
import { systemClock } from '../../src/domain/clock.js';
import { RecordingSummaryClient } from '../../src/testing/summary-client.js';
import { writeFileSync, unlinkSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

/**
 * The rendered document on its own, with nothing between it and a browser.
 *
 * `brief-written.spec.ts` follows a brief through the application — the button, the
 * stored snapshot, the route a reader is pointed at — and this one removes the
 * application entirely, so a difference in the markup is visible without a
 * database in the way. The pair is deliberate: a spec that builds a renderer by
 * hand can be wrong about the application, and a spec that goes through the
 * application cannot say which of the two halves is at fault.
 */
function createMockClusterRepo(bulletPoints: readonly string[]) {
  return {
    listByTopicId: async () => [
      {
        id: 'c-llm-1',
        topicId: 't-e2e',
        title: 'AI Launch Cluster',
        summary: 'Extractive',
        bulletPoints,
        createdAt: new Date(),
        lastSeenAt: new Date(),
        articleCount: 1,
        velocity: 1,
        sourceIds: ['src-ai'],
        state: 'active',
      },
    ],
    listArticlesByClusterId: async (_clusterId, _sourceIds) => [
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
  } as never;
}

/** The Topic the brief is named after and links into the app by. */
const mockTopicRepo = {
  getById: async () => ({ id: 't-e2e', slug: 'ai-launch', title: 'AI launch' }),
} as never;

/** Renders a brief and writes it somewhere a browser can open it. */
async function renderTo(input: {
  readonly bullets: readonly string[];
  readonly client?: RecordingSummaryClient;
  readonly name: string;
}): Promise<string> {
  const renderer = new BriefSnapshotRenderer({
    clock: systemClock,
    clusterRepo: createMockClusterRepo(input.bullets),
    topicRepo: mockTopicRepo,
    ...(input.client ? { llmClient: input.client } : {}),
  });
  const { html } = await renderer.render(
    {
      id: 'bp-e2e',
      topicId: 't-e2e',
      userId: 'u-e2e',
      createdAt: new Date(),
      clusterIds: ['c-llm-1'],
    } as never,
    'https://app',
    { topicToken: 'e2e-topic-token', globalToken: 'e2e-global-token' },
  );
  const filePath = join(tmpdir(), `brief-snapshot-e2e-${input.name}-${Date.now()}.html`);
  writeFileSync(filePath, html);
  return filePath;
}

test('a written bullet is a real link, not just text that contains a URL', async ({ page }) => {
  // The written path is handed the Article each bullet came from, so the anchor
  // is built rather than looked up. A browser is the only place "is this actually
  // clickable, and does it open safely" gets answered rather than asserted about
  // a string.
  const filePath = await renderTo({
    name: 'written',
    bullets: ['extractive bullet'],
    client: new RecordingSummaryClient(() => ({
      summary: 'A written line.',
      bulletPoints: [
        { text: 'AI launch details', articleUrl: 'https://example.com/article-ai' },
      ],
      discardedBullets: 0,
    })),
  });

  await page.goto(`file://${filePath}`);

  const link = page.locator('li a[href="https://example.com/article-ai"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveText('AI launch details');
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');

  unlinkSync(filePath);
});

test('a quoted bullet is a real link too, which is the harder of the two', async ({ page }) => {
  // The quoted path has no client and stores bare sentences, so it has to look
  // each one up against the Cluster's own Articles. A brief made entirely of
  // quotations is what a deployment with no credential sends, so it is the one
  // most likely to be the only kind anybody ever sees.
  const filePath = await renderTo({
    name: 'quoted',
    // The mock Article's own title, which is a statement it offers when its body
    // has none, so the lookup has something real to find.
    bullets: ['AI Launch'],
  });

  await page.goto(`file://${filePath}`);

  const link = page.locator('li a[href="https://example.com/article-ai"]');
  await expect(link).toBeVisible();
  await expect(link).toHaveText('AI Launch');
  await expect(link).toHaveAttribute('rel', 'noopener');

  unlinkSync(filePath);
});
