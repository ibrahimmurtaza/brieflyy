import { beforeEach, describe, expect, it } from 'vitest';

import type { Db } from '../db/client.js';
import { createTestDb } from '../testing/test-db.js';
import { makeArticle, makeTopic, makeUser } from '../testing/fixtures.js';
import { DrizzleDiscoverRepo } from './discover-repo.js';
import { DrizzleTopicRepo } from './topic-repo.js';
import { DrizzleUserRepo } from './user-repo.js';
import { DrizzleArticleRepo } from './article-repo.js';
import { DrizzleEntityRepo } from './entity-repo.js';
import { applyDirectorySeed } from '../directory/seed.js';
import type { Article, EntityId, SourceId } from '../domain/types.js';

const WINDOW = {
  start: new Date('2026-09-01T00:00:00Z'),
  end: new Date('2026-09-08T00:00:00Z'),
};

/**
 * One Article inside the window, from one of the registry's Sources.
 *
 * The shared `makeArticle` fixture hard-codes `src-a` as the Source, which is not
 * one the seed knows about, and its publication date is outside this window.
 */
function article(input: {
  readonly id: string;
  readonly sourceId: string;
  readonly publishedAt: Date;
}): Article {
  return {
    ...makeArticle({ id: input.id }),
    sourceId: input.sourceId as SourceId,
    publishedAt: input.publishedAt,
    ingestedAt: input.publishedAt,
  };
}

