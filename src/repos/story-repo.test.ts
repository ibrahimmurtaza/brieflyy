import { describe, expect, it } from 'vitest';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleStoryRepo } from './story-repo.js';
import { EMPTY_SIGNATURE, isSameStory } from '../domain/story-signature.js';
import { NO_BACKOFF } from '../domain/types.js';
import type { Article, ArticleId, Source, StoryId } from '../domain/types.js';
import { WIRE_COPIES, signatureOf } from '../testing/story-fixtures.js';

const HOUR = 60 * 60 * 1000;

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

/** A second outlet, so a Story can be seen holding Articles from more than one. */
async function addSource(
  db: ReturnType<typeof createTestDb>['db'],
  id: string,
  name: string,
): Promise<void> {
  await new DrizzleSourceRepo(db).insert({
    id,
    slug: id,
    name,
    homepageUrl: `https://${id}.example.com`,
    feedUrl: `https://${id}.example.com/feed`,
    lastPolledAt: null,
    lastSuccessAt: null,
    backoff: NO_BACKOFF,
  });
}

function makeArticle(input: {
  id: ArticleId;
  sourceId: string;
  externalId: string;
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
    storyId: null,
    entities: [],
    signature: EMPTY_SIGNATURE,
  };
}

/**
 * A Story and the Articles in it, one Article per Source given.
 *
 * A Story is what the Articles say, so the two are always written together: a
 * Story with no Articles has no Sources and no signature to compare against,
 * which is not a shape any of these tests is about.
 */
async function givenStory(
  db: ReturnType<typeof createTestDb>['db'],
  repo: DrizzleStoryRepo,
  input: {
    readonly id: string;
    readonly articles: readonly { readonly id: string; readonly sourceId: string }[];
    readonly at: Date;
  },
): Promise<StoryId> {
  const storyId = input.id as StoryId;
  await repo.insert({
    id: storyId,
    signature: signatureOf(WIRE_COPIES[0]!.body),
    firstSeenAt: input.at,
    lastSeenAt: input.at,
    published: { first: input.at, last: input.at }
  });
  const articleRepo = new DrizzleArticleRepo(db);
  for (const article of input.articles) {
    await articleRepo.insert({
      article: makeArticle({
        id: article.id as ArticleId,
        sourceId: article.sourceId,
        externalId: article.id,
        publishedAt: input.at,
        ingestedAt: input.at,
      }),
      entityIds: [],
    });
    await articleRepo.assignToStory(article.id as ArticleId, storyId);
  }
  return storyId;
}

