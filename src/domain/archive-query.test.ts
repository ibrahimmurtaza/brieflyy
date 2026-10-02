import { describe, expect, it } from 'vitest';

import { parseArchiveQuery, toFtsMatch } from './archive-query.js';

describe('toFtsMatch', () => {
  it('matches the whole word rather than a fragment of it', () => {
    // The Archive is indexed by FTS5, so a query is a set of whole terms. This is
    // the difference the ticket names: a substring match returns every item
    // containing the letters, and this must not be buildable into one.
    expect(toFtsMatch('tesla')).toBe('"tesla"');
  });

  it('asks for every word the User typed, not any of them', () => {
    expect(toFtsMatch('tesla earnings')).toBe('"tesla" AND "earnings"');
  });

  it('treats everything that is not a word character as a separator', () => {
    expect(toFtsMatch('Tesla,  earnings!')).toBe('"Tesla" AND "earnings"');
  });

  it('has no expression to run for a query with no words in it', () => {
    // Returning an empty MATCH would match nothing, and a User who opened the
    // Archive without typing anything should see their Archive rather than an
    // empty search. Null is the answer that lets the caller tell those apart.
    expect(toFtsMatch('')).toBeNull();
    expect(toFtsMatch('   ')).toBeNull();
    expect(toFtsMatch('.,;!?-')).toBeNull();
  });

  it('cannot be turned into an expression of its own by what was typed', () => {
    // Everything the User types is quoted, so a term that happens to look like
    // FTS5 syntax — a prefix star, NEAR, a column filter, an unbalanced quote —
    // is a word to look for rather than an instruction to run.
    expect(toFtsMatch('tesla*')).toBe('"tesla"');
    // Case survives to the index, which folds it itself: what matters here is
    // that the word is quoted, so it is looked for rather than obeyed.
    expect(toFtsMatch('NEAR')).toBe('"NEAR"');
    expect(toFtsMatch('title:tesla')).toBe('"title" AND "tesla"');
    expect(toFtsMatch('a" OR "b')).toBe('"a" AND "OR" AND "b"');
  });

  it('keeps only the leading words of an unreasonably long query', () => {
    // An expression is built per term, so an unbounded one turns a pasted page of
    // text into a query the index has to plan. The cap is the number of terms
    // that are actually used, not a silent truncation of the string.
    const long = Array.from({ length: 50 }, (_, i) => `w${i}`).join(' ');
    const match = toFtsMatch(long);
    expect(match).toBe(
      Array.from({ length: 8 }, (_, i) => `"w${i}"`).join(' AND '),
    );
  });
});

describe('parseArchiveQuery', () => {
  it('reads the text a User typed', () => {
    expect(parseArchiveQuery({ q: '  tesla earnings ' })).toEqual({
      query: 'tesla earnings',
    });
  });

  it('omits a search box that was left empty', () => {
    expect(parseArchiveQuery({ q: '   ' })).toEqual({});
    expect(parseArchiveQuery({})).toEqual({});
  });

  it('reads a date range as whole UTC days', () => {
    // Both ends are widened to the whole day, so a User who types one date gets
    // everything that happened on it rather than one midnight's worth of it.
    expect(parseArchiveQuery({ from: '2026-09-01', to: '2026-09-20' })).toEqual({
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-20T23:59:59.999Z'),
    });
  });

  it('omits a date it cannot read rather than guessing at one', () => {
    // A malformed date in a URL is a User who typed something wrong, not a
    // filter they meant. Filtering on a date nobody asked for would hide results
    // for a reason the page cannot explain.
    expect(parseArchiveQuery({ from: 'yesterday' })).toEqual({});
    expect(parseArchiveQuery({ from: '2026-13-01' })).toEqual({});
    expect(parseArchiveQuery({ to: '2026-09-20T00:00:00Z' })).toEqual({});
  });

  it('reads the source, entity and topic filters', () => {
    expect(
      parseArchiveQuery({ source: ' src-a ', entity: 'ent-1', topic: 'topic-1' }),
    ).toEqual({ source: 'src-a', entity: 'ent-1', topic: 'topic-1' });
  });

  it('keeps every filter it was given rather than the first one it recognises', () => {
    // One query per filter rather than a single `filter` parameter: a User who
    // narrows by date and then by Source has to get both, and an implementation
    // that read one parameter would silently drop the other.
    expect(
      parseArchiveQuery({
        q: 'tesla',
        from: '2026-09-01',
        to: '2026-09-20',
        source: 'src-a',
        entity: 'ent-1',
        topic: 'topic-1',
      }),
    ).toEqual({
      query: 'tesla',
      from: new Date('2026-09-01T00:00:00.000Z'),
      to: new Date('2026-09-20T23:59:59.999Z'),
      source: 'src-a',
      entity: 'ent-1',
      topic: 'topic-1',
    });
  });

  it('takes the first value when a filter arrives more than once', () => {
    expect(parseArchiveQuery({ q: ['tesla', 'apple'] })).toEqual({
      query: 'tesla',
    });
  });
});