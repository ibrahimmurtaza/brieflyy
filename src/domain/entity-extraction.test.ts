import { describe, expect, it } from 'vitest';

import {
  canonicalEntityKey,
  extractEntities,
} from './entity-extraction.js';
import {
  SAME_COMPANY_REPORTS,
  UNRELATED_REPORTS,
  WIRE_COPIES,
} from '../testing/story-fixtures.js';

/** The names extraction found, in the order it found them. */
function names(text: string): string[] {
  return extractEntities(text).map((e) => e.name);
}

/** The canonical keys extraction found, which is what identity is decided on. */
function keys(text: string): string[] {
  return extractEntities(text).map((e) => e.key);
}

function keysOf(...texts: readonly string[]): Set<string> {
  return new Set(texts.flatMap(keys));
}

/** The share of the larger set the two have in common, as overlap counts it. */
function overlap(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  const larger = Math.max(a.size, b.size);
  if (larger === 0) return 0;
  let shared = 0;
  for (const key of a) if (b.has(key)) shared += 1;
  return shared / larger;
}

const report = (r: { headline: string; body: string }): string =>
  `${r.headline}\n${r.body}`;

describe('extractEntities', () => {
  it('returns nothing for empty input', () => {
    expect(extractEntities('')).toEqual([]);
  });

  it('reads nothing in a sentence with no capitalised word in it', () => {
    expect(names('the cat sat on the mat')).toEqual([]);
  });

  it('reads the casing an outlet actually writes with', () => {
    const found = names(
      'IBM confirmed the report. eBay and McDonald also said so. NATO and the FDA were briefed.',
    );
    expect(found).toEqual(
      expect.arrayContaining(['IBM', 'eBay', 'McDonald', 'NATO', 'FDA']),
    );
  });

  it('does not read a shouted paragraph as a page of entities', () => {
    // A feed that upper-cases its body would otherwise extract every word in it,
    // and an Article whose Entity set is every word overlaps every other.
    expect(
      names(
        'THE ASSISTANT RUNS INSIDE A CUSTOMER OWN DATA CENTRE AND NOT IN THE CLOUD, ACME SAID, KEEPING CONFIDENTIAL MATERIAL OFF SHARED SERVERS.',
      ),
    ).toEqual([]);
  });

  it('reads a name once, whole, rather than as overlapping pieces of itself', () => {
    const found = names('The New York Times reported it on Tuesday.');
    expect(found).toContain('New York Times');
    // No piece of the name is also emitted on its own, and no other name is
    // emitted out of the same span.
    expect(found.filter((n) => n.includes('York'))).toEqual(['New York Times']);
  });

  it('keeps a name whole across a possessive, a hyphen and an inner connector', () => {
    expect(
      names("Acme Corp's shares rose, said Jean-Luc Picard of the Acme Corp."),
    ).toEqual(expect.arrayContaining(['Acme Corp', 'Jean-Luc Picard']));
  });

  it('reads a name with a connector inside it once, connector and all', () => {
    // The two halves of such a name are not Entities, and a run that stepped over
    // the connector rather than carrying it would leave the scan pointing at the
    // middle of the name it had just read.
    expect(names('The Bank of England raised rates.')).toEqual([
      'Bank of England',
    ]);
    expect(
      names('The Institute of Cancer Research published a study.'),
    ).toEqual(['Institute of Cancer Research']);
  });

  it('does not glue two names together across a conjunction or a legal suffix', () => {
    expect(names('Acme Corp rival Rivcom launched a rival assistant.')).toEqual(
      expect.arrayContaining(['Acme Corp', 'Rivcom']),
    );
    // "Acme Corp Foo" is a company and a product, not one name spelled oddly.
    const glued = names('Acme Corp Foo, an assistant for enterprise customers.');
    expect(glued).toEqual(expect.arrayContaining(['Acme Corp', 'Foo']));
  });

  it('leaves out what is capitalised only because a sentence starts with it', () => {
    const found = names(
      'Shares in Riverton rose on Tuesday. Rainfall closed two bridges in January. However, Rivcom disagreed.',
    );
    expect(found).toEqual(expect.arrayContaining(['Riverton', 'Rivcom']));
    for (const noise of [
      'Shares',
      'Rainfall',
      'Two',
      'Tuesday',
      'January',
      'However',
    ]) {
      expect(found, noise).not.toContain(noise);
    }
  });

  it('leaves out the abbreviations that would overlap everything', () => {
    expect(names('The US and the EU said GDP would rise, the CEO added.')).toEqual(
      [],
    );
  });

  it('deduplicates by canonical identity, not by the letters used to write it', () => {
    const found = names('ACME CORP said it. Acme Corp agreed. Acme Corporation confirmed.');
    expect(found.filter((n) => canonicalEntityKey(n) === 'acme')).toHaveLength(1);
  });

  it('returns entities in first-appearance order', () => {
    const found = names(
      'Jane Doe met with Acme Corp. Then Jane Doe left. Acme Corp agreed.',
    );
    expect(found.indexOf('Jane Doe')).toBeLessThan(found.indexOf('Acme Corp'));
  });

  it('finds the same Entities in every rewrite of one story', () => {
    // What the pipeline needs: two Articles no single spelling rule can make
    // identical still share most of their Entities, because overlap is what
    // Cluster grouping is measured on.
    const perCopy = WIRE_COPIES.map((copy) => keysOf(report(copy)));
    for (const found of perCopy) {
      // The two Entities that identify the story, and that an outlet cannot
      // write about it without naming, are in every rewrite of it.
      expect([...found], 'names the company and the product').toEqual(
        expect.arrayContaining(['acme', 'foo']),
      );
    }
    let least = 1;
    for (let i = 0; i < perCopy.length; i++) {
      for (let j = i + 1; j < perCopy.length; j++) {
        least = Math.min(least, overlap(perCopy[i]!, perCopy[j]!));
      }
    }
    // Half of the larger set is the share two Stories need to be one Cluster, so
    // every pair of rewrites clears the bar grouping sets. The pairs that sit
    // exactly on it are the ones where one rewrite names two rivals the other
    // does not, which is a difference in what was written rather than in what was
    // read; what this fails on is extraction missing a name two Articles have in
    // common, which is what would quietly empty a Cluster.
    expect(least).toBeGreaterThanOrEqual(0.5);
  });

  it('does not find Entities in common between two different stories', () => {
    // The other half of the claim: Entities loose enough to link every rewrite
    // of a launch are also loose enough to link a launch to a rate decision.
    const wire = WIRE_COPIES.map((copy) => keysOf(report(copy)));
    let most = 0;
    for (const copy of wire) {
      for (const other of UNRELATED_REPORTS) {
        most = Math.max(most, overlap(copy, keysOf(report(other))));
      }
    }
    // Half of the larger set is what two Stories need to be one Cluster.
    expect(most).toBeLessThan(0.5);
    // And in fact these share nothing at all, which is the claim with room to
    // spare rather than the bare minimum.
    expect(most).toBeLessThan(0.25);
  });

  it('stays fast enough to run over a whole feed cycle', () => {
    // One cycle reads every entry of every feed, and a hundred articles is a busy
    // hour. This costs about 0.1ms an article on the machine it was measured on,
    // so the bound leaves more than an order of magnitude for a slower one: what
    // it fails on is an accidental quadratic, not a slow box.
    const articles = Array.from(
      { length: 100 },
      (_, i) => report(WIRE_COPIES[i % WIRE_COPIES.length]!),
    );
    const started = performance.now();
    for (const article of articles) extractEntities(article);
    expect(performance.now() - started).toBeLessThan(250);
  });
});

