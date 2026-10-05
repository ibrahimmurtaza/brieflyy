import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/**
 * The documentation is part of the build.
 *
 * Four other tests here fail when the shape of the system drifts from what the
 * code says about itself: `app-wiring` for the services, `route-guard` for the
 * routes, `env-example` for the configuration, `schema-agreement` for the two
 * schemas. This is the same argument about the documents a reader is more likely
 * to believe than the code, and against the same failure: a README that lists a
 * command which no longer exists, an architecture tree missing a directory, a
 * status table still showing three of fourteen tickets done when all fourteen are
 * closed, a count written when the suite was half the size it is now.
 *
 * Only the claims that can be decided from the repository are checked. A sentence
 * about what a page does is the author's to keep true. A file path, a script
 * name, a count and an ADR number are all things this file can go and look at,
 * and every one of them has a way of being right on the day it was written and
 * wrong a month later.
 *
 * Nothing here runs a command or opens a network. `pnpm db:push` would answer
 * several of these questions and drop the Archive's index on the way out, which is
 * why what each command does lives in the README as prose instead.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Read a repository file, without the carriage returns a Windows checkout adds. */
function read(relativePath: string): string {
  return readFileSync(join(ROOT, relativePath), 'utf8').replace(/\r\n/g, '\n');
}

/**
 * One `## ` section of a document, up to the next one.
 *
 * Every caller is inside an `it`, so a heading that has been renamed fails one
 * assertion with the name of the section it wanted rather than taking the file
 * down before any of the claims in it have been checked.
 */
function section(markdown: string, heading: string): string {
  const start = markdown.indexOf(`\n## ${heading}\n`);
  if (start === -1) throw new Error(`README.md has no "## ${heading}" section`);
  const rest = markdown.slice(start + 1);
  const end = rest.indexOf('\n## ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** The first fenced block in a section, which is the one the reader reads. */
function fence(markdown: string): string {
  const match = /```[a-z]*\n([\s\S]*?)```/.exec(markdown);
  if (match === null) throw new Error('the section has no fenced block in it');
  return match[1] ?? '';
}

/**
 * One `### ` subsection of a `## ` section.
 *
 * Split out because "does the Architecture section mention trends" is answered by
 * the word `trends/` in the tree, which says nothing about whether the section
 * still describes the trends layer.
 */
function subsection(sectionBody: string, heading: string): string {
  const start = sectionBody.indexOf(`\n### ${heading}\n`);
  if (start === -1) throw new Error(`the section has no "### ${heading}" subsection`);
  const rest = sectionBody.slice(start + 1);
  const end = rest.indexOf('\n### ');
  return end === -1 ? rest : rest.slice(0, end);
}

/** Every file under `dir` whose name satisfies `keep`, depth first. */
function filesUnder(dir: string, keep: (name: string) => boolean): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) found.push(...filesUnder(full, keep));
    else if (keep(entry)) found.push(full);
  }
  return found;
}

/** Every directory under `dir` at any depth, by its path relative to `dir`. */
function directoriesUnder(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    if (!statSync(join(dir, entry)).isDirectory()) continue;
    found.push(entry);
    for (const nested of directoriesUnder(join(dir, entry))) {
      found.push(`${entry}/${nested}`);
    }
  }
  return found;
}

/**
 * The English words for the small numbers a sentence spells out.
 *
 * A file count reads as digits ("86 test files"), and a count of things in a
 * clause reads as a word ("the five routes the specs lean on"), so both forms have
 * to be matchable. Only the small ones: a word list past ten would be a table
 * nobody consults and a number past twelve is a sentence better off with a digit.
 */
const SMALL_NUMBER_WORDS = [
  'zero',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
] as const;

function wordFor(count: number): string {
  const word = SMALL_NUMBER_WORDS[count];
  if (word === undefined) {
    throw new Error(`${count} is past what this file can spell; write it as a digit`);
  }
  return word;
}

/**
 * A document with its line wrapping collapsed.
 *
 * Prose assertions read against this rather than the raw text, so that rewrapping
 * a paragraph — which every editor does and no reader notices — cannot fail a
 * check about what the paragraph says.
 */
function flat(markdown: string): string {
  return markdown.replace(/\s+/g, ' ');
}

/** The Tests section, as prose. */
function testsSection(): string {
  return flat(section(read('README.md'), 'Tests'));
}

