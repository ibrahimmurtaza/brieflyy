import { describe, expect, it } from 'vitest';

import { extractSignature } from './extract.js';

describe('extractSignature', () => {
  const phrasesOf = (text: string): readonly string[] =>
    extractSignature(text).phrases;

  it('returns empty lists for empty input', () => {
    expect(extractSignature('')).toEqual({ words: [], phrases: [] });
  });

  it('extracts lowercased noun phrases containing content words', () => {
    const phrases = phrasesOf('The company launches a new AI product today');
    expect(phrases).toContain('company launches');
    expect(phrases).toContain('new ai product');
  });

  it('strips stopwords at phrase boundaries', () => {
    const phrases = phrasesOf('the deal of the year');
    expect(phrases).not.toContain('the deal of');
  });

  it('deduplicates phrases', () => {
    const phrases = phrasesOf('Acme launches product. Acme launches product again.');
    const launchCount = phrases.filter((p) => p === 'acme launches product').length;
    expect(launchCount).toBeLessThanOrEqual(1);
  });

  it('keeps content words, without stopwords, alongside the phrases', () => {
    const signature = extractSignature(
      'The company launched a new AI product with them',
    );
    expect(signature.words).toContain('company');
    expect(signature.words).toContain('ai');
    for (const stopword of ['the', 'a', 'with']) {
      expect(signature.words, stopword).not.toContain(stopword);
    }
  });

  it('never builds a key phrase across the boundary between two sentences', () => {
    // The words are the whole Article, so a two- and three-word window taken
    // over them straddles the end of one sentence and the start of the next —
    // and 'hell views' is a phrase that occurs in neither sentence. It then
    // counts towards the similarity of two Articles that share no sentence, and
    // against two copies of one story that happen to break after a different
    // word. A phrase is only evidence when it was written as one.
    const phrases = phrasesOf('The site renders views of Hell. Views of Hell at speed.');

    expect(phrases).toContain('views hell');
    expect(phrases).toContain('hell speed');
    expect(phrases).not.toContain('hell views');
  });

  it('takes phrases from every sentence rather than only from the first', () => {
    const phrases = phrasesOf('Acme Corp unveiled Foo today. Rivcom declined to comment.');

    expect(phrases).toContain('acme corp');
    expect(phrases).toContain('rivcom declined');
  });

  it('keeps a sentence whole across the newline that separates it from the next', () => {
    // A feed's description is one line per paragraph, and a full stop is not
    // guaranteed at the end of it.
    const phrases = phrasesOf('Acme Corp unveiled Foo today\nRivcom declined to comment');

    expect(phrases).toContain('acme corp');
    expect(phrases).toContain('rivcom declined');
  });
});
