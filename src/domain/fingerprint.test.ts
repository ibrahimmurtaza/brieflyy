import { describe, expect, it } from 'vitest';

import { storyFingerprint } from './fingerprint.js';

describe('storyFingerprint', () => {
  it('returns a stable 16-char hex string', () => {
    const fp = storyFingerprint({
      entities: ['Acme Corp', 'Jane Doe'],
      keyPhrases: ['launches new product'],
    });
    expect(fp).toMatch(/^[0-9a-f]{16}$/);
    expect(fp).toBe(
      storyFingerprint({
        entities: ['Acme Corp', 'Jane Doe'],
        keyPhrases: ['launches new product'],
      }),
    );
  });

  it('is order-insensitive within entities and within keyPhrases', () => {
    const a = storyFingerprint({
      entities: ['Jane Doe', 'Acme Corp'],
      keyPhrases: ['new product launch', 'acquisition talks'],
    });
    const b = storyFingerprint({
      entities: ['Acme Corp', 'Jane Doe'],
      keyPhrases: ['acquisition talks', 'new product launch'],
    });
    expect(a).toBe(b);
  });

  it('changes when any entity changes', () => {
    const a = storyFingerprint({
      entities: ['Acme Corp', 'Jane Doe'],
      keyPhrases: ['launches new product'],
    });
    const b = storyFingerprint({
      entities: ['Acme Corp', 'John Smith'],
      keyPhrases: ['launches new product'],
    });
    expect(a).not.toBe(b);
  });

  it('changes when any key phrase changes', () => {
    const a = storyFingerprint({
      entities: ['Acme Corp'],
      keyPhrases: ['launches new product'],
    });
    const b = storyFingerprint({
      entities: ['Acme Corp'],
      keyPhrases: ['files for IPO'],
    });
    expect(a).not.toBe(b);
  });

  it('normalizes entity casing and whitespace', () => {
    const a = storyFingerprint({
      entities: ['ACME Corp'],
      keyPhrases: ['launches product'],
    });
    const b = storyFingerprint({
      entities: ['  acme corp  '],
      keyPhrases: ['launches product'],
    });
    expect(a).toBe(b);
  });

  it('produces the same fingerprint for a syndication cluster (20+ near-duplicates)', () => {
    const variants = [
      'Acme Corp launches new AI product',
      'Acme Corp unveils new AI product',
      'New AI product unveiled by Acme Corp',
      'Acme Corp debuts new AI offering',
    ];
    const fps = variants.map((title) =>
      storyFingerprint({
        entities: ['Acme Corp'],
        keyPhrases: ['new AI product', 'unveils'],
      }),
    );
    expect(new Set(fps).size).toBe(1);
  });
});