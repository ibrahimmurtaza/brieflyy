import { beforeAll, describe, it, expect } from 'vitest';
import { DiscoverService } from './discover-service.js';
import { tierOfPersistedUser } from '../testing/tier.js';
import type {
  DiscoverTemplate,
  Tier,
  UserTopicSignal,
} from '../domain/types.js';

let free: Tier;
let paid: Tier;

beforeAll(async () => {
  free = await tierOfPersistedUser('free');
  paid = await tierOfPersistedUser('paid');
});

function template(input: {
  readonly id: string;
  readonly title?: string;
  readonly category?: DiscoverTemplate['category'];
  readonly defaultSourceIds?: readonly string[];
  readonly entityIds?: readonly string[];
}): DiscoverTemplate {
  return {
    id: input.id,
    slug: input.id,
    title: input.title ?? input.id,
    blurb: '',
    category: input.category ?? 'technology',
    defaultSourceIds: input.defaultSourceIds ?? [],
    entityIds: input.entityIds ?? [],
  };
}

function userTopic(input: {
  readonly topicId: string;
  readonly title?: string;
  readonly clonedFromTemplateId?: string | null;
  readonly sourceIds?: readonly string[];
  readonly entityIds?: readonly string[];
}): UserTopicSignal {
  return {
    topicId: input.topicId,
    title: input.title ?? input.topicId,
    clonedFromTemplateId: input.clonedFromTemplateId ?? null,
    sourceIds: input.sourceIds ?? [],
    entityIds: input.entityIds ?? [],
  };
}

describe('the Directory', () => {
  it('hides an entry the User cloned, matched on the template it came from', () => {
    // The defect: the filter compared Directory entries against the ids of the
    // User's Topics. Those are two different kinds of identifier, both randomly
    // generated, so "already subscribed to" excluded nothing and every entry
    // stayed on offer — including the one the User had just added. The id a
    // cloned Topic carries for this purpose is the template it was cloned from.
    const svc = new DiscoverService({
      templates: [
        template({ id: 'ai-and-ml', title: 'AI & machine learning' }),
        template({ id: 'climate', category: 'science', title: 'Climate' }),
      ],
      userTopics: [
        userTopic({ topicId: 'topic-7f3a', clonedFromTemplateId: 'ai-and-ml' }),
      ],
    });

    expect(svc.getDirectory().map((e) => e.template.id)).toEqual(['climate']);
  });

  it('hides an entry the User holds free-form under the same title', () => {
    // A User who wrote "Climate" themselves has the same Topic as the Directory's
    // "Climate" as far as the list on screen is concerned, and the server refuses
    // to clone a second one. Offering the card and then refusing is the defect
    // arriving by the other route.
    const svc = new DiscoverService({
      templates: [template({ id: 'climate', title: 'Climate' })],
      userTopics: [
        userTopic({ topicId: 'topic-1', title: 'climate', clonedFromTemplateId: null }),
      ],
    });

    expect(svc.getDirectory()).toEqual([]);
  });

  it('does not treat a Topic id that happens to equal a template id as held', () => {
    // The seed writes template id = template slug, and a clone takes that slug
    // too, so the two strings collide by accident. The Directory must be reading
    // the origin, not the coincidence.
    const svc = new DiscoverService({
      templates: [template({ id: 'climate', title: 'Climate' })],
      userTopics: [
        userTopic({
          topicId: 'climate',
          title: 'Whatever I typed myself',
          clonedFromTemplateId: null,
        }),
      ],
    });

    expect(svc.getDirectory().map((e) => e.template.id)).toEqual(['climate']);
  });

  it('keeps the order the Directory was curated in', () => {
    const svc = new DiscoverService({
      templates: [
        template({ id: 'b-news', title: 'B news', category: 'news' }),
        template({ id: 'a-news', title: 'A news', category: 'news' }),
        template({ id: 'z-tech', title: 'Z tech', category: 'technology' }),
      ],
      userTopics: [],
    });

    // The repository already sorts by category then title, and that curation is
    // the only ordering a User reads it in. Sorting again here would mean two
    // places able to disagree.
    expect(svc.getDirectory().map((e) => e.template.id)).toEqual([
      'b-news',
      'a-news',
      'z-tech',
    ]);
  });
});

