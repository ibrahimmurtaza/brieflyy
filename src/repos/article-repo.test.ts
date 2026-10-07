import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleEntityRepo } from './entity-repo.js';
import { extractSignature } from '../domain/extract.js';
import { canonicalEntityKey } from '../domain/entity-extraction.js';
import { normalizeSignature } from '../domain/story-signature.js';
import { NO_BACKOFF } from '../domain/types.js';
import type { Article, ArticleId, Source } from '../domain/types.js';
import { WIRE_COPIES } from '../testing/story-fixtures.js';

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
    backoff: NO_BACKOFF,
  };
  await sourceRepo.insert(source);
  return { source, db };
}

function makeArticle(input: {
  id: ArticleId;
  sourceId: string;
  externalId: string;
  publishedAt: Date;
  ingestedAt: Date;
  body?: string;
}): Article {
  const body = input.body ?? 'Body';
  return {
    id: input.id,
    sourceId: input.sourceId as Article['sourceId'],
    externalId: input.externalId,
    url: `https://example.com/${input.externalId}`,
    title: `Title ${input.externalId}`,
    body,
    publishedAt: input.publishedAt,
    ingestedAt: input.ingestedAt,
    storyId: null,
    entities: [],
    signature: normalizeSignature(extractSignature(body)),
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
    const entity1 = await entityRepo.upsertByKey({
      entity: {
        name: 'Acme Corp',
        key: canonicalEntityKey('Acme Corp'),
        kind: 'org',
      },
      id: 'ent-acme',
    });
    await articleRepo.insert({
      article: makeArticle({
        id: 'a-1' as ArticleId,
        sourceId: source.id,
        externalId: 'ext-1',
        publishedAt: t,
        ingestedAt: t,
      }),
      entityIds: [entity1.id],
    });
    const got = await articleRepo.findByExternalId(source.id, 'ext-1');
    expect(got?.entities.map((e) => e.canonicalName)).toEqual(['Acme Corp']);
  });

  it('reads back the key phrases it stored rather than an empty list', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleArticleRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    const body = WIRE_COPIES[0]!.body;
    const expected = normalizeSignature(extractSignature(body));
    expect(expected.phrases.length).toBeGreaterThan(0);
    expect(expected.words.length).toBeGreaterThan(0);

    await repo.insert({
      article: makeArticle({
        id: 'a-1' as ArticleId,
        sourceId: source.id,
        externalId: 'ext-1',
        publishedAt: t,
        ingestedAt: t,
        body,
      }),
      entityIds: [],
    });

    const got = await repo.findByExternalId(source.id, 'ext-1');
    expect(got?.signature).toEqual(expected);
  });

  it('finds the articles a Source published inside a window', async () => {
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
          publishedAt: t,
          ingestedAt: t,
        }),
        entityIds: [],
      });
    }
    const from = new Date('2026-05-01T09:30:00Z');
    const inWindow = await repo.listBySourceIdsInWindow({
      sourceIds: [source.id],
      windowStart: from,
    });
    const ids = inWindow.map((a) => a.id).sort();
    expect(ids).toEqual(['a-0', 'a-1']);
  });
});
