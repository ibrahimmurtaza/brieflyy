import { describe, expect, it } from 'vitest';

import {
  EMPTY_SIGNATURE,
  STORY_MATCH_THRESHOLD,
  bestStoryMatch,
  decodeSignature,
  encodeSignature,
  isSameStory,
  normalizeSignature,
  signatureSimilarity,
  type StorySignature,
} from './story-signature.js';
import {
  SAME_COMPANY_REPORTS,
  UNRELATED_REPORTS,
  WIRE_COPIES,
  signatureOf,
} from '../testing/story-fixtures.js';

const wire = WIRE_COPIES.map((copy) => signatureOf(copy.body));
const unrelated = UNRELATED_REPORTS.map((report) => signatureOf(report.body));
const sameCompany = SAME_COMPANY_REPORTS.map((r) => signatureOf(r.body));

/** Reports that are not rewrites of one another, across both other sets. */
const differentStories: readonly StorySignature[] = [...unrelated, ...sameCompany];

describe('normalizeSignature', () => {
  it('lowercases, collapses whitespace, dedupes and sorts', () => {
    const normalized = normalizeSignature({
      words: ['Acme', '  acme  ', 'Foo', 'CORP'],
      phrases: ['launches new  product', 'launches new product'],
    });
    expect(normalized.words).toEqual(['acme', 'corp', 'foo']);
    expect(normalized.phrases).toEqual(['launches new product']);
  });

  it('drops empty entries', () => {
    const normalized = normalizeSignature({ words: ['', '   '], phrases: [''] });
    expect(normalized.words).toEqual([]);
    expect(normalized.phrases).toEqual([]);
  });
});

describe('encodeSignature / decodeSignature', () => {
  it('round-trips a signature', () => {
    const signature = signatureOf(WIRE_COPIES[0]!.body);
    expect(decodeSignature(encodeSignature(signature))).toEqual(signature);
  });

  it('reads back an empty signature rather than throwing on legacy or blank data', () => {
    expect(decodeSignature(encodeSignature(EMPTY_SIGNATURE))).toEqual(
      EMPTY_SIGNATURE,
    );
    expect(decodeSignature('')).toEqual(EMPTY_SIGNATURE);
    expect(decodeSignature('not json')).toEqual(EMPTY_SIGNATURE);
  });
});

describe('signatureSimilarity', () => {
  it('scores an identical signature as 1 and a disjoint one as 0', () => {
    const a = signatureOf('Acme Corp launched Foo on Tuesday.');
    expect(signatureSimilarity(a, a)).toBe(1);
    expect(
      signatureSimilarity(a, signatureOf('Norbury Town appointed a manager.')),
    ).toBe(0);
  });

  it('is symmetric', () => {
    const a = signatureOf(WIRE_COPIES[0]!.body);
    const b = signatureOf(WIRE_COPIES[1]!.body);
    expect(signatureSimilarity(a, b)).toBe(signatureSimilarity(b, a));
  });
});