describe('canonicalEntityKey', () => {
  it('is the same for every way two outlets write one name', () => {
    const spellings = [
      'Acme Corp',
      'acme corp',
      'ACME CORP',
      'Acme Corporation',
      'Acme Corp.',
      "Acme Corp's",
    ];
    expect([...new Set(spellings.map(canonicalEntityKey))]).toEqual(['acme']);
  });

  it('folds the connective inside a name, however the outlet spelled it', () => {
    // "Institute for Cancer Research" and "Institute of Cancer Research" are one
    // name, and so is a company whose legal form is written with stops in it.
    expect(canonicalEntityKey('Institute for Cancer Research')).toBe(
      canonicalEntityKey('Institute of Cancer Research'),
    );
    expect(canonicalEntityKey('Orange S.A.')).toBe('orange');
  });

  it('keeps names that are genuinely different apart', () => {
    expect(canonicalEntityKey('Acme Corp')).not.toBe(
      canonicalEntityKey('Acme Foods'),
    );
    expect(canonicalEntityKey('Riverton')).not.toBe(
      canonicalEntityKey('Riverton Plant'),
    );
  });

  it('folds away the legal form, which is the same name written longer', () => {
    // The other direction: two names that look different and are one thing.
    expect(canonicalEntityKey('Riverton')).toBe(
      canonicalEntityKey('Riverton Group'),
    );
  });

  it('never empties a name that has no identity left to drop', () => {
    expect(canonicalEntityKey('Ltd')).toBe('ltd');
  });
});