describe('DrizzleStoryRepo', () => {
  it('inserts and finds a story by id', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const storyId = 'story-1' as StoryId;
    const t = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: storyId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      firstSeenAt: t,
      lastSeenAt: t,
      published: { first: t, last: t }
    });
    const found = await repo.getById(storyId);
    expect(found?.id).toBe(storyId);
    expect(found?.articleCount).toBe(0);
  });

  it('reads back the signature it stored, so a later Article can be compared to it', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: 'story-1' as StoryId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      firstSeenAt: t,
      lastSeenAt: t,
      published: { first: t, last: t }
    });
    const found = await repo.getById('story-1' as StoryId);
    expect(found?.signature).toEqual(signatureOf(WIRE_COPIES[0]!.body));
    // And it is still recognisable as the same Story as a syndication copy.
    expect(isSameStory(found!.signature, signatureOf(WIRE_COPIES[7]!.body))).toBe(true);
  });

  it('touches lastSeenAt without moving the published range', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const storyId = 'story-1' as StoryId;
    const published = new Date('2026-05-01T12:00:00Z');
    const t2 = new Date('2026-05-01T13:00:00Z');
    await repo.insert({
      id: storyId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      firstSeenAt: published,
      lastSeenAt: published,
      published: { first: published, last: published }
    });
    await repo.touch(storyId, t2);
    const found = await repo.getById(storyId);
    expect(found?.lastSeenAt).toEqual(t2);
    expect(found?.firstSeenAt).toEqual(published);
    expect(found?.published.last).toEqual(published);
  });

  it('widens the published range when a copy published outside it merges in', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const storyId = 'story-1' as StoryId;
    const first = new Date('2026-05-01T12:00:00Z');
    const later = new Date('2026-05-01T14:00:00Z');
    const earlier = new Date('2026-05-01T11:00:00Z');
    await repo.insert({
      id: storyId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      firstSeenAt: first,
      lastSeenAt: first,
      published: { first: first, last: first }
    });
    await repo.widenPublishedRange(storyId, later);
    await repo.widenPublishedRange(storyId, earlier);
    const found = await repo.getById(storyId);
    expect(found?.published.first).toEqual(earlier);
    expect(found?.published.last).toEqual(later);
  });

  it('counts articles attached to the story', async () => {
    const { db, source } = await setupSource();
    const storyRepo = new DrizzleStoryRepo(db);
    const articleRepo = new DrizzleArticleRepo(db);
    const storyId = 'story-1' as StoryId;
    const t = new Date('2026-05-01T12:00:00Z');
    await storyRepo.insert({
      id: storyId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      firstSeenAt: t,
      lastSeenAt: t,
      published: { first: t, last: t }
    });
    for (let i = 0; i < 3; i++) {
      await articleRepo.insert({
        article: makeArticle({
          id: `a-${i}` as ArticleId,
          sourceId: source.id,
          externalId: `ext-${i}`,
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

  it('offers a Story as a candidate when its published range is near an Article', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const seenAt = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: 'story-1' as StoryId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      published: { first: new Date('2026-05-01T10:00:00Z'), last: new Date('2026-05-01T10:00:00Z') }
    });

    const inside = await repo.listCandidates({
      publishedAt: new Date('2026-05-01T10:00:00Z'),
      windowMs: 72 * HOUR,
    });
    expect(inside.map((s) => s.id)).toEqual(['story-1']);

    // Later than the window by publication, though the poll is moments away.
    const outside = await repo.listCandidates({
      publishedAt: new Date('2026-05-10T10:00:00Z'),
      windowMs: 72 * HOUR,
    });
    expect(outside).toEqual([]);
  });

  it('offers a Story published before the Article as well as after it', async () => {
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const seenAt = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: 'story-1' as StoryId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      published: { first: new Date('2026-05-01T10:00:00Z'), last: new Date('2026-05-01T10:00:00Z') }
    });

    const before = await repo.listCandidates({
      publishedAt: new Date('2026-05-01T09:00:00Z'),
      windowMs: 72 * HOUR,
    });
    expect(before.map((s) => s.id)).toEqual(['story-1']);
  });

  it('does not offer a Story that would have to grow past the window to take the Article', async () => {
    // Two Articles 60 hours apart are both individually inside 72 hours of each
    // other, so a chain of them would walk a single Story four weeks from its
    // own first Article. The Story has to stay inside one window instead.
    const { db, source } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const seenAt = new Date('2026-05-01T12:00:00Z');
    const firstPublished = new Date('2026-05-01T10:00:00Z');
    const lastPublished = new Date('2026-05-03T22:00:00Z');
    await repo.insert({
      id: 'story-1' as StoryId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      firstSeenAt: seenAt,
      lastSeenAt: seenAt,
      published: { first: firstPublished, last: lastPublished }
    });

    // An Article inside the Story's existing range is a candidate.
    expect(
      (
        await repo.listCandidates({
          publishedAt: new Date('2026-05-02T16:00:00Z'),
          windowMs: 72 * HOUR,
        })
      ).map((s) => s.id),
    ).toEqual(['story-1']);

    // One more day would make the range three days and one hour long, so this
    // Article is not a candidate even though it is only 24 hours from the
    // Story's newest Article.
    expect(
      await repo.listCandidates({
        publishedAt: new Date('2026-05-04T22:00:00Z'),
        windowMs: 72 * HOUR,
      }),
    ).toEqual([]);
  });

  it('offers a Story whichever Source it was first reported by', async () => {
    // The dedup lookup used to be scoped to one Source, which is what kept the
    // same story reported by two outlets from ever being one Story — the one
    // case a Story exists to collapse. The caller names no Source at all now:
    // what an Article can join is a fact about when the reporting happened.
    const { db } = await setupSource();
    await addSource(db, 'src-other', 'Other Source');
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    // One Story formed by each outlet, each with the Article that formed it.
    await givenStory(db, repo, {
      id: 'story-here',
      articles: [{ id: 'a-here', sourceId: 'src-test' }],
      at: t,
    });
    await givenStory(db, repo, {
      id: 'story-elsewhere',
      articles: [{ id: 'a-elsewhere', sourceId: 'src-other' }],
      at: t,
    });

    const found = await repo.listCandidates({
      publishedAt: t,
      windowMs: 72 * HOUR,
    });

    // Both are on offer, and neither is filtered out for having come from
    // somewhere else.
    expect([...found].map((s) => s.id).sort()).toEqual([
      'story-elsewhere',
      'story-here',
    ]);
  });

  it('reports every Source a Story has Articles from', async () => {
    const { db } = await setupSource();
    await addSource(db, 'src-other', 'Other Source');
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    // One story, reported three times: twice by one outlet and once by another.
    await givenStory(db, repo, {
      id: 'story-1',
      articles: [
        { id: 'a-1', sourceId: 'src-test' },
        { id: 'a-2', sourceId: 'src-test' },
        { id: 'a-3', sourceId: 'src-other' },
      ],
      at: t,
    });

    const found = await repo.getById('story-1' as StoryId);

    expect(found?.articleCount).toBe(3);
    expect(found?.sourceIds).toEqual(['src-other', 'src-test']);
  });

  it('finds a Story from any of the Sources it has Articles from', async () => {
    // A Topic follows some Sources, not all of them, and a Story that has
    // picked up a copy from an outlet it does not follow is still a Story that
    // outlet reported. Reading it back by the Source that formed it would drop
    // it out of the one Topic that follows the other one.
    const { db } = await setupSource();
    await addSource(db, 'src-other', 'Other Source');
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    await givenStory(db, repo, {
      id: 'story-1',
      articles: [
        { id: 'a-here', sourceId: 'src-test' },
        { id: 'a-elsewhere', sourceId: 'src-other' },
      ],
      at: t,
    });

    // Asked for by the Source that did not form the Story, it still comes back.
    const found = await repo.listBySourceIdsInWindow({
      sourceIds: ['src-other'],
      windowStart: new Date('2026-04-01T00:00:00Z'),
    });

    expect(found.map((s) => s.id)).toEqual(['story-1']);
    expect(found[0]?.sourceIds).toEqual(['src-other', 'src-test']);
  });

  it('leaves out a Story none of its Articles came from', async () => {
    const { db } = await setupSource();
    await addSource(db, 'src-other', 'Other Source');
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    await givenStory(db, repo, {
      id: 'story-1',
      articles: [{ id: 'a-here', sourceId: 'src-test' }],
      at: t,
    });

    const found = await repo.listBySourceIdsInWindow({
      sourceIds: ['src-other'],
      windowStart: new Date('2026-04-01T00:00:00Z'),
    });

    expect(found).toEqual([]);
  });
});
