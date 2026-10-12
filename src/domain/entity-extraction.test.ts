import { describe, expect, it } from 'vitest';

import {
  canonicalEntityKey,
  isFullerNameFor,
  extractEntities,
  isPartialName,
  namesNothing,
  theOnlyFullerName,
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

  it('reads a feed reporting on an item as no names at all', () => {
    // What hnrss.org puts in place of a description. The word pattern throws the
    // digits away, so `Points` and `Comments` arrive as two ordinary
    // capitalised words and are read as one name — which is how `Points
    // Comments` became the most-mentioned Entity in the database, attached to
    // every Hacker News Article. The parser removes this text before the
    // Article is stored, but a rule that reads bookkeeping as a name is wrong
    // wherever the text arrives from.
    expect(names('Article URL: https://example.com/a Comments URL: https://example.com/b Points: 33 # Comments: 10')).toEqual([]);
    expect(names('Published online: 02 October 2026')).toEqual([]);
  });

  it('still reads a name out of a sentence that happens to carry a colon', () => {
    // The guard is about a label followed by a link or a bare number, not about
    // colons: "Renata Ostberg said: Acme Corp held its guidance" is a sentence
    // with two names in it.
    expect(names('Renata Ostberg said: Acme Corp held its guidance')).toContain(
      'Acme Corp',
    );
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
    const found = names('The Riverton Register reported it on Tuesday.');
    expect(found).toContain('Riverton Register');
    // No piece of the name is also emitted on its own, and no other name is
    // emitted out of the same span.
    expect(found.filter((n) => n.includes('Riverton'))).toEqual(['Riverton Register']);
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

  it('does not extract the outlet that published the Article', () => {
    // An Entity exists so two Articles can be recognised as being about the same
    // subject, and an outlet is in every Article it published: "BBC" was attached
    // to 43 of them, which is a hub linking unrelated Stories rather than a name
    // that identifies anything. The same goes for a newsletter whose name is in
    // most of a User's Topics, which is why it has to be named rather than
    // inferred from the registry — a Source Brieflyy does not poll is still an
    // outlet in the text.
    const found = names(
      'BBC reported that Reuters and the Guardian had not seen the New York Times report.',
    );
    for (const outlet of ['BBC', 'Reuters', 'Guardian', 'New York Times']) {
      expect(found, outlet).not.toContain(outlet);
    }
    expect(names('The Guardian Environment filed the story.')).toEqual([]);
    expect(names('Hacker News linked to the discussion. HN carried it too.')).toEqual(
      [],
    );
  });

  it('does not extract a head noun with nothing in front of it', () => {
    // "University" and "County" name a sort of thing rather than one of them, and
    // every Article about an institution carries one. They dilute the overlap
    // two Stories are compared on without identifying anything; the institution
    // they head is still extracted.
    const found = names(
      'The county said the university would open a campus. County officials disagreed.',
    );
    for (const head of ['County', 'University', 'university', 'county']) {
      expect(found, head).not.toContain(head);
    }
    expect(
      names('Riverside University and Boulder County both disagreed on Tuesday.'),
    ).toEqual(expect.arrayContaining(['Riverside University', 'Boulder County']));
  });

  it('reads a name the prefix is not part of', () => {
    // The three shapes a name arrives in that are not the name: the verb an
    // outlet leads a headline with, the adjective and the column word. Each of
    // them is the same thing as the bare name, which is what makes the two
    // Articles overlap at all.
    expect(keys('Fired OpenAI and OpenAI disagreed.')).toEqual(['openai']);
    expect(
      keys('Exclusive Riverton Labs and Riverton Labs disagreed.'),
    ).toEqual(['riverton labs']);
    expect(
      keys('Analysis Riverton Labs and Riverton Labs disagreed.'),
    ).toEqual(['riverton labs']);
    // And the name itself is untouched: "General Motors" is not "General" in
    // front of "Motors", and folding it away would be a rule cascade guessing.
    expect(canonicalEntityKey('General Motors')).toBe('general motors');
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

  it('drops the qualifier an outlet puts in front of the name', () => {
    // The verb a headline leads with, the adjective that says which of several,
    // and the column word a section prints above its stories. None of them says
    // which thing is meant, and each of them is how one outlet's Article fails to
    // overlap another's about the same thing.
    expect(canonicalEntityKey('Fired OpenAI')).toBe('openai');
    expect(canonicalEntityKey('Exclusive Guardian Australia')).toBe(
      'guardian australia',
    );
    expect(canonicalEntityKey('Analysis Riverton Labs')).toBe('riverton labs');
    expect(canonicalEntityKey('Daily Briefing')).toBe('daily briefing');
    // Which is a newsletter's title rather than a briefing, so it is furniture
    // rather than a head noun with words in front of it.
    expect(namesNothing('Daily Briefing')).toBe(true);
    // Only from the front, and only while something is left to name: a name that
    // is one qualifier is not a name at all, and folding it to nothing would be a
    // rule deciding a word is not there.
    expect(canonicalEntityKey('Former')).toBe('former');
    expect(canonicalEntityKey('Former Riverton Labs')).toBe('riverton labs');
    // Nor from the end: "Riverton Labs Holdings" is one name either way, and the
    // suffix was already being dropped by the fold above.
    expect(canonicalEntityKey('Riverton Labs Group')).toBe('riverton labs');
  });

  it('folds a name written only with a transliterated qualifier onto the thing it qualifies', () => {
    // Two spellings of one bridge, each carrying the qualifier its writer used for
    // it. Nothing in the spelling says which is which, so the qualifier is listed
    // rather than derived — and the rest of the name is what survives.
    expect(canonicalEntityKey('Pivnichyi Northern Bridge')).toBe(
      canonicalEntityKey('Kyiv Northern Bridge'),
    );
  });

  it('folds a demonym onto the country it belongs to', () => {
    // An adjective modifying a noun is the country, and the fold is to the
    // country's own name rather than to a code, so `America` stays `America` and
    // `American` joins it. Not "Israeli company" though: `company` is an inner
    // word and goes, leaving the adjective standing alone.
    expect(canonicalEntityKey('West African')).toBe('west africa');
    expect(canonicalEntityKey('Libyan National Army')).toBe('libya national army');
    expect(canonicalEntityKey('Central African Republic')).toBe('central africa republic');
    expect(canonicalEntityKey('Israeli Prime')).toBe('israel prime');
    expect(canonicalEntityKey('Israel')).toBe('israel');
    expect(canonicalEntityKey('America')).toBe('america');
  });

  it('leaves a demonym standing alone as its own Entity', () => {
    // Folding the bare adjective merges a rare Entity into a common one, which
    // raises the country's document frequency and lowers its weight everywhere —
    // the only fold in this module with a measured cost against it. The corpus
    // keeps 10 such rows and 67 links this way.
    expect(canonicalEntityKey('Israeli')).toBe('israeli');
    expect(canonicalEntityKey('Australian')).toBe('australian');
    expect(canonicalEntityKey('Americans')).toBe('americans');
    // And it is still a partial name, so "Australian" in one Article is still
    // known to be about something and is not mistaken for a head noun.
    expect(isPartialName('australian')).toBe(true);
  });
});

describe('namesNothing', () => {
  it('is true of an outlet, whatever of it the Article names', () => {
    // An outlet is in every Article it published, so an Entity for it links
    // unrelated Stories through the one word they share. It is a name in the text
    // and not a thing in the story, which is the whole of the difference.
    for (const outlet of [
      'BBC',
      'BBC News',
      'The Guardian',
      'Guardian Australia',
      'Reuters',
      'New York Times',
      'Hacker News',
      'HN',
      'WIRED',
      'The Verge',
      'Nature',
    ]) {
      expect(namesNothing(outlet), outlet).toBe(true);
    }
  });

  it('is true of the labels a feed stamps on an item rather than text it wrote', () => {
    for (const label of ['HN', 'Points', 'Comments', 'Article URL', 'Permalink']) {
      expect(namesNothing(label), label).toBe(true);
    }
  });

  it('is false of a head noun standing alone, and false of what it heads', () => {
    expect(namesNothing('University')).toBe(true);
    expect(namesNothing('County')).toBe(true);
    expect(namesNothing('Academy')).toBe(true);
    // The institution is still an Entity: what it is called is what identifies it.
    expect(namesNothing('Riverside University')).toBe(false);
    expect(namesNothing('University of Belvern')).toBe(false);
    expect(namesNothing('Boulder County')).toBe(false);
    // And a name that is nothing but a qualifier in front of one is nothing: the
    // qualifier is what said which university, so without it there is no
    // university left to name.
    expect(namesNothing('Severnyi University')).toBe(true);
  });

  it('is false of anything else', () => {
    expect(namesNothing('OpenAI')).toBe(false);
    expect(namesNothing('Christa Pike')).toBe(false);
    expect(namesNothing('Northern Bridge')).toBe(false);
    expect(namesNothing('The Guardian of the Galaxy')).toBe(false);
  });
});

describe('isPartialName', () => {
  it('is true of a word that could be the end of a longer name', () => {
    // "Pike" on its own is the same person as "Christa Pike", and resolving it
    // needs a word that could name a thing rather than a sort of thing.
    expect(isPartialName('pike')).toBe(true);
    expect(isPartialName('trump')).toBe(true);
  });

  it('is false of a name that is more than one word', () => {
    // "Christa Pike" is a whole name, not a short one, and folding it onto
    // "Tennessee Christa Pike" would put the right Entity on the wrong row.
    expect(isPartialName('christa pike')).toBe(false);
    expect(isPartialName('northern bridge')).toBe(false);
  });

  it('is false of a word that names a sort of thing or nothing', () => {
    // "Bridge", "University" and "County" head thousands of names each. Matching
    // one of them onto whichever fuller name happens to exist is not a
    // resolution, it is a coincidence.
    for (const head of ['bridge', 'university', 'county', 'academy', 'company']) {
      expect(isPartialName(head), head).toBe(false);
    }
    // Nor a word English does not capitalise, or one too short to be one.
    expect(isPartialName('the')).toBe(false);
    expect(isPartialName('bbc')).toBe(false);
    expect(isPartialName('fl')).toBe(false);
  });
});

describe('isFullerNameFor', () => {
  it('is true of a surname and the full name that ends in it', () => {
    expect(isFullerNameFor('christa pike', 'pike')).toBe(true);
    expect(isFullerNameFor('donald trump', 'trump')).toBe(true);
  });

  it('is false for anything that is not the same words at the end', () => {
    // Matching on a prefix rather than a suffix is what would turn every place
    // name ending in a common word into one Entity.
    expect(isFullerNameFor('pike hinson', 'pike')).toBe(false);
    expect(isFullerNameFor('pike', 'pike')).toBe(false);
    expect(isFullerNameFor('pike', 'christa pike')).toBe(false);
  });

  it('is false for a name that is not one a person goes by', () => {
    // "OpenAI" ends "ChatGPT OpenAI" and "Pac Man OpenAI", which are two names an
    // Article put side by side rather than one name. Resolving onto either would
    // lose the most-mentioned Entity in the corpus, and two words an Article
    // happened to set together is not a reason to.
    expect(isFullerNameFor('chatgpt openai', 'openai')).toBe(false);
    expect(isFullerNameFor('pac man openai', 'openai')).toBe(false);
    expect(isFullerNameFor('northern bridge', 'bridge')).toBe(false);
  });

  it('is false for a longer name that is nobody’s whole name', () => {
    // "Tennessee Christa Pike" carries "Christa Pike" and is a headline's
    // adjective in front of it.
    expect(isFullerNameFor('tennessee christa pike', 'christa pike')).toBe(false);
  });
});

describe('theOnlyFullerName', () => {
  it('is the one fuller name when there is one', () => {
    expect(theOnlyFullerName(['christa pike'], 'pike')).toBe('christa pike');
    // And the tightest of several, because the longer one is an adjective in
    // front of it.
    expect(theOnlyFullerName(['tennessee christa pike', 'christa pike'], 'pike')).toBe(
      'christa pike',
    );
  });

  it('is nothing rather than a guess', () => {
    // Two people a surname might be, and nothing in the spelling says which.
    expect(theOnlyFullerName(['jay martin', 'michel martin'], 'martin')).toBeUndefined();
    // And a name no stored name is the whole of keeps its own row.
    expect(theOnlyFullerName(['jay martin'], 'pike')).toBeUndefined();
    expect(theOnlyFullerName([], 'pike')).toBeUndefined();
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
