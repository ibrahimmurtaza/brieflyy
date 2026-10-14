import { describe, expect, it } from 'vitest';

import {
  backfillStoryEmbeddings,
  formatEmbeddingBackfillReport,
  type EmbeddingBackfillReport,
  type EmbeddingBackfillUsage,
} from './story-embedding-backfill.js';
import { createTestDb } from '../testing/test-db.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleStoryRepo } from '../repos/story-repo.js';
import { articleText } from '../domain/feed-text.js';
import { EMPTY_SIGNATURE } from '../domain/story-signature.js';
import type { BatchingEmbeddingProvider, EmbeddingBatch, StoryEmbedding } from '../domain/embedding.js';
import type { ArticleId, SourceId, StoryId } from '../domain/types.js';
import { NO_BACKOFF } from '../domain/types.js';

/** What the vectors the double hands back are worth, so a test can tell them apart. */
const BACKFILL_MODEL = 'vendor/some-embedding-1';

/**
 * A provider that answers with a vector per text, and records what it was asked.
 *
 * Standing in for `OpenRouterEmbeddingService` at the seam the run loop actually
 * holds, so a test can say what was asked in one call rather than what came back:
 * the batching is the thing under test here, not the HTTP.
 *
 * `refuseLargerThan` is the case the endpoint does not document but the operator
 * has to survive — a batch it will not take. Answering `refused` for those is how
 * a test reaches the split the run falls back to.
 */
class AnsweringProvider implements BatchingEmbeddingProvider {
  readonly asked: (readonly string[])[] = [];
  readonly totals: number[] = [];

  constructor(
    private readonly opts: {
      readonly refuseLargerThan?: number;
      readonly refuseAll?: boolean;
      readonly nothingFor?: readonly string[];
    } = {},
  ) {}

  get calls(): number {
    return this.asked.length;
  }

  async embedBatch(texts: readonly string[]): Promise<EmbeddingBatch> {
    this.asked.push(texts);
    this.totals.push(texts.length);
    if (
      this.opts.refuseAll === true ||
      (this.opts.refuseLargerThan !== undefined && texts.length > this.opts.refuseLargerThan)
    ) {
      return { embeddings: texts.map(() => null), usage: { requests: 1, tokens: null, credits: null }, refused: true };
    }
    return {
      embeddings: texts.map((text) =>
        this.opts.nothingFor?.includes(text) === true
          ? null
          : ({ model: BACKFILL_MODEL, values: [text.length] } satisfies StoryEmbedding),
      ),
      usage: { requests: 1, tokens: texts.length * 3, credits: texts.length * 0.001 },
      refused: false,
    };
  }
}

/**
 * A corpus of Stories formed without an embedding, each from two Articles — so
 * the oldest one is a decision the run has to make rather than the only one
 * available.
 */
async function corpusOf(count: number): Promise<{
  readonly repo: DrizzleStoryRepo;
  readonly db: ReturnType<typeof createTestDb>['db'];
  readonly texts: readonly string[];
}> {
  const { db } = createTestDb();
  await new DrizzleSourceRepo(db).insert({
    id: 'src-test',
    slug: 'test',
    name: 'Test Source',
    homepageUrl: 'https://example.com',
    feedUrl: 'https://example.com/feed',
    lastPolledAt: null,
    lastSuccessAt: null,
    backoff: NO_BACKOFF,
  });

  const repo = new DrizzleStoryRepo(db);
  const articleRepo = new DrizzleArticleRepo(db);
  const texts: string[] = [];
  for (let n = 1; n <= count; n += 1) {
    const id = `story-${String(n).padStart(3, '0')}`;
    const first = new Date(`2026-05-01T00:00:00Z`);
    const later = new Date(`2026-05-02T00:00:00Z`);
    await repo.insert({
      id: id as StoryId,
      signature: EMPTY_SIGNATURE,
      embedding: null,
      firstSeenAt: first,
      lastSeenAt: later,
      published: { first, last: later },
    });
    const title = `Headline ${id}`;
    const body = `The body of story ${id}.`;
    for (const [at, articleId] of [
      [first, `a-${id}-first`],
      [later, `a-${id}-second`],
    ] as const) {
      await articleRepo.insert({
        article: {
          id: articleId as ArticleId,
          sourceId: 'src-test' as SourceId,
          externalId: articleId,
          url: `https://example.com/${articleId}`,
          title,
          body,
          publishedAt: at,
          ingestedAt: at,
          storyId: null,
          entities: [],
          signature: EMPTY_SIGNATURE,
        },
        entityIds: [],
      });
      await articleRepo.assignToStory(articleId as ArticleId, id as StoryId);
    }
    texts.push(articleText(title, body));
  }
  return { repo, db, texts };
}

