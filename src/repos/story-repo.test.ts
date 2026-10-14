import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';

import { createTestDb } from '../testing/test-db.js';
import { DrizzleSourceRepo } from './source-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleStoryRepo } from './story-repo.js';
import { stories } from '../db/schema.js';
import { EMPTY_SIGNATURE, isSameStory } from '../domain/story-signature.js';
import type { StoryEmbedding } from '../domain/embedding.js';
import { NO_BACKOFF } from '../domain/types.js';
import type { Article, ArticleId, Source, StoryId } from '../domain/types.js';
import { WIRE_COPIES, signatureOf } from '../testing/story-fixtures.js';

const HOUR = 60 * 60 * 1000;

/** A four-value vector, every entry of which a float32 holds exactly. */
const A_VECTOR: StoryEmbedding = { model: 'vendor/some-embedding-1', values: [1, -2.5, 0, 3.5] };

async function setupSource(): Promise<{
  source: Source;
  db: ReturnType<typeof createTestDb>['db'];
  driver: ReturnType<typeof createTestDb>['driver'];
}> {
  const { driver, db } = createTestDb();
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
  return { source, db, driver };
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
    embedding: null,
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
      embedding: null,
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
      embedding: A_VECTOR,
      firstSeenAt: t,
      lastSeenAt: t,
      published: { first: t, last: t }
    });
    const found = await repo.getById('story-1' as StoryId);
    expect(found?.signature).toEqual(signatureOf(WIRE_COPIES[0]!.body));
    // And it is still recognisable as the same Story as a syndication copy.
    expect(isSameStory(found!.signature, signatureOf(WIRE_COPIES[7]!.body))).toBe(true);
  });

  it('reads back the embedding it stored, beside the model that produced it', async () => {
    // Both halves asserted together because the second is the only thing that makes
    // the first comparable with another Story's.
    const { db } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: 'story-1' as StoryId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      embedding: A_VECTOR,
      firstSeenAt: t,
      lastSeenAt: t,
      published: { first: t, last: t }
    });
    const found = await repo.getById('story-1' as StoryId);
    expect(found?.embedding?.values).toEqual([1, -2.5, 0, 3.5]);
    expect(found?.embedding?.model).toBe('vendor/some-embedding-1');
  });

  it('reads a Story formed with no embedding as carrying none, not as zeroes', async () => {
    const { db } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: 'story-1' as StoryId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      embedding: null,
      firstSeenAt: t,
      lastSeenAt: t,
      published: { first: t, last: t }
    });
    expect((await repo.getById('story-1' as StoryId))?.embedding).toBeNull();
  });

  it('carries the embedding on the candidate lookup the next Article is compared against', async () => {
    // The read that decides where a later Article goes, rather than a lookup by id:
    // a vector that survived insert and was then dropped by hydration would be a
    // Story that stores a second reading and never offers it to anything.
    const { db } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: 'story-1' as StoryId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      embedding: A_VECTOR,
      firstSeenAt: t,
      lastSeenAt: t,
      published: { first: t, last: t }
    });

    const candidates = await repo.listCandidates({ publishedAt: t, windowMs: 72 * 60 * 60 * 1000 });

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.embedding?.model).toBe('vendor/some-embedding-1');
    expect(candidates[0]?.embedding?.values).toEqual([1, -2.5, 0, 3.5]);
  });

  it('stores a vector it cannot read back as carrying none, rather than as a half-read one', async () => {
    // A row whose two columns disagree is a row nobody can compare with anything,
    // so the whole value reads as absence rather than the half that survived.
    const { db, driver } = await setupSource();
    const repo = new DrizzleStoryRepo(db);
    const t = new Date('2026-05-01T12:00:00Z');
    await repo.insert({
      id: 'story-1' as StoryId,
      signature: signatureOf(WIRE_COPIES[0]!.body),
      embedding: A_VECTOR,
      firstSeenAt: t,
      lastSeenAt: t,
      published: { first: t, last: t }
    });
    // Take the model away and leave the vector behind.
    driver.prepare(`UPDATE stories SET embedding_model = NULL WHERE id = ?`).run('story-1');

    expect((await repo.getById('story-1' as StoryId))?.embedding).toBeNull();
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
      embedding: null,
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
      embedding: null,
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
      embedding: null,
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
      embedding: null,
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
      embedding: null,
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
      embedding: null,
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

  describe('the Stories a backfill has to reach', () => {
    /**
     * A Story formed from Articles published at the instants given, plus the
     * embedding it formed carrying. Separate from `givenStory` because these
     * tests are about which Article a Story's second reading is taken from, and
     * that needs the publication dates to differ.
     */
    async function givenDatedStory(
      db: ReturnType<typeof createTestDb>['db'],
      repo: DrizzleStoryRepo,
      input: {
        readonly id: string;
        readonly articles: readonly { readonly id: string; readonly at: Date }[];
        readonly embedding: StoryEmbedding | null;
      },
    ): Promise<StoryId> {
      const storyId = input.id as StoryId;
      const first = input.articles[0]!.at;
      await repo.insert({
        id: storyId,
        signature: signatureOf(WIRE_COPIES[0]!.body),
        embedding: input.embedding,
        firstSeenAt: first,
        lastSeenAt: first,
        published: { first, last: input.articles.at(-1)?.at ?? first },
      });
      const articleRepo = new DrizzleArticleRepo(db);
      for (const article of input.articles) {
        await articleRepo.insert({
          article: makeArticle({
            id: article.id as ArticleId,
            sourceId: 'src-test',
            externalId: article.id,
            publishedAt: article.at,
            ingestedAt: article.at,
          }),
          entityIds: [],
        });
        await articleRepo.assignToStory(article.id as ArticleId, storyId);
      }
      return storyId;
    }

    const A_DAY = 24 * 60 * 60 * 1000;
    const at = (day: number): Date => new Date(`2026-05-0${day}T12:00:00Z`);

    it('offers the Story carrying none, with the Article it was formed from', async () => {
      // The oldest Article, because that is the one the signature is a reading of
      // and so the one the embedding has to be a reading of too. Embedding the
      // newest copy instead would make the vector describe a syndication wire
      // story rather than the report the Story exists for.
      const { db } = await setupSource();
      const repo = new DrizzleStoryRepo(db);
      await givenDatedStory(db, repo, {
        id: 'story-1',
        articles: [
          { id: 'a-newest', at: at(3) },
          { id: 'a-oldest', at: at(1) },
          { id: 'a-middle', at: at(2) },
        ],
        embedding: null,
      });

      const found = await repo.listUnembedded({ limit: 10 });

      expect(found).toHaveLength(1);
      expect(found[0]?.id).toBe('story-1');
      expect(found[0]?.title).toBe('Title a-oldest');
    });

    it('leaves out a Story already carrying an embedding', async () => {
      // The formation path covers every Story formed from here on, and a backfill
      // over a corpus holding both kinds has to leave the formed ones exactly as
      // they are.
      const { db } = await setupSource();
      const repo = new DrizzleStoryRepo(db);
      await givenDatedStory(db, repo, {
        id: 'story-embedded',
        articles: [{ id: 'a-1', at: at(1) }],
        embedding: A_VECTOR,
      });
      await givenDatedStory(db, repo, {
        id: 'story-bare',
        articles: [{ id: 'a-2', at: at(1) }],
        embedding: null,
      });

      const found = await repo.listUnembedded({ limit: 10 });

      expect(found.map((s) => s.id)).toEqual(['story-bare']);
    });

    it('offers a Story whose two halves were migrated apart', async () => {
      // The columns were added one at a time, so a database interrupted midway
      // holds a vector with no model beside it — which reads as no embedding
      // everywhere else, so it is a Story that only a backfill can fill.
      const { db } = await setupSource();
      const repo = new DrizzleStoryRepo(db);
      await givenDatedStory(db, repo, {
        id: 'story-half',
        articles: [{ id: 'a-1', at: at(1) }],
        embedding: null,
      });
      await db.update(stories).set({ embeddingModel: '   ' }).where(eq(stories.id, 'story-half'));

      expect((await repo.getById('story-half' as StoryId))?.embedding).toBeNull();
      expect((await repo.listUnembedded({ limit: 10 })).map((s) => s.id)).toEqual(['story-half']);
    });

    it('pages through a corpus in id order, and leaves out the ones already done', async () => {
      // A backfill walks this repeatedly — once per batch, and again on the next
      // run of the command. The ones written fall away behind it, so each pass
      // takes the next; the ones that could not be written are still carrying
      // none, which is what `after` is for.
      const { db } = await setupSource();
      const repo = new DrizzleStoryRepo(db);
      for (const id of ['story-1', 'story-2', 'story-3']) {
        await givenDatedStory(db, repo, {
          id,
          articles: [{ id: `a-${id}`, at: at(1) }],
          embedding: null,
        });
      }

      const first = await repo.listUnembedded({ limit: 2 });
      expect(first.map((s) => s.id)).toEqual(['story-1', 'story-2']);
      // And it can be asked to carry on from where it stopped, which is what a run
      // moves forwards on whether or not the page it last read was a success.
      expect((await repo.listUnembedded({ limit: 2, after: 'story-2' as StoryId })).map((s) => s.id)).toEqual([
        'story-3',
      ]);

      await repo.backfillEmbedding('story-1' as StoryId, A_VECTOR);
      await repo.backfillEmbedding('story-2' as StoryId, A_VECTOR);

      expect((await repo.listUnembedded({ limit: 2 })).map((s) => s.id)).toEqual(['story-3']);
      // So a Story the run could not write is offered again on the next run of
      // the command, and is not asked about twice in the middle of this one.
      expect(
        (await repo.listUnembedded({ limit: 2, after: 'story-1' as StoryId })).map((s) => s.id),
      ).toEqual(['story-3']);
    });

    it('puts an embedding on a Story that carries none, beside the model', async () => {
      const { db } = await setupSource();
      const repo = new DrizzleStoryRepo(db);
      await givenDatedStory(db, repo, {
        id: 'story-1',
        articles: [{ id: 'a-1', at: at(1) }],
        embedding: null,
      });

      expect(await repo.backfillEmbedding('story-1' as StoryId, A_VECTOR)).toBe(true);

      const found = await repo.getById('story-1' as StoryId);
      expect(found?.embedding?.values).toEqual([1, -2.5, 0, 3.5]);
      expect(found?.embedding?.model).toBe('vendor/some-embedding-1');
    });

    it('leaves an embedding it already holds exactly as it is', async () => {
      // The load-bearing claim of the whole command. An existing vector is the
      // Article's own second reading, computed once where the Story was formed;
      // replacing it would make the Story disagree with every other Story formed
      // since, and a run that reports progress while doing it is worse than one
      // that reports nothing.
      const { db } = await setupSource();
      const repo = new DrizzleStoryRepo(db);
      await givenDatedStory(db, repo, {
        id: 'story-1',
        articles: [{ id: 'a-1', at: at(1) }],
        embedding: A_VECTOR,
      });

      const later: StoryEmbedding = { model: 'vendor/some-other-embedding-2', values: [9, 9] };
      expect(await repo.backfillEmbedding('story-1' as StoryId, later)).toBe(false);

      const found = await repo.getById('story-1' as StoryId);
      expect(found?.embedding?.model).toBe('vendor/some-embedding-1');
      expect(found?.embedding?.values).toEqual([1, -2.5, 0, 3.5]);
    });

    it('says nothing was written for a Story that is not there', async () => {
      const { db } = await setupSource();
      const repo = new DrizzleStoryRepo(db);

      expect(await repo.backfillEmbedding('story-missing' as StoryId, A_VECTOR)).toBe(false);
    });
  });
});
