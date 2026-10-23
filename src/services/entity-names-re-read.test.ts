import { beforeEach, describe, expect, it } from 'vitest';

import { canonicalEntityKey, extractEntities } from '../domain/entity-extraction.js';
import { deterministicRandom, resetDeterministic } from '../testing/test-clocks.js';
import { createTestDb } from '../testing/test-db.js';
import { makeArticle, makeSource } from '../testing/fixtures.js';
import type { Article, SourceId } from '../domain/types.js';
import { DrizzleArticleRepo } from '../repos/article-repo.js';
import { DrizzleEntityRepo } from '../repos/entity-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import {
  formatEntityReReadReport,
  reReadArticleNames,
} from './entity-names-re-read.js';

const SOURCE_ID = 'reuters' as SourceId;

interface Harness {
  readonly articleRepo: DrizzleArticleRepo;
  readonly entityRepo: DrizzleEntityRepo;
  /**
   * Put an Article into the corpus, linking the names the old reading gave it.
   *
   * The old reading is not re-derivable — the whole point of the re-read is
   * that the rule has moved — so the seed carries the names explicitly. Where
   * none are given, they are the names the current reading produces, for an
   * Article the re-read will find already right.
   */
  seedArticle(seed: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly carriedBy?: readonly string[];
  }): Promise<Article>;
  /** The names the stored Article carries now, read back from the repo. */
  namesOf(externalId: string): Promise<readonly string[]>;
}

function buildHarness(): Harness {
  const { db } = createTestDb();
  const articleRepo = new DrizzleArticleRepo(db);
  const entityRepo = new DrizzleEntityRepo(db);
  let seededSource = false;

  async function link(names: readonly string[]): Promise<readonly string[]> {
    const ids: string[] = [];
    for (const name of names) {
      const entity = await entityRepo.upsertByKey({
        entity: { name, key: canonicalEntityKey(name), kind: 'concept' },
        id: deterministicRandom.uuid(),
      });
      if (!ids.includes(entity.id)) ids.push(entity.id);
    }
    return ids;
  }

  async function seedArticle(seed: {
    readonly id: string;
    readonly title: string;
    readonly body: string;
    readonly carriedBy?: readonly string[];
  }): Promise<Article> {
    if (!seededSource) {
      await new DrizzleSourceRepo(db).insert(makeSource({ id: SOURCE_ID }));
      seededSource = true;
    }
    const entityIds =
      seed.carriedBy !== undefined
        ? await link(seed.carriedBy)
        : await link(extractEntities(`${seed.title}\n${seed.body}`).map((e) => e.name));
    const article = {
      ...makeArticle({ id: seed.id, title: seed.title, body: seed.body }),
      sourceId: SOURCE_ID,
    };
    await articleRepo.insert({ article, entityIds });
    return article;
  }

  async function namesOf(externalId: string): Promise<readonly string[]> {
    const article = await articleRepo.findByExternalId(SOURCE_ID, externalId);
    return (article?.entities ?? []).map((e) => e.canonicalName);
  }

  return { articleRepo, entityRepo, seedArticle, namesOf };
}