describe('Recommendations', () => {
  it('scores an entry on the Entities its Sources mention, not only on Source overlap', () => {
    // CONTEXT.md: a Recommendation is derived from "the User's existing Topics'
    // Entity and Source overlap". The Entity half was never computed, so two
    // entries about the same companies from different outlets scored zero against
    // a User who followed one of them.
    const svc = new DiscoverService({
      templates: [
        template({ id: 'ai-and-ml', defaultSourceIds: ['arstechnica'], entityIds: ['openai'] }),
        template({ id: 'chips', defaultSourceIds: ['the-verge'], entityIds: ['openai'] }),
        template({ id: 'gardening', defaultSourceIds: ['bbc-news'], entityIds: ['lupin'] }),
      ],
      userTopics: [
        userTopic({
          topicId: 'topic-1',
          clonedFromTemplateId: 'machine-learning',
          sourceIds: ['arstechnica'],
          entityIds: ['openai'],
        }),
      ],
    });

    const recs = svc.getRecommendations();
    expect(recs.map((r) => r.template.id)).toContain('chips');
    expect(recs.map((r) => r.template.id)).not.toContain('gardening');
  });

  it('counts a shared Source once however many of the User topics follow it', () => {
    // The defect: the score walked User topics, their Sources and the entries,
    // adding one for every pair that matched. An entry sharing two of one Topic's
    // Sources scored two for that one Topic, and two User topics following the
    // same outlet scored it twice over. What is shared is a set, so it is
    // counted once.
    const svc = new DiscoverService({
      templates: [
        template({ id: 'broad', defaultSourceIds: ['s1', 's2'] }),
        template({ id: 'narrow', defaultSourceIds: ['s1'] }),
      ],
      userTopics: [
        userTopic({ topicId: 'topic-1', sourceIds: ['s1', 's2'] }),
        userTopic({ topicId: 'topic-2', sourceIds: ['s1', 's2'] }),
      ],
    });

    const recs = svc.getRecommendations();
    const broad = recs.find((r) => r.template.id === 'broad');
    const narrow = recs.find((r) => r.template.id === 'narrow');
    // Two distinct Sources shared, however many topics follow them.
    expect(broad?.score).toBe(2);
    expect(broad?.sharedSourceIds).toEqual(['s1', 's2']);
    expect(narrow?.score).toBe(1);
  });

  it('does not score an entry the User already holds', () => {
    const svc = new DiscoverService({
      templates: [template({ id: 'ai-and-ml', defaultSourceIds: ['s1'] })],
      userTopics: [
        userTopic({ topicId: 'topic-1', clonedFromTemplateId: 'ai-and-ml', sourceIds: ['s1'] }),
      ],
    });

    expect(svc.getRecommendations()).toEqual([]);
  });

  it('offers nothing rather than everything when the User holds nothing', () => {
    // With no Topics there is no overlap to be like, so a Recommendation list is a
    // ranking of the whole Directory with no User in it.
    const svc = new DiscoverService({
      templates: [
        template({ id: 'a', defaultSourceIds: ['s1'] }),
        template({ id: 'b', defaultSourceIds: ['s2'] }),
      ],
      userTopics: [],
    });

    expect(svc.getRecommendations()).toEqual([]);
  });

  it('orders by shared material and breaks a tie the same way every time', () => {
    const svc = new DiscoverService({
      templates: [
        template({ id: 'one', title: 'One', defaultSourceIds: ['s1'] }),
        template({ id: 'two', title: 'Two', defaultSourceIds: ['s1'] }),
        template({ id: 'three', title: 'Three', defaultSourceIds: ['s1', 's2'] }),
      ],
      userTopics: [userTopic({ topicId: 'topic-1', sourceIds: ['s1', 's2'] })],
    });

    expect(svc.getRecommendations().map((r) => r.template.id)).toEqual([
      'three',
      'one',
      'two',
    ]);
  });
});

