import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleEntityRepo } from './entity-repo.js';
import type { Article, ArticleId, Source } from '../domain/types.js';

async function setupSource(): Promise<{
  source: Source;
  db: ReturnType<typeof createTestDb>['db'];
}> {
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

describe('DrizzleArticleRepo', () => {
  it('inserts and finds by external id', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleArticleRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      article: makeArticle({
        id: 'a-1' as ArticleId,
        sourceId: source.id,
        externalId: 'ext-1',
        fingerprint: 'fp-1',
        publishedAt: t,
        ingestedAt: t,
      }),
      entityIds: [],
    });
    const got = await repo.findByExternalId(source.id, 'ext-1');
    expect(got?.title).toBe('Title ext-1');
  });

  it('returns null when external id is unknown', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleArticleRepo(db);
    expect(await repo.findByExternalId(source.id, 'missing')).toBeNull();
  });

  it('persists entities via the join table', async () => {
    const { db, source } = await setupSource();
    const articleRepo = new DrizzleArticleRepo(db);
    const entityRepo = new DrizzleEntityRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    const entity1 = await entityRepo.upsertByName({
      canonicalName: 'Acme Corp',
      id: 'ent-acme',
    });
    await articleRepo.insert({
      article: makeArticle({
        id: 'a-1' as ArticleId,
        sourceId: source.id,
        externalId: 'ext-1',
        fingerprint: 'fp-1',
        publishedAt: t,
        ingestedAt: t,
      }),
      entityIds: [entity1.id],
    });
    const got = await articleRepo.findByExternalId(source.id, 'ext-1');
    expect(got?.entities.map((e) => e.canonicalName)).toEqual(['Acme Corp']);
  });

  it('finds articles in window by fingerprint', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleArticleRepo(db);
    const t1 = new Date('2026-05-01T10:00:00Z');
    const t2 = new Date('2026-05-01T11:00:00Z');
    const t3 = new Date('2026-05-01T09:00:00Z');
    for (const [i, t] of [t1, t2, t3].entries()) {
      await repo.insert({
        article: makeArticle({
          id: `a-${i}` as ArticleId,
          sourceId: source.id,
          externalId: `ext-${i}`,
          fingerprint: 'fp-same',
          publishedAt: t,
          ingestedAt: t,
        }),
        entityIds: [],
      });
    }
    const from = new Date('2026-05-01T09:30:00Z');
    const inWindow = await repo.findByFingerprintInWindow({
      sourceId: source.id,
      fingerprint: 'fp-same',
      windowStart: from,
    });
    const ids = inWindow.map((a) => a.id).sort();
    expect(ids).toEqual(['a-0', 'a-1']);
  });
});