describe('classifyEntity', () => {
  const kindOf = (sentence: string, name: string): string | undefined =>
    extractEntities(sentence).find((e) => e.name === name)?.kind;

  it('knows a person from the role or the name in front of them', () => {
    expect(
      kindOf('Its governor, Elsa Marquardt, said inflation eased.', 'Elsa Marquardt'),
    ).toBe('person');
    expect(
      kindOf('Acme Corp named Priya Sandhu as chief executive.', 'Priya Sandhu'),
    ).toBe('person');
  });

  it('knows an organization from the word that names one', () => {
    expect(kindOf('Acme Corp launched Foo.', 'Acme Corp')).toBe('org');
    expect(kindOf('BrandX Inc completed the acquisition of TinyCo.', 'BrandX Inc')).toBe(
      'org',
    );
    // The phrase carries the word and the name does not: nothing in "Belvern"
    // says organization.
    expect(kindOf('BrandX Inc completed the acquisition of TinyCo.', 'TinyCo')).toBe(
      'org',
    );
  });

  it('does not call a country an organization because a ministry sits in front of it', () => {
    // The institution is not the name, and the name after an institution is the
    // place it acts for.
    expect(kindOf('The finance ministry of Germany spoke on Tuesday.', 'Germany')).toBe(
      'place',
    );
    expect(kindOf('The central bank of Japan held its rate.', 'Japan')).toBe('place');
    expect(kindOf('The central bank of Belvern held its rate.', 'Belvern')).toBe(
      'place',
    );
  });

  it('does not swallow a name that begins with a word that also names a rank', () => {
    // "General" in front of a person is a rank; at the head of a name it is the
    // first half of it.
    expect(
      names('General Motors said the car sold well. Shares in General Motors rose.'),
    ).toEqual(['General Motors']);
  });

  it('knows a place from the word that puts it somewhere', () => {
    expect(kindOf('Shares rose in Frankfurt after the bell.', 'Frankfurt')).toBe(
      'place',
    );
    expect(kindOf('Her first match is away to Dunvale.', 'Dunvale')).toBe('place');
  });

  it('knows a product from what it is announced as', () => {
    expect(kindOf('Acme Corp launched Foo on Tuesday.', 'Foo')).toBe('product');
    expect(kindOf('Acme Corp put Foo on sale in the autumn.', 'Foo')).toBe(
      'product',
    );
    expect(
      kindOf(
        'Acme Corp says Foo, an assistant for enterprise customers, arrives on Tuesday.',
        'Foo',
      ),
    ).toBe('product');
  });

  it('calls anything it cannot place a concept, rather than guessing', () => {
    expect(
      kindOf('Acme Corp said it would close its Riverton plant in March.', 'Riverton'),
    ).toBe('concept');
  });

  it('classifies a name the same way wherever the name appears', () => {
    // The kind is a fact about the Entity, not about the sentence it was read in,
    // so the same name in two positions is read the same way.
    const inAHeadline = kindOf(
      'Acme Corp says Foo, an assistant for enterprise customers, arrives on Tuesday.',
      'Acme Corp',
    );
    const inAReport = kindOf('Analysts said Acme Corp launched Foo.', 'Acme Corp');
    expect(inAHeadline).toBe('org');
    expect(inAReport).toBe(inAHeadline);
  });

  it('reaches every kind the vocabulary names, across the fixtures', () => {
    const reports = [
      ...WIRE_COPIES,
      ...UNRELATED_REPORTS,
      ...SAME_COMPANY_REPORTS,
    ];
    const kinds = new Set(
      reports.flatMap((r) => extractEntities(report(r)).map((e) => e.kind)),
    );
    expect(kinds).toEqual(
      new Set(['person', 'org', 'place', 'product', 'concept']),
    );
  });
});