/**
 * The vertical slices the application is made of, as the layers subsection labels
 * them.
 *
 * Four have a directory of their own and two do not, which is the whole reason the
 * subsection needs prose as well as a tree. Held as the label rather than the lower
 * case word, because a bullet that mentions `repos/discover-repo.ts` under some
 * other heading is not the same claim as one labelled **Discover**.
 */
const LAYERS = ['Ingest', 'Brief', 'Feedback', 'Trends', 'Discover', 'Archive'] as const;

const PACKAGE_JSON = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
};

/** Every `pnpm …` line of the Commands block, comments and all. */
function commandLines(): string[] {
  return fence(section(read('README.md'), 'Commands'))
    .split('\n')
    .filter((line) => /^\s*pnpm\s+[a-z]/.test(line));
}

/** The directory names the Architecture section's tree draws, at any depth. */
function architectureTree(): string[] {
  // The two dashes and the slash are what identify a directory line, so the tree is
  // free to nest rather than having to be flat and in one order.
  return [...fence(section(read('README.md'), 'Architecture')).matchAll(
    /── ([a-z][a-z-]*)\//g,
  )].map((match) => match[1] ?? '');
}

describe('the README commands block', () => {
  it('documents every script in package.json', () => {
    const documented = commandLines().map(
      (line) => /^\s*pnpm\s+([a-z][\w:-]*)/.exec(line)?.[1] ?? '',
    );
    const undocumented = Object.keys(PACKAGE_JSON.scripts)
      .filter((name) => !documented.includes(name))
      .sort();
    expect(
      undocumented,
      'add each to the Commands block, or delete it from package.json',
    ).toEqual([]);
  });

  it('documents no command that is not a script', () => {
    // `pnpm install` is the one command that is not a script, because it is the one
    // a person runs before the scripts exist.
    const invented = commandLines()
      .map((line) => /^\s*pnpm\s+([a-z][\w:-]*)/.exec(line)?.[1] ?? '')
      .filter((name) => name !== 'install' && !(name in PACKAGE_JSON.scripts))
      .sort();
    expect(invented, 'every documented command must exist in package.json').toEqual([]);
  });

  it('says what each command does rather than listing a bare name', () => {
    const silent = commandLines()
      .filter((line) => !/#\s*\S/.test(line))
      .map((line) => line.trim());
    expect(
      silent,
      'a command with no comment is a command nobody knows the effect of',
    ).toEqual([]);
  });
});

describe('the README architecture tree', () => {
  it('names every directory that exists under src/', () => {
    const named = architectureTree();
    const missing = directoriesUnder(join(ROOT, 'src'))
      .filter((dir) => !named.includes(dir))
      .sort();
    expect(missing, 'a directory a reader would go looking for is not in the tree').toEqual(
      [],
    );
  });

  it('names no directory that does not exist', () => {
    const onDisk = directoriesUnder(join(ROOT, 'src'));
    const phantom = architectureTree()
      .filter((dir) => !onDisk.includes(dir))
      .sort();
    expect(phantom, 'the tree describes a module that is not there').toEqual([]);
  });

  it('names every layer of the application', () => {
    // Read from the layers subsection rather than the whole Architecture section,
    // because a directory in the tree already says the word and that is not what
    // this is checking.
    const layers = subsection(section(read('README.md'), 'Architecture'), 'The layers');
    for (const layer of LAYERS) {
      expect(
        layers.includes(`**${layer}**`),
        `the layers subsection has no bullet labelled **${layer}**`,
      ).toBe(true);
    }
  });

  it('says what reaches the modules the application never imports', () => {
    // `src/verify/` is reached by `pnpm secrets:check`, `src/ingest/check-feeds.ts`
    // by `pnpm ingest:check-feeds`, `src/testing/` and
    // `src/ingest/test-constants.ts` by the suites and `src/app-wiring.ts` by its
    // own test. A tree entry with no way of saying so reads as dead code, and the
    // next person deletes it.
    const architecture = section(read('README.md'), 'Architecture');
    for (const reached of [
      'pnpm secrets:check',
      'pnpm ingest:check-feeds',
      'src/testing/',
      'src/ingest/test-constants.ts',
      'src/app-wiring.ts',
    ]) {
      expect(
        architecture.includes(reached),
        `the Architecture section does not say what reaches ${reached}`,
      ).toBe(true);
    }
  });
});

describe('the README status table', () => {
  it('has one row for each of the fourteen tickets', () => {
    const rows = section(read('README.md'), 'Status')
      .split('\n')
      .filter((line) => /^\|\s*\d\d\s*\|/.test(line));
    expect(
      rows.map((row) => /^\|\s*(\d\d)\s*\|/.exec(row)?.[1] ?? ''),
      'the table is missing a ticket, or has one twice',
    ).toEqual(
      Array.from({ length: 14 }, (_unused, index) => String(index + 1).padStart(2, '0')),
    );
  });

  it('records every ticket as done', () => {
    // The state itself is the tracker's, not this file's: a row reading otherwise
    // means a ticket was closed and the table was not drawn again.
    const unfinished = section(read('README.md'), 'Status')
      .split('\n')
      .filter((line) => /^\|\s*\d\d\s*\|/.test(line))
      .filter((row) => row.split('|')[3]?.trim() !== 'done')
      .map((row) => row.split('|')[1]?.trim());
    expect(
      unfinished,
      'check the tracker for these tickets before changing this',
    ).toEqual([]);
  });
});

describe('the README counts', () => {
  it('quotes the number of Vitest files the suite holds', () => {
    const count = filesUnder(join(ROOT, 'src'), (name) => name.endsWith('.test.ts')).length;
    // A boolean rather than `toContain`, so a failure names the number it wanted
    // instead of printing the whole section back.
    expect(
      testsSection().includes(`${count} test files`),
      `the Tests section must say "${count} test files"`,
    ).toBe(true);
  });

  it('quotes the number of browser specs the suite holds', () => {
    const count = filesUnder(join(ROOT, 'tests'), (name) => name.endsWith('.spec.ts')).length;
    expect(
      testsSection().includes(`${count} spec files`),
      `the Tests section must say "${count} spec files"`,
    ).toBe(true);
  });

  it('quotes the number of routes the e2e harness registers', () => {
    const harness = read('tests/e2e/harness-routes.ts');
    // Only the registrations. A comment naming a path is not a route.
    const registered = [
      ...harness.matchAll(
        /app\.(?:get|post|put|delete)(?:<[^>]*>)?\(\s*'(\/e2e\/[a-z-]+)'/g,
      ),
    ];
    const word = wordFor(registered.length);
    // Two places state how many there are: the harness's own header and the
    // README's description of it. One without the other leaves a reader with two
    // answers.
    expect(harness).toContain(`The ${word} routes the browser specs lean on`);
    expect(flat(read('README.md'))).toContain(`holds the ${word} routes the specs lean on`);
  });

  it('names every guard test that exists', () => {
    // So the list the Tests section carries cannot fall behind the list of tests
    // that carry it.
    for (const guard of [
      'app-wiring',
      'docs-agreement',
      'env-example',
      'route-guard',
      'schema-agreement',
      'write-guard',
    ]) {
      expect(
        filesUnder(join(ROOT, 'src'), (name) => name === `${guard}.test.ts`),
        `${guard}.test.ts is not under src/`,
      ).toHaveLength(1);
      expect(testsSection(), `the Tests section does not name ${guard}.test.ts`).toContain(
        guard,
      );
    }
  });
});

describe('the ADRs the documents point at', () => {
  const present = readdirSync(join(ROOT, 'docs', 'adr')).map(
    (file) => /^(\d{4})-/.exec(file)?.[1] ?? '',
  );

  it('resolves every ADR referenced from the README or the glossary', () => {
    const referenced = new Set<string>();
    for (const file of ['README.md', 'CONTEXT.md']) {
      for (const match of read(file).matchAll(/ADR-(\d{4})/g)) {
        referenced.add(match[1] ?? '');
      }
    }
    expect(
      [...referenced].filter((n) => !present.includes(n)).sort(),
      'a document points at an ADR that is not in docs/adr/',
    ).toEqual([]);
  });

  it('says in the same document that the ADRs it points at exist', () => {
    // The check above passes vacuously if a document stops naming an ADR at all,
    // which is a quieter version of the same rot: the citation that no longer
    // leads anywhere is not a broken citation anyone notices.
    const cited = read('README.md').match(/ADR-\d{4}/g)?.length ?? 0;
    expect(cited, 'the README cites no ADRs, so nothing checks them').toBeGreaterThan(0);
  });
});