describe('DrizzleDiscoverRepo', () => {
  let db: Db;
  let repo: DrizzleDiscoverRepo;
  let topicRepo: DrizzleTopicRepo;
  let articleRepo: DrizzleArticleRepo;
  let entityRepo: DrizzleEntityRepo;

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    repo = new DrizzleDiscoverRepo(db);
    topicRepo = new DrizzleTopicRepo(db);
    articleRepo = new DrizzleArticleRepo(db);
    entityRepo = new DrizzleEntityRepo(db);
    await applyDirectorySeed(db);
  });

  async function insertEntity(id: string, name: string): Promise<EntityId> {
    await entityRepo.upsertByKey({
      id: id as EntityId,
      entity: { name, key: name.toLowerCase(), kind: 'org' },
    });
    return id as EntityId;
  }

  /**
   * A Topic with its Sources attached.
   *
   * The two are separate tables and `insert` writes only the first, which is the
   * point: a test that passes `sourceIds` to `insert` is asserting against a
   * field nothing ever wrote down.
   */
  async function insertTopicWithSources(input: {
    readonly id: string;
    readonly userId: string;
    readonly title: string;
    readonly category: 'news' | 'technology' | 'science' | 'business' | 'policy' | 'unspecified';
    readonly originTemplateId: string | null;
    readonly sourceIds: readonly string[];
  }): Promise<void> {
    await topicRepo.insert(
      makeTopic({
        id: input.id,
        userId: input.userId,
        title: input.title,
        category: input.category,
        origin:
          input.originTemplateId === null
            ? { kind: 'freeform' }
            : { kind: 'template', templateId: input.originTemplateId },
        createdAt: new Date('2026-09-01T00:00:00Z'),
      }),
    );
    for (const [position, sourceId] of input.sourceIds.entries()) {
      await topicRepo.insertTopicSource(input.id, sourceId, position);
    }
  }

  describe('listTemplates', () => {
    it('reads the Entities an entry Sources wrote about inside the window', async () => {
      // The signal Recommendations are scored on. Without it every entry that did
      // not share an outlet with the User's Topics scored zero, however much the
      // two were about the same Entities.
      const openai = await insertEntity('ent-openai', 'OpenAI');
      const apple = await insertEntity('ent-apple', 'Apple');
      await articleRepo.insert({
        article: article({
          id: 'a-1',
          sourceId: 'arstechnica',
          publishedAt: new Date('2026-09-03T00:00:00Z'),
        }),
        entityIds: [openai],
      });
      await articleRepo.insert({
        article: article({
          id: 'a-2',
          sourceId: 'the-verge',
          publishedAt: new Date('2026-09-03T00:00:00Z'),
        }),
        entityIds: [apple],
      });

      const templates = await repo.listTemplates({ window: WINDOW });
      const ai = templates.find((t) => t.id === 'ai-and-ml');
      const tech = templates.find((t) => t.id === 'tech-industry');

      // `ai-and-ml` follows arstechnica and the-verge, `tech-industry` follows the
      // three technology outlets including both of those. Ids, so the assertion is
      // about the set rather than about the order a query happened to return.
      expect(new Set(ai?.entityIds)).toEqual(new Set([openai, apple]));
      expect(tech?.entityIds).toContain(openai);
    });

    it('ignores an Article published before the window', async () => {
      // A year-old Article is not what the window is measuring, and counting it
      // would make every entry look equally busy forever.
      const openai = await insertEntity('ent-openai', 'OpenAI');
      await articleRepo.insert({
        article: article({
          id: 'a-old',
          sourceId: 'arstechnica',
          publishedAt: new Date('2025-09-03T00:00:00Z'),
        }),
        entityIds: [openai],
      });

      const templates = await repo.listTemplates({ window: WINDOW });
      expect(templates.find((t) => t.id === 'ai-and-ml')?.entityIds).toEqual([]);
    });

    it('still lists an entry whose Sources have published nothing', async () => {
      const templates = await repo.listTemplates({ window: WINDOW });
      expect(templates.map((t) => t.id)).toContain('world-news');
      expect(templates.find((t) => t.id === 'world-news')?.entityIds).toEqual([]);
    });
  });

  describe('listUserTopics', () => {
    beforeEach(async () => {
      await new DrizzleUserRepo(db).insert(
        makeUser({ id: 'user-1', onboardingState: 'completed' }),
      );
    });

    it('reports the template each Topic was cloned from', async () => {
      // The only identifier that says a User already has this Directory entry. The
      // Topic's own id cannot: it belongs to a different kind of thing.
      await insertTopicWithSources({
        id: 'topic-1',
        userId: 'user-1',
        title: 'World news',
        category: 'news',
        originTemplateId: 'world-news',
        sourceIds: ['bbc-news'],
      });

      const mine = await repo.listUserTopics({
        userId: 'user-1',
        window: WINDOW,
      });
      expect(mine).toEqual([
        {
          topicId: 'topic-1',
          title: 'World news',
          clonedFromTemplateId: 'world-news',
          sourceIds: ['bbc-news'],
          entityIds: [],
        },
      ]);
    });

    it('reports a free-form Topic as cloned from nothing', async () => {
      await insertTopicWithSources({
        id: 'topic-2',
        userId: 'user-1',
        title: 'Fusion energy',
        category: 'unspecified',
        originTemplateId: null,
        sourceIds: [],
      });

      const mine = await repo.listUserTopics({
        userId: 'user-1',
        window: WINDOW,
      });
      expect(mine[0]?.clonedFromTemplateId).toBeNull();
    });

    it('leaves out a removed Topic, because it no longer holds a slot', async () => {
      await insertTopicWithSources({
        id: 'topic-3',
        userId: 'user-1',
        title: 'Markets',
        category: 'business',
        originTemplateId: 'markets',
        sourceIds: ['cnbc-finance'],
      });
      await topicRepo.remove('topic-3', new Date('2026-09-05T00:00:00Z'));

      const mine = await repo.listUserTopics({
        userId: 'user-1',
        window: WINDOW,
      });
      expect(mine).toEqual([]);
    });

    it('reports the Entities the Topic Sources wrote about inside the window', async () => {
      const openai = await insertEntity('ent-openai', 'OpenAI');
      await insertTopicWithSources({
        id: 'topic-4',
        userId: 'user-1',
        title: 'My tech',
        category: 'unspecified',
        originTemplateId: null,
        sourceIds: ['arstechnica'],
      });
      await articleRepo.insert({
        article: article({
          id: 'a-3',
          sourceId: 'arstechnica',
          publishedAt: new Date('2026-09-03T00:00:00Z'),
        }),
        entityIds: [openai],
      });

      const mine = await repo.listUserTopics({
        userId: 'user-1',
        window: WINDOW,
      });
      expect(mine[0]?.entityIds).toEqual([openai]);
    });

    it('leaves out another User Topics', async () => {
      await new DrizzleUserRepo(db).insert(
        makeUser({ id: 'user-2', onboardingState: 'completed' }),
      );
      await insertTopicWithSources({
        id: 'topic-5',
        userId: 'user-2',
        title: 'Theirs',
        category: 'news',
        originTemplateId: 'world-news',
        sourceIds: ['bbc-news'],
      });

      const mine = await repo.listUserTopics({
        userId: 'user-1',
        window: WINDOW,
      });
      expect(mine).toEqual([]);
    });
  });

  describe('listSourceVolume', () => {
    it('counts the Articles each Source published inside the window', async () => {
      for (const [i, date] of [
        '2026-09-02T00:00:00Z',
        '2026-09-03T00:00:00Z',
        '2026-09-04T00:00:00Z',
      ].entries()) {
        await articleRepo.insert({
          article: article({
            id: `a-${i}`,
            sourceId: 'bbc-news',
            publishedAt: new Date(date),
          }),
          entityIds: [],
        });
      }
      await articleRepo.insert({
        article: article({
          id: 'a-old',
          sourceId: 'bbc-news',
          publishedAt: new Date('2025-09-02T00:00:00Z'),
        }),
        entityIds: [],
      });

      const volume = await repo.listSourceVolume({ window: WINDOW });
      expect(volume).toEqual([{ sourceId: 'bbc-news', articleCount: 3 }]);
    });

    it('says nothing about a Source that has published nothing', async () => {
      const volume = await repo.listSourceVolume({ window: WINDOW });
      expect(volume).toEqual([]);
    });

    it('ignores an Article dated after the window closes', async () => {
      // The window has an end as well as a start. An Article whose publication date
      // is in the future — a feed that mislabels an archive, a clock that was wrong
      // when the row was written — would otherwise count towards "this week" for
      // as long as the database keeps it, and nothing would ever say otherwise.
      await articleRepo.insert({
        article: article({
          id: 'a-future',
          sourceId: 'bbc-news',
          publishedAt: new Date('2027-01-01T00:00:00Z'),
        }),
        entityIds: [],
      });

      const volume = await repo.listSourceVolume({ window: WINDOW });
      expect(volume).toEqual([]);
    });
  });
});