describe('backfillStoryEmbeddings', () => {
  it('embeds every Story carrying none, asking about the Article each was formed from', async () => {
    const { repo, texts } = await corpusOf(3);
    const provider = new AnsweringProvider();

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 10 });

    // Asked about the oldest Article of each Story, and joined the way
    // `articleText` joins it — the same text the Story's signature was taken from,
    // because the two halves of one identity cannot be readings of two things.
    expect(provider.asked).toEqual([texts]);
    expect(report.embedded).toBe(3);
    for (const id of ['story-001', 'story-002', 'story-003'] as StoryId[]) {
      const found = await repo.getById(id);
      expect(found?.embedding?.model).toBe(BACKFILL_MODEL);
      expect(found?.embedding?.values).toEqual([texts[Number(id.slice(-3)) - 1]?.length]);
    }
  });

  it('asks in batches, and one call per batch is what it costs', async () => {
    // The whole reason the endpoint takes an array: it is billed per request, so a
    // corpus of a thousand Stories is fifty calls rather than a thousand.
    const { repo } = await corpusOf(25);
    const provider = new AnsweringProvider();

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 10 });

    expect(provider.totals).toEqual([10, 10, 5]);
    expect(report.embedded).toBe(25);
    expect(report.usage.requests).toBe(3);
  });

  it('leaves a Story already carrying an embedding exactly as it is', async () => {
    const { repo } = await corpusOf(2);
    await repo.backfillEmbedding('story-001' as StoryId, {
      model: 'vendor/some-other-embedding-2',
      values: [7, 7],
    });
    const provider = new AnsweringProvider();

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 10 });

    expect(provider.asked).toHaveLength(1);
    expect(provider.asked[0]).toHaveLength(1);
    expect(report.embedded).toBe(1);
    expect(report.considered).toBe(1);
    // Untouched, rather than re-embedded by a later model — which would leave this
    // Story unable to be compared with any formed since.
    expect((await repo.getById('story-001' as StoryId))?.embedding).toEqual({
      model: 'vendor/some-other-embedding-2',
      values: [7, 7],
    });
  });

  it('says a second run had nothing to do rather than reporting a silent zero', async () => {
    const { repo } = await corpusOf(4);
    const provider = new AnsweringProvider();
    await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 4 });

    const second = new AnsweringProvider();
    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider: second, batchSize: 4 });

    expect(second.calls).toBe(0);
    expect(report).toMatchObject({ embedded: 0, considered: 0, usage: { requests: 0 } });
    expect(formatEmbeddingBackfillReport(report, { batchSize: 4 })).toContain('nothing to do');
  });

  it('adds up what the run cost, in the three figures the provider reports', async () => {
    const { repo } = await corpusOf(20);
    const provider = new AnsweringProvider();

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 10 });

    expect(report).toMatchObject({
      unanswered: 0,
      refusedCalls: 0,
      usage: { requests: 2, tokens: 60, credits: 0.02, reportingCalls: 2 },
      models: [BACKFILL_MODEL],
    });
  });

  it('leaves a Story the provider had nothing for carrying none, and carries on', async () => {
    // The important half of "safe to stop and re-run": a run that cannot embed one
    // Story does not stop, and does not ask about it twice. The next run of the
    // command finds it still carrying none and tries again.
    const { repo, texts } = await corpusOf(3);
    const provider = new AnsweringProvider({ nothingFor: [texts[1]!] });

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 10 });

    expect(report).toMatchObject({ embedded: 2, considered: 3, unanswered: 1, refusedCalls: 0 });
    expect((await repo.getById('story-002' as StoryId))?.embedding).toBeNull();
    expect((await repo.getById('story-003' as StoryId))?.embedding?.model).toBe(BACKFILL_MODEL);

    // And the Story it could not do is the one a second run picks up.
    const second = new AnsweringProvider();
    const again = await backfillStoryEmbeddings({ storyRepo: repo, provider: second, batchSize: 10 });
    expect(second.asked).toEqual([[texts[1]!]]);
    expect(again.embedded).toBe(1);
  });

  it('asks a refused batch again one text at a time, and finishes the run', async () => {
    // Nothing upstream publishes a maximum for the array the endpoint takes, so a
    // batch size that is too large has to be something a run gets itself out of
    // rather than a re-run per page to discover.
    const { repo, texts } = await corpusOf(3);
    const provider = new AnsweringProvider({ refuseLargerThan: 2 });

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 3 });

    expect(provider.totals).toEqual([3, 1, 1, 1]);
    expect(report.embedded).toBe(3);
    expect(report.refusedCalls).toBe(1);
    expect(report.usage.requests).toBe(4);
    expect((await repo.getById('story-002' as StoryId))?.embedding?.model).toBe(BACKFILL_MODEL);
    expect(texts).toHaveLength(3);
  });

  it('reports a Story it could not embed rather than counting the run a success', async () => {
    // A provider that refuses everything is a wrong credential, a dead endpoint or
    // a quota; none of them is visible in the corpus afterwards, so the report has
    // to name them rather than read as a finished job.
    const { repo } = await corpusOf(2);
    const provider = new AnsweringProvider({ refuseAll: true });

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 5 });

    expect(report).toMatchObject({
      embedded: 0,
      considered: 2,
      unanswered: 2,
      refusedCalls: 3,
      usage: { requests: 3, tokens: null, credits: null, reportingCalls: 0 },
    });
    expect((await repo.getById('story-001' as StoryId))?.embedding).toBeNull();

    const printed = formatEmbeddingBackfillReport(report, { batchSize: 5 });
    expect(printed).toContain('0 of 2 stories now carry an embedding');
    expect(printed).toContain('nothing for 2 of them');
    expect(printed).toContain('3 of 3 calls that returned nothing at all');
  });

  it('names every model it wrote, so a corpus holding two of them is visible', async () => {
    // Two vectors that cannot be compared with each other is a state grouping
    // cannot see from inside itself, so the run that creates it is where it has
    // to be said.
    const { repo } = await corpusOf(4);
    await repo.backfillEmbedding('story-001' as StoryId, { model: 'vendor/formed-since', values: [1] });
    let asked = 0;
    const twoModels: BatchingEmbeddingProvider = {
      embedBatch: async (texts) => {
        const batch = await new AnsweringProvider().embedBatch(texts);
        asked += 1;
        return {
          ...batch,
          embeddings: batch.embeddings.map((e) =>
            e === null ? null : { ...e, model: asked === 1 ? 'vendor/a-1' : 'vendor/b-2' },
          ),
        };
      },
    };

    const report = await backfillStoryEmbeddings({
      storyRepo: repo,
      provider: twoModels,
      batchSize: 1,
    });

    expect(report.embedded).toBe(3);
    expect(report.models).toEqual(['vendor/a-1', 'vendor/b-2']);
  });

  it('names a Story holding no Article rather than reporting the corpus as finished', async () => {
    // A Story is inserted before its first Article is attached, so this is the
    // window every cycle runs in rather than a shape no database reaches. Dropped
    // by the read it would let a corpus holding one print as a corpus where
    // nothing was left to do — the one line a second run is judged on.
    const { repo } = await corpusOf(1);
    await repo.insert({
      id: 'story-orphan' as StoryId,
      signature: EMPTY_SIGNATURE,
      embedding: null,
      firstSeenAt: new Date('2026-05-01T00:00:00Z'),
      lastSeenAt: new Date('2026-05-01T00:00:00Z'),
      published: { first: new Date('2026-05-01T00:00:00Z'), last: new Date('2026-05-01T00:00:00Z') },
    });
    const provider = new AnsweringProvider();

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider, batchSize: 10 });

    expect(provider.calls).toBe(1);
    expect(report).toMatchObject({
      embedded: 1,
      considered: 2,
      unanswered: 1,
      withoutArticle: 1,
    });
    expect(formatEmbeddingBackfillReport(report, { batchSize: 10 })).toContain(
      '1 of them hold no Article to take a reading from',
    );
  });

  it('does not claim to have embedded a Story whose write was refused', async () => {
    // The `WHERE` on the write is the only thing standing between a concurrent
    // formation and a report saying this run put a vector on a Story it did not.
    // A run that counts an act it did not perform is worse than one that reports
    // nothing, because the number is what an operator reads afterwards.
    const { repo } = await corpusOf(1);
    const provider = new AnsweringProvider();

    const report = await backfillStoryEmbeddings({
      storyRepo: {
        listUnembedded: (input) => repo.listUnembedded(input),
        backfillEmbedding: async () => false,
      },
      provider,
      batchSize: 10,
    });

    expect(report).toMatchObject({ embedded: 0, considered: 1, unanswered: 1 });
    expect((await repo.getById('story-001' as StoryId))?.embedding).toBeNull();
  });

  it('marks a total as the sum over the calls that reported it', async () => {
    // Two of three calls carried a figure. Printed as a plain total it would read
    // as the whole of what the run spent.
    const { repo } = await corpusOf(2);
    let call = 0;
    const sometimes: BatchingEmbeddingProvider = {
      embedBatch: async (texts) => {
        const batch = await new AnsweringProvider().embedBatch(texts);
        call += 1;
        return call === 2
          ? { ...batch, usage: { requests: 1, tokens: null, credits: null } }
          : batch;
      },
    };

    const report = await backfillStoryEmbeddings({ storyRepo: repo, provider: sometimes, batchSize: 1 });

    expect(report.usage).toMatchObject({ requests: 2, tokens: 3, reportingCalls: 1 });
    expect(formatEmbeddingBackfillReport(report, { batchSize: 1 })).toContain(
      '3 tokens, as reported by 1 of 2 calls',
    );
  });

  it('refuses to run at all on a batch size that is no batch', async () => {
    // Zero would read a corpus as carrying nothing, spend nothing, and report the
    // same line a finished run prints. That confusion is the whole cost, so the
    // run does not start.
    const { repo } = await corpusOf(1);

    await expect(
      backfillStoryEmbeddings({
        storyRepo: repo,
        provider: new AnsweringProvider(),
        batchSize: 0,
      }),
    ).rejects.toThrow('never a batch');
  });
});

