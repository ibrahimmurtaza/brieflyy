import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleStoryRepo } from './story-repo.js';
import type { Article, ArticleId, Source, StoryId } from '../domain/types.js';

async function setupSource(): Promise<{ source: Source; db: ReturnType<typeof createTestDb>['db'] }> {
  const { db } = createTestDb();
  const sourceRepo = new DrizzleSourceRepo(db);
  const source: Source = {
    id: 'src-test',
    slug: 'test',
    name: 'Test Source',
    homepageUrl: 'https://example.com',
    feedUrl: 'https://example.com/feed',
    lastPolledAt: null,
    lastSuccessAt: null,
  };
  await sourceRepo.insert(source);
  return { source, db };
}

function makeArticle(input: {
  id: ArticleId;
  sourceId: string;
  externalId: string;
  fingerprint: string;
  publishedAt: Date;
  ingestedAt: Date;
}): Article {
  return {
    id: input.id,
    sourceId: input.sourceId as Article['sourceId'],
    externalId: input.externalId,
    url: `https://example.com/${input.externalId}`,
    title: `Title ${input.externalId}`,
    body: 'Body',
    publishedAt: input.publishedAt,
    ingestedAt: input.ingestedAt,
    fingerprint: input.fingerprint,
    storyId: null,
    entities: [],
    keyPhrases: [],
  };
}

describe('DrizzleStoryRepo', () => {
  it('inserts and finds a story by (sourceId, fingerprint)', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const storyId = 'story-1' as StoryId;
    const t = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: storyId,
      sourceId: source.id,
      fingerprint: 'fp1',
      firstSeenAt: t,
      lastSeenAt: t,
    });
    const found = await repo.findByFingerprint(source.id, 'fp1');
    expect(found?.id).toBe(storyId);
    expect(found?.articleCount).toBe(0);
  });

  it('touches lastSeenAt', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const storyId = 'story-1' as StoryId;
    const t1 = new Date('2026-05-01T12:00:00Z');
    const t2 = new Date('2026-05-01T13:00:00Z');
    await repo.insert({
      id: storyId,
      sourceId: source.id,
      fingerprint: 'fp1',
      firstSeenAt: t1,
      lastSeenAt: t1,
    });
    await repo.touch(storyId, t2);
    const found = await repo.getById(storyId);
    expect(found?.lastSeenAt).toEqual(t2);
    expect(found?.firstSeenAt).toEqual(t1);
  });

  it('counts articles attached to the story', async () => {
    const { db, source } = await setupSource();
    const storyRepo = new DrizzleStoryRepo(db);
    const articleRepo = new DrizzleArticleRepo(db);
    const storyId = 'story-1' as StoryId;
    const t = new Date('2026-05-01T12:00:00Z');
    await storyRepo.insert({
      id: storyId,
      sourceId: source.id,
      fingerprint: 'fp1',
      firstSeenAt: t,
      lastSeenAt: t,
    });
    for (let i = 0; i < 3; i++) {
      await articleRepo.insert({
        article: makeArticle({
          id: `a-${i}` as ArticleId,
          sourceId: source.id,
          externalId: `ext-${i}`,
          fingerprint: 'fp1',
          publishedAt: t,
          ingestedAt: t,
        }),
        entityIds: [],
      });
      await articleRepo.assignToStory(`a-${i}` as ArticleId, storyId);
    }
    const count = await storyRepo.countArticles(storyId);
    expect(count).toBe(3);
  });

  it('finds a story by fingerprint within a window', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const storyId = 'story-1' as StoryId;
    const lastSeen = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: storyId,
      sourceId: source.id,
      fingerprint: 'fp1',
      firstSeenAt: lastSeen,
      lastSeenAt: lastSeen,
    });
    const within = await repo.findByFingerprintInWindow({
      sourceId: source.id,
      fingerprint: 'fp1',
      windowStart: new Date('2026-05-01T00:00:00Z'),
    });
    expect(within?.id).toBe(storyId);

    const outside = await repo.findByFingerprintInWindow({
      sourceId: source.id,
      fingerprint: 'fp1',
      windowStart: new Date('2026-05-02T00:00:00Z'),
    });
    expect(outside).toBeNull();
  });

  it('finds no story when no row matches the fingerprint', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const found = await repo.findByFingerprintInWindow({
      sourceId: source.id,
      fingerprint: 'no-such-fp',
      windowStart: new Date('2026-01-01T00:00:00Z'),
    });
    expect(found).toBeNull();
  });
});