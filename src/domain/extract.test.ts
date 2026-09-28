import { describe, expect, it } from 'vitest';

import { extractEntities, extractSignature } from './extract.js';

describe('extractEntities', () => {
  it('returns empty array for empty input', () => {
    expect(extractEntities('')).toEqual([]);
  });

  it('extracts capitalized multi-word proper nouns', () => {
    const entities = extractEntities(
      'Acme Corp announced a new product yesterday in New York.',
    );
    expect(entities).toContain('Acme Corp');
    expect(entities).toContain('New York');
  });

  it('does not include sentence-leading capitalized common words', () => {
    const entities = extractEntities('The deal was announced by Acme Corp.');
    expect(entities).toContain('Acme Corp');
    expect(entities).not.toContain('The');
  });

  it('is case-sensitive: lowercase words are not entities', () => {
    const entities = extractEntities('the cat sat on the mat');
    expect(entities).toEqual([]);
  });

  it('deduplicates entities', () => {
    const entities = extractEntities(
      'Acme Corp said Acme Corp will release the product. Acme Corp confirmed it.',
    );
    const acmeCount = entities.filter((e) => e === 'Acme Corp').length;
    expect(acmeCount).toBe(1);
  });

  it('returns entities in first-appearance order', () => {
    const entities = extractEntities(
      'Jane Doe met with Acme Corp. Then Jane Doe left. Acme Corp agreed.',
    );
    const janeIdx = entities.indexOf('Jane Doe');
    const acmeIdx = entities.indexOf('Acme Corp');
    expect(janeIdx).toBeGreaterThanOrEqual(0);
    expect(acmeIdx).toBeGreaterThanOrEqual(0);
    expect(janeIdx).toBeLessThan(acmeIdx);
  });
});

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