describe('formatEmbeddingBackfillReport', () => {
  /** A run where every reply carried a figure, which is the ordinary shape. */
  const spent = (over: Partial<EmbeddingBackfillUsage> = {}): EmbeddingBackfillUsage => ({
    requests: 1,
    tokens: 100,
    credits: 0.01,
    reportingCalls: 1,
    ...over,
  });

  const NOTHING_TO_DO: EmbeddingBackfillReport = {
    embedded: 0,
    considered: 0,
    unanswered: 0,
    withoutArticle: 0,
    refusedCalls: 0,
    usage: spent({ requests: 0, tokens: null, credits: null, reportingCalls: 0 }),
    models: [],
  };

  const printed = (report: EmbeddingBackfillReport): string =>
    formatEmbeddingBackfillReport(report, { batchSize: 16 });

  it('says what the rule was, in the terms the operator set it by', () => {
    // The batch size is a setting rather than a constant, so the report has to
    // name the value that was used or two runs of different settings print the
    // same thing.
    expect(printed(NOTHING_TO_DO)).toContain('16 to a call');
    expect(formatEmbeddingBackfillReport(NOTHING_TO_DO, { batchSize: 64 })).toContain('64 to a call');
  });

  it('draws an ordinary run as one line of progress, the model, and the cost', () => {
    expect(
      printed({
        embedded: 136,
        considered: 136,
        unanswered: 0,
        withoutArticle: 0,
        refusedCalls: 0,
        usage: spent({ requests: 7, tokens: 3248, credits: 0.0002, reportingCalls: 7 }),
        models: ['private/openrouter/nvidia/nemotron-3-embed-1b'],
      }),
    ).toBe(
      [
        'story embedding backfill',
        '  rule      every Story carrying no embedding, 16 to a call, and never one that carries one',
        '  embedded  136 of 136 stories now carry an embedding',
        '  model     private/openrouter/nvidia/nemotron-3-embed-1b  what the provider says produced every vector this run wrote',
        '  cost      7 requests, 3248 tokens, 0.0002 credits',
        '',
      ].join('\n'),
    );
  });

  it('says the run found nothing to do, rather than printing a zero that reads as a broken command', () => {
    // What every run after the first prints. A bare `0` here is what a command
    // that did not run, could not reach the database, or found no Stories at all
    // would all print as well — which is why this case gets its own sentence.
    expect(printed(NOTHING_TO_DO)).toBe(
      [
        'story embedding backfill',
        '  rule      every Story carrying no embedding, 16 to a call, and never one that carries one',
        '  embedded  nothing to do: every Story in this corpus already carries an embedding, so none was asked about',
        '',
      ].join('\n'),
    );
  });

  it('says a figure the provider did not report was not reported, and not that it was free', () => {
    // The one reading of the pair that would be certainly wrong: a run that spent
    // money and said it had spent none.
    expect(
      printed({
        embedded: 2,
        considered: 2,
        unanswered: 0,
        withoutArticle: 0,
        refusedCalls: 0,
        usage: spent({ tokens: null, credits: null, reportingCalls: 0 }),
        models: [],
      }),
    ).toContain('1 request, tokens not reported, credits not reported');
  });

  it('marks a total as the sum over the calls that reported it', () => {
    // Half the replies carried a figure. Printed unmarked it would read as the
    // whole of what the run spent, which is the one number here an operator would
    // take at face value when deciding whether to run it again.
    expect(
      printed({
        embedded: 2,
        considered: 2,
        unanswered: 0,
        withoutArticle: 0,
        refusedCalls: 0,
        usage: spent({ requests: 3, tokens: 100, credits: 0.01, reportingCalls: 2 }),
        models: [],
      }),
    ).toContain(
      '3 requests, 100 tokens, as reported by 2 of 3 calls, 0.01 credits, as reported by 2 of 3 calls',
    );
  });

  it('names the Stories it could not embed, and whether any call came back with nothing', () => {
    expect(
      printed({
        embedded: 40,
        considered: 136,
        unanswered: 96,
        withoutArticle: 0,
        refusedCalls: 2,
        usage: spent({ requests: 9, tokens: null, credits: null, reportingCalls: 0 }),
        models: [],
      }),
    ).toContain('the provider had nothing for 96 of them, over 2 of 9 calls that returned nothing at all');
  });

  it('names a Story holding no Article separately, because the provider never saw it', () => {
    // It cannot be embedded at all — there is no text — so counting it under the
    // provider's failures would blame the provider, and dropping it would let a
    // corpus holding one report that nothing was left to do.
    expect(
      printed({
        embedded: 4,
        considered: 5,
        unanswered: 1,
        withoutArticle: 1,
        refusedCalls: 0,
        usage: spent(),
        models: [],
      }),
    ).toContain(
      'the provider had nothing for 0 of them, and 1 of them hold no Article to take a reading from',
    );
  });

  it('does not mention refused calls when the provider answered every one of them', () => {
    // A partial reply is a fact about texts, not about the endpoint, and printing
    // "0 calls returned nothing at all" beside it would blame the wrong thing.
    expect(
      printed({
        embedded: 40,
        considered: 41,
        unanswered: 1,
        withoutArticle: 0,
        refusedCalls: 0,
        usage: spent({ requests: 3, tokens: null, credits: null, reportingCalls: 0 }),
        models: [],
      }),
    ).toContain('the provider had nothing for 1 of them\n');
  });
});