import { describe, expect, it } from 'vitest';

import type { Article } from './types.js';
import { bulletsFrom, extractSentences, oneLinerFrom } from './cluster-text.js';

function makeArticle(overrides: Partial<Article> & { readonly id: string }): Article {
  return {
    sourceId: 'src-a',
    externalId: overrides.id,
    url: `https://example.com/${overrides.id}`,
    title: 'A headline',
    body: '',
    publishedAt: new Date('2026-09-02T10:00:00Z'),
    ingestedAt: new Date('2026-09-02T10:00:00Z'),
    entities: [],
    keyPhrases: [],
    fingerprint: 'fp',
    storyId: 'story-1',
    ...overrides,
  };
}

describe('extractSentences', () => {
  it('splits a body into its sentences', () => {
    const sentences = extractSentences(
      'Acme Corp unveiled Foo today. Analysts were surprised! Was any of it worth the price?',
    );

    expect(sentences).toEqual([
      'Acme Corp unveiled Foo today.',
      'Analysts were surprised!',
      'Was any of it worth the price?',
    ]);
  });

  it('drops a fragment too short to be a statement', () => {
    expect(extractSentences('Hi. Acme Corp unveiled Foo today.')).toEqual([
      'Acme Corp unveiled Foo today.',
    ]);
  });

  it('returns nothing for text with no sentence in it', () => {
    expect(extractSentences('')).toEqual([]);
    expect(extractSentences('   ')).toEqual([]);
  });
});

describe('oneLinerFrom', () => {
  it('quotes the first substantive sentence of the Article', () => {
    const article = makeArticle({
      id: 'a-1',
      body: 'Hi. Acme Corp unveiled an AI product called Foo today. Analysts were surprised by the launch.',
    });

    expect(oneLinerFrom(article)).toBe(
      'Acme Corp unveiled an AI product called Foo today.',
    );
  });

  it('quotes a sentence rather than naming the first Entity', () => {
    const article = makeArticle({
      id: 'a-1',
      body: 'Acme Corp unveiled an AI product called Foo today.',
    });
    const oneLiner = oneLinerFrom(article);

    expect(oneLiner).toContain('unveiled');
    expect(oneLiner).not.toBe('Acme Corp');
  });

  it('falls back to the title when the body has no usable sentence', () => {
    const article = makeArticle({
      id: 'a-1',
      title: 'Acme Corp launches Foo',
      body: 'Hi. Ok.',
    });

    expect(oneLinerFrom(article)).toBe('Acme Corp launches Foo');
  });

  it('falls back to the title when there is no body at all', () => {
    const article = makeArticle({ id: 'a-1', title: 'Acme Corp launches Foo' });

    expect(oneLinerFrom(article)).toBe('Acme Corp launches Foo');
  });
});

describe('bulletsFrom', () => {
  it('takes a statement from each of the top Articles', () => {
    const bullets = bulletsFrom(
      [
        makeArticle({
          id: 'a-1',
          body: 'Acme Corp unveiled Foo today. Analysts were surprised by the launch.',
        }),
        makeArticle({
          id: 'a-2',
          body: 'BrandX Inc acquired TinyCo for two billion dollars. The deal closed on Tuesday.',
        }),
      ],
      3,
    );

    expect(bullets).toEqual([
      'Acme Corp unveiled Foo today.',
      'BrandX Inc acquired TinyCo for two billion dollars.',
    ]);
  });

  it('never repeats a statement two Articles share', () => {
    const shared = 'Acme Corp unveiled an AI product called Foo today.';
    const bullets = bulletsFrom(
      [
        makeArticle({ id: 'a-1', body: `${shared} Analysts were surprised by the launch.` }),
        makeArticle({ id: 'a-2', body: `${shared} Analysts were unsurprised by the launch.` }),
      ],
      3,
    );

    expect(bullets.filter((b) => b === shared)).toHaveLength(1);
    // And each Article still contributes one, so the two read as two sources.
    expect(bullets).toHaveLength(2);
  });

  it('takes a second Article further into its text when the first sentence is taken', () => {
    const shared = 'Acme Corp today unveiled a new AI product called Foo.';
    const bullets = bulletsFrom(
      [
        makeArticle({ id: 'a-1', body: `${shared} Analysts were surprised by the launch.` }),
        makeArticle({ id: 'a-2', body: `${shared} Analysts were entirely unsurprised by the launch.` }),
      ],
      3,
      shared,
    );

    expect(bullets).toEqual([
      'Analysts were surprised by the launch.',
      'Analysts were entirely unsurprised by the launch.',
    ]);
  });

  it('falls back to an Article title when its body has no statement', () => {
    const bullets = bulletsFrom(
      [
        makeArticle({ id: 'a-1', body: 'Acme Corp unveiled Foo today.' }),
        makeArticle({ id: 'a-2', title: 'BrandX Inc acquires TinyCo', body: 'Hi. Ok.' }),
      ],
      3,
    );

    expect(bullets).toEqual([
      'Acme Corp unveiled Foo today.',
      'BrandX Inc acquires TinyCo',
    ]);
  });

  it('stops at the limit', () => {
    const bullets = bulletsFrom(
      [
        makeArticle({ id: 'a-1', body: 'Acme Corp unveiled Foo today.' }),
        makeArticle({ id: 'a-2', body: 'BrandX Inc acquired TinyCo for two billion dollars.' }),
        makeArticle({ id: 'a-3', body: 'TinyCo was bought by BrandX Inc in a surprise move.' }),
        makeArticle({ id: 'a-4', body: 'Regulators opened a review into the BrandX Inc deal.' }),
      ],
      2,
    );

    expect(bullets).toHaveLength(2);
  });

  it('never repeats the one-liner it is shown under', () => {
    const body = 'Acme Corp unveiled Foo today. Analysts were surprised by the launch.';
    const article = makeArticle({ id: 'a-1', body });

    expect(bulletsFrom([article], 3, oneLinerFrom(article))).not.toContain(
      'Acme Corp unveiled Foo today.',
    );
  });

  it('returns nothing when there are no Articles to draw from', () => {
    expect(bulletsFrom([], 3)).toEqual([]);
  });
});
