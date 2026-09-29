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
});
