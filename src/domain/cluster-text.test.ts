import { describe, expect, it } from 'vitest';

import {
  articleUrlForStatement,
  bulletsFrom,
  extractSentences,
  oneLinerFrom,
} from './cluster-text.js';
import { makeArticle } from '../testing/fixtures.js';

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

  it('returns nothing for a body that is a link and a score rather than a statement', () => {
    // What a feed with no description gives us. Quoting it back would put a
    // URL in front of a User as though it were what happened.
    expect(
      extractSentences(
        'Article URL: https://git.mills.io/prologic/parley Comments URL: https://news.ycombinator.com/item?id=49875913 Points: 33 # Comments: 10',
      ),
    ).toEqual([]);
  });

  it('keeps a real sentence that merely mentions a link', () => {
    const sentence =
      'A webassembly web based app that help editing raster and vector on browser without any subscription or signups Comments URL: https://news.ycombinator.com/item?id=1 Points: 9 # Comments: 0';

    expect(extractSentences(sentence)).toEqual([
      'A webassembly web based app that help editing raster and vector on browser without any subscription or signups',
    ]);
  });

  it('strips the citation header a feed puts in front of the text', () => {
    expect(
      extractSentences(
        'Nature, Published online: 28 September 2026; doi:10.1038/d41586-026-03004-3 China tests these therapies faster than the rest of the world.',
      ),
    ).toEqual([
      'China tests these therapies faster than the rest of the world.',
    ]);
  });

  it('leaves nothing when a citation header is all a feed gave an Article', () => {
    // What survives the header is too short to be a statement, so the Article
    // has no sentence to quote and its callers fall back to the title.
    expect(
      extractSentences(
        'Nature, Published online: 23 September 2026; doi:10.1038/d41586-026-02861-2 A special delivery.',
      ),
    ).toEqual([]);
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

  it('falls back to the title when the body is only feed metadata', () => {
    const article = makeArticle({
      id: 'a-1',
      title: 'Parley: Federated, decentralised chat that speaks plain IRC',
      body: 'Article URL: https://git.mills.io/prologic/parley Comments URL: https://news.ycombinator.com/item?id=49875913 Points: 33 # Comments: 10',
    });

    expect(oneLinerFrom(article)).toBe(
      'Parley: Federated, decentralised chat that speaks plain IRC',
    );
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

  it('falls back to an Article title when its body is only feed metadata', () => {
    const bullets = bulletsFrom(
      [
        makeArticle({ id: 'a-1', body: 'Acme Corp unveiled Foo today.' }),
        makeArticle({
          id: 'a-2',
          title: 'Parley: Federated, decentralised chat that speaks plain IRC',
          body: 'Article URL: https://git.mills.io/prologic/parley Comments URL: https://news.ycombinator.com/item?id=49875913 Points: 33 # Comments: 10',
        }),
      ],
      3,
    );

    expect(bullets).toEqual([
      'Acme Corp unveiled Foo today.',
      'Parley: Federated, decentralised chat that speaks plain IRC',
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

describe('articleUrlForStatement', () => {
  it('finds the Article a bullet was quoted from', () => {
    const articles = [
      makeArticle({ id: 'a-1', body: 'Acme Corp unveiled Foo today.' }),
      makeArticle({
        id: 'a-2',
        body: 'BrandX Inc acquired TinyCo for two billion dollars.',
      }),
    ];
    const [first, second] = bulletsFrom(articles, 3);

    expect(articleUrlForStatement(first!, articles)).toBe('https://example.com/a-1');
    expect(articleUrlForStatement(second!, articles)).toBe('https://example.com/a-2');
  });

  it('matches on the statement rather than the whole Article, so one Article can answer twice', () => {
    const articles = [
      makeArticle({
        id: 'a-1',
        body: 'Acme Corp unveiled Foo today. Analysts were surprised by the launch.',
      }),
    ];

    expect(
      articleUrlForStatement('Analysts were surprised by the launch.', articles),
    ).toBe('https://example.com/a-1');
  });

  it('answers with an Article that printed it when several did', () => {
    // A wire story carried under several bylines, which is what a Cluster of
    // one Story normally looks like. Which one led it was decided when the
    // bullets were drawn, from inputs this lookup does not have, so the answer
    // is a Source that printed the sentence — never one that did not.
    const wire = 'Acme Corp unveiled Foo today.';
    const articles = [
      makeArticle({ id: 'a-1', body: wire }),
      makeArticle({ id: 'a-2', body: wire }),
    ];

    expect(articleUrlForStatement(wire, articles)).toBe('https://example.com/a-1');
    expect(articles.some((a) => a.url === articleUrlForStatement(wire, articles))).toBe(true);
  });

  it('answers null for a statement no Article here says', () => {
    // A Cluster's bullets are written by an earlier build, or by hand in a test.
    // Guessing an Article for a sentence none of them contains would attribute
    // a quote to an outlet that did not print it.
    expect(
      articleUrlForStatement('Nobody wrote this sentence.', [
        makeArticle({ id: 'a-1', body: 'Acme Corp unveiled Foo today.' }),
      ]),
    ).toBeNull();
  });

  it('answers null for an Article whose feed gave it no usable link', () => {
    expect(
      articleUrlForStatement('Acme Corp unveiled Foo today.', [
        makeArticle({ id: 'a-1', url: '', body: 'Acme Corp unveiled Foo today.' }),
      ]),
    ).toBeNull();
  });
});