describe('reReadArticleNames', () => {
  beforeEach(() => {
    resetDeterministic();
  });

  it('unlinks the publisher furniture the old reading named', async () => {
    // The Article was ingested under the reading that carried the byline, and
    // carries Jane Doe for it. The text has not changed; the rule has.
    const h = buildHarness();
    await h.seedArticle({
      id: 'a-1',
      title: 'Assistant arrives at enterprise price',
      body: 'Photo by Jane Doe\n\nAcme Corp unveiled Foo on Tuesday.',
      carriedBy: ['Jane Doe', 'Acme Corp', 'Foo'],
    });

    const report = await reReadArticleNames({
      articleRepo: h.articleRepo,
      entityRepo: h.entityRepo,
      random: deterministicRandom,
    });

    expect(await h.namesOf('a-1')).toEqual(['Acme Corp', 'Foo']);
    expect(report.articlesReRead).toBe(1);
    expect(report.articlesChanged).toBe(1);
    expect(report.namesChanged).toBe(1);
  });

  it('rewrites only where the reading moved', async () => {
    const h = buildHarness();
    await h.seedArticle({
      id: 'a-1',
      title: 'Assistant arrives at enterprise price',
      body: 'Photo by Jane Doe\n\nAcme Corp unveiled Foo on Tuesday.',
      carriedBy: ['Jane Doe', 'Acme Corp', 'Foo'],
    });
    await h.seedArticle({
      id: 'a-2',
      title: 'The other report of the launch',
      body: 'Acme Corp unveiled Foo on Tuesday at thirty dollars a user.',
    });

    const report = await reReadArticleNames({
      articleRepo: h.articleRepo,
      entityRepo: h.entityRepo,
      random: deterministicRandom,
    });

    expect(report.articlesReRead).toBe(2);
    expect(report.articlesChanged).toBe(1);
    expect(report.namesChanged).toBe(1);
    expect(await h.namesOf('a-2')).toEqual(['Acme Corp', 'Foo']);
  });

  it('is safe to run twice: the second run rewrites nothing', async () => {
    const h = buildHarness();
    await h.seedArticle({
      id: 'a-1',
      title: 'Assistant arrives at enterprise price',
      body: 'Photo by Jane Doe\n\nAcme Corp unveiled Foo on Tuesday.',
      carriedBy: ['Jane Doe', 'Acme Corp', 'Foo'],
    });

    const first = await reReadArticleNames({
      articleRepo: h.articleRepo,
      entityRepo: h.entityRepo,
      random: deterministicRandom,
    });
    const second = await reReadArticleNames({
      articleRepo: h.articleRepo,
      entityRepo: h.entityRepo,
      random: deterministicRandom,
      batchSize: 1,
    });

    expect(first.articlesChanged).toBe(1);
    // The read is deterministic and the keys it resolves against have stopped
    // moving, so the batch size that happened to be asked for cannot move the
    // answer.
    expect(second).toEqual({
      articlesReRead: 1,
      articlesChanged: 0,
      namesChanged: 0,
    });
    expect(await h.namesOf('a-1')).toEqual(['Acme Corp', 'Foo']);
  });

  it('reports a re-read that moved nothing as having seen the corpus', async () => {
    const h = buildHarness();
    await h.seedArticle({
      id: 'a-1',
      title: 'Assistant arrives at enterprise price',
      body: 'Acme Corp unveiled Foo on Tuesday.',
    });

    const report = await reReadArticleNames({
      articleRepo: h.articleRepo,
      entityRepo: h.entityRepo,
      random: deterministicRandom,
    });

    expect(report.articlesReRead).toBe(1);
    expect(report.articlesChanged).toBe(0);
    expect(report.namesChanged).toBe(0);
    expect(await h.namesOf('a-1')).toEqual(['Acme Corp', 'Foo']);
  });

  it('walks an empty corpus as a complete job', async () => {
    const h = buildHarness();
    const report = await reReadArticleNames({
      articleRepo: h.articleRepo,
      entityRepo: h.entityRepo,
      random: deterministicRandom,
    });
    expect(report).toEqual({
      articlesReRead: 0,
      articlesChanged: 0,
      namesChanged: 0,
    });
  });
});

describe('formatEntityReReadReport', () => {
  it('says a run saw the corpus when nothing moved', () => {
    const printed = formatEntityReReadReport({
      articlesReRead: 900,
      articlesChanged: 0,
      namesChanged: 0,
    });
    expect(printed).toMatch(/Re-read 900 Articles/);
    expect(printed).not.toMatch(/0 names/);
  });

  it('names what moved, and how many Articles hold a moved name', () => {
    expect(
      formatEntityReReadReport({
        articlesReRead: 900,
        articlesChanged: 12,
        namesChanged: 17,
      }),
    ).toMatch(/17 names moved across 12 of them/);
  });

  it('says an empty corpus is empty rather than counting a run', () => {
    expect(
      formatEntityReReadReport({
        articlesReRead: 0,
        articlesChanged: 0,
        namesChanged: 0,
      }),
    ).toMatch(/No Articles to re-read/);
  });
});