describe('a Story signature that survives a syndication pass', () => {
  it('tolerates the rewording that turns one story into twenty-two wire copies', () => {
    for (let i = 0; i < wire.length; i++) {
      for (let j = i + 1; j < wire.length; j++) {
        expect(
          isSameStory(wire[i]!, wire[j]!),
          `copy ${i} and copy ${j} scored ${signatureSimilarity(wire[i]!, wire[j]!).toFixed(3)}`,
        ).toBe(true);
      }
    }
  });

  it('still separates genuinely different stories', () => {
    for (const a of wire) {
      for (const b of differentStories) {
        expect(
          isSameStory(a, b),
          `a wire copy and a different report scored ${signatureSimilarity(a, b).toFixed(3)}`,
        ).toBe(false);
      }
    }
    for (let i = 0; i < differentStories.length; i++) {
      for (let j = i + 1; j < differentStories.length; j++) {
        expect(
          isSameStory(differentStories[i]!, differentStories[j]!),
          `two different reports scored ${signatureSimilarity(differentStories[i]!, differentStories[j]!).toFixed(3)}`,
        ).toBe(false);
      }
    }
  });

  it('separates two different stories about the same company, which is what the phrases are for', () => {
    // The words are the one thing these pairs share, so a signature that leaned
    // on them alone would merge a product launch with a profit warning.
    for (const a of wire) {
      for (const b of sameCompany) {
        expect(isSameStory(a, b)).toBe(false);
      }
    }
    for (let i = 0; i < sameCompany.length; i++) {
      for (let j = i + 1; j < sameCompany.length; j++) {
        expect(isSameStory(sameCompany[i]!, sameCompany[j]!)).toBe(false);
      }
    }
  });

  it('leaves a margin on both sides of the threshold, so it is neither too strict nor too loose', () => {
    const same: number[] = [];
    for (let i = 0; i < wire.length; i++) {
      for (let j = i + 1; j < wire.length; j++) {
        same.push(signatureSimilarity(wire[i]!, wire[j]!));
      }
    }
    const different: number[] = [];
    for (const a of wire) {
      for (const b of differentStories) different.push(signatureSimilarity(a, b));
    }
    for (let i = 0; i < differentStories.length; i++) {
      for (let j = i + 1; j < differentStories.length; j++) {
        different.push(
          signatureSimilarity(differentStories[i]!, differentStories[j]!),
        );
      }
    }
    const least = Math.min(...same);
    const most = Math.max(...different);
    expect(least).toBeGreaterThan(STORY_MATCH_THRESHOLD);
    expect(most).toBeLessThan(STORY_MATCH_THRESHOLD);
    // Room on each side, so a copy that drifts a little either way still lands.
    // This is what keeps the threshold honest: it fails if the fixtures change
    // in a way that moves either bound, rather than drifting to meet them.
    expect(least - STORY_MATCH_THRESHOLD).toBeGreaterThan(0.04);
    expect(STORY_MATCH_THRESHOLD - most).toBeGreaterThan(0.04);
  });

  it('does not treat two Articles with nothing to say as the same Story', () => {
    // A division by an empty set is not evidence that two Articles are the same
    // Story, and treating it as such would fuse every empty feed item in a
    // window into one Story.
    expect(isSameStory(EMPTY_SIGNATURE, EMPTY_SIGNATURE)).toBe(false);
    expect(signatureSimilarity(EMPTY_SIGNATURE, EMPTY_SIGNATURE)).toBe(0);
  });

  it('is unchanged by reordering the phrases, which a rewrite of the same text can do', () => {
    const a = normalizeSignature({
      words: ['acme', 'foo'],
      phrases: ['acme launched foo', 'foo is an assistant'],
    });
    const b = normalizeSignature({
      words: ['foo', 'acme'],
      phrases: ['foo is an assistant', 'acme launched foo'],
    });
    expect(signatureSimilarity(a, b)).toBe(1);
  });
});

describe('bestStoryMatch', () => {
  const candidate = (body: string, last: Date) => ({
    id: body,
    signature: signatureOf(body),
    published: { last },
  });

  it('returns the closest Story above the threshold', () => {
    const candidates = [
      candidate(
        UNRELATED_REPORTS[0]!.body,
        new Date('2026-09-02T10:00:00Z'),
      ),
      candidate(WIRE_COPIES[9]!.body, new Date('2026-09-02T09:00:00Z')),
    ];
    const match = bestStoryMatch(candidates, signatureOf(WIRE_COPIES[0]!.body));
    expect(match?.id).toBe(WIRE_COPIES[9]!.body);
  });

  it('returns nothing when no candidate is close enough', () => {
    const candidates = [
      candidate(UNRELATED_REPORTS[0]!.body, new Date('2026-09-02T10:00:00Z')),
    ];
    expect(
      bestStoryMatch(candidates, signatureOf(WIRE_COPIES[0]!.body)),
    ).toBeNull();
    expect(bestStoryMatch([], signatureOf(WIRE_COPIES[0]!.body))).toBeNull();
  });

  it('breaks a tie on the most recent Story, so the current event wins', () => {
    const older = candidate(WIRE_COPIES[0]!.body, new Date('2026-09-01T10:00:00Z'));
    const newer = candidate(WIRE_COPIES[0]!.body, new Date('2026-09-02T10:00:00Z'));
    expect(
      bestStoryMatch([older, newer], signatureOf(WIRE_COPIES[0]!.body))?.id,
    ).toBe(newer.id);
  });
});