describe('trending this week', () => {
  it('adds up what the Sources actually published, rather than sorting given numbers', () => {
    // The defect: the service was handed `[{ templateId, lift }]` and sorted it,
    // so "trending" was whatever the caller said it was and there was no volume
    // behind the word. What it is given now is a count per Source, and it
    // decides which entries are trending by adding up the Sources each one
    // follows.
    const svc = new DiscoverService({
      templates: [
        template({ id: 'world-news', defaultSourceIds: ['bbc-news', 'npr-news'] }),
        template({ id: 'quaint', defaultSourceIds: ['hacker-news'] }),
      ],
      userTopics: [],
      sourceVolume: [
        { sourceId: 'bbc-news', articleCount: 40 },
        { sourceId: 'npr-news', articleCount: 25 },
        { sourceId: 'hacker-news', articleCount: 1 },
      ],
    });

    expect(svc.getTrending().map((t) => [t.template.id, t.mentionCount])).toEqual([
      ['world-news', 65],
      ['quaint', 1],
    ]);
  });

  it('leaves out an entry none of whose Sources published in the window', () => {
    const svc = new DiscoverService({
      templates: [
        template({ id: 'world-news', defaultSourceIds: ['bbc-news'] }),
        template({ id: 'quaint', defaultSourceIds: ['hacker-news'] }),
      ],
      userTopics: [],
      sourceVolume: [{ sourceId: 'bbc-news', articleCount: 12 }],
    });

    expect(svc.getTrending().map((t) => t.template.id)).toEqual(['world-news']);
  });

  it('counts a Source listed twice on one entry once', () => {
    // Two rows for one Source are one outlet publishing, not two.
    const svc = new DiscoverService({
      templates: [template({ id: 'markets', defaultSourceIds: ['cnbc', 'cnbc'] })],
      userTopics: [],
      sourceVolume: [{ sourceId: 'cnbc', articleCount: 30 }],
    });

    expect(svc.getTrending()[0]?.mentionCount).toBe(30);
  });

  it('leaves out an entry the User already holds', () => {
    const svc = new DiscoverService({
      templates: [template({ id: 'world-news', defaultSourceIds: ['bbc-news'] })],
      userTopics: [
        userTopic({ topicId: 'topic-1', clonedFromTemplateId: 'world-news' }),
      ],
      sourceVolume: [{ sourceId: 'bbc-news', articleCount: 90 }],
    });

    expect(svc.getTrending()).toEqual([]);
  });

  it('states the window it measured over', () => {
    // "Trending" is a claim about a period of time, and a period nobody can name is
    // a period nobody can check the numbers against. Defaulted to the period the
    // application uses, and overridable so a caller that measured over something
    // else is not told its numbers covered seven days.
    expect(new DiscoverService({ templates: [], userTopics: [] }).windowDays).toBe(7);
    expect(
      new DiscoverService({ templates: [], userTopics: [], windowDays: 30 }).windowDays,
    ).toBe(30);
  });
});

describe('cloning one entry', () => {
  it('refuses a fourth Topic for a User on the free tier', () => {
    const svc = new DiscoverService({
      templates: [template({ id: 'climate' })],
      userTopics: [
        userTopic({ topicId: 'topic-1' }),
        userTopic({ topicId: 'topic-2' }),
        userTopic({ topicId: 'topic-3' }),
      ],
      tier: free,
    });

    expect(svc.canClone('climate')).toBe(false);
    expect(svc.isAtCap()).toBe(true);
  });

  it('lets the same User clone once they are on the paid tier', () => {
    const svc = new DiscoverService({
      templates: [template({ id: 'climate' })],
      userTopics: [
        userTopic({ topicId: 'topic-1' }),
        userTopic({ topicId: 'topic-2' }),
        userTopic({ topicId: 'topic-3' }),
      ],
      tier: paid,
    });

    expect(svc.canClone('climate')).toBe(true);
    expect(svc.isAtCap()).toBe(false);
  });

  it('lets a free User clone while they are under the cap', () => {
    const svc = new DiscoverService({
      templates: [template({ id: 'climate' })],
      userTopics: [userTopic({ topicId: 'topic-1' })],
      tier: free,
    });

    expect(svc.canClone('climate')).toBe(true);
  });

  it('still refuses an entry the User already holds, on any tier', () => {
    for (const t of [free, paid]) {
      const svc = new DiscoverService({
        templates: [template({ id: 'climate' })],
        userTopics: [
          userTopic({ topicId: 'topic-1', clonedFromTemplateId: 'climate' }),
        ],
        tier: t,
      });
      expect(svc.canClone('climate'), `tier ${t}`).toBe(false);
    }
  });

  it('counts a free Topic as using a slot only once', () => {
    const svc = new DiscoverService({
      templates: [template({ id: 'climate' })],
      userTopics: [
        userTopic({ topicId: 'topic-1' }),
        userTopic({ topicId: 'topic-2' }),
      ],
      tier: free,
    });

    expect(svc.heldCount).toBe(2);
    expect(svc.cap).toBe(3);
  });

  it('tells every Directory entry whether its Add control can work', () => {
    // The page renders one control per entry, and the control has to be decided
    // per entry rather than once for the page: a User at the cap has no clone
    // control anywhere, and one under it does.
    const svc = new DiscoverService({
      templates: [template({ id: 'a' }), template({ id: 'b' })],
      userTopics: [userTopic({ topicId: 'topic-1' })],
      tier: free,
    });

    expect(svc.getDirectory().every((e) => e.canClone)).toBe(true);
  });
});