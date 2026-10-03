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
 * The English words for the numbers a document quotes.
 *
 * Spelled out rather than written as digits because a count written as a digit is
 * one a reader skims past and nobody edits, and this file can only check a claim
 * it can read unambiguously. Composed from tens rather than listed out, so a
 * suite that grows past twenty does not need this table extended by hand — and
 * past ninety-nine the failure says so, which is the signal to write that
 * particular count as a digit instead.
 */
const TENS = [
  '',
  'ten',
  'twenty',
  'thirty',
  'forty',
  'fifty',
  'sixty',
  'seventy',
  'eighty',
  'ninety',
] as const;

const UNITS = [
  '',
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
] as const;

function wordFor(count: number): string {
  if (!Number.isInteger(count) || count < 0 || count > 99) {
    throw new Error(`${count} cannot be spelled out by this file; write it as a digit`);
  }
  if (count < 10) return UNITS[count] ?? '';
  if (count % 10 === 0) return TENS[Math.floor(count / 10)] ?? '';
  const tens = TENS[Math.floor(count / 10)];
  const unit = UNITS[count % 10];
  return tens === '' || unit === '' ? '' : `${tens}-${unit}`;
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

const PACKAGE_JSON = JSON.parse(read('package.json')) as {
  scripts: Record<string, string>;
};

describe('the README commands block', () => {
  /** The script name on every `pnpm …` line of the block, comments and all. */
  function documented(): string[] {
    return fence(section(read('README.md'), 'Commands'))
      .split('\n')
      .filter((line) => /^\s*pnpm\s+[a-z]/.test(line))
      .map((line) => /^\s*pnpm\s+([a-z][\w:-]*)/.exec(line)?.[1] ?? '');
  }

  it('documents every script in package.json', () => {
    const names = documented();
    const undocumented = Object.keys(PACKAGE_JSON.scripts)
      .filter((name) => !names.includes(name))
      .sort();
    expect(
      undocumented,
      'add each to the Commands block, or delete it from package.json',
    ).toEqual([]);
  });

  it('documents no command that is not a script', () => {
    // `pnpm install` is the one command that is not a script, because it is the one
    // a person runs before the scripts exist.
    const invented = documented()
      .filter((name) => name !== 'install' && !(name in PACKAGE_JSON.scripts))
      .sort();
    expect(invented, 'every documented command must exist in package.json').toEqual([]);
  });

  it('says what each command does rather than listing a bare name', () => {
    const silent = fence(section(read('README.md'), 'Commands'))
      .split('\n')
      .filter((line) => /^\s*pnpm\s+[a-z]/.test(line))
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
    // The two dashes and the slash are what identify a directory line, at whatever
    // depth it is drawn, so the tree is free to nest.
    const named = [...fence(section(read('README.md'), 'Architecture')).matchAll(
      /── ([a-z][a-z-]*)\//g,
    )].map((match) => match[1] ?? '');
    const missing = directoriesUnder(join(ROOT, 'src'))
      .filter((dir) => !named.includes(dir))
      .sort();
    expect(missing, 'a directory a reader would go looking for is not in the tree').toEqual(
      [],
    );
  });

  it('names no directory that does not exist', () => {
    const named = [...fence(section(read('README.md'), 'Architecture')).matchAll(
      /── ([a-z][a-z-]*)\//g,
    )].map((match) => match[1] ?? '');
    const phantom = named
      .filter((dir) => !directoriesUnder(join(ROOT, 'src')).includes(dir))
      .sort();
    expect(phantom, 'the tree describes a module that is not there').toEqual([]);
  });

  it('names each of the five layers this system is made of', () => {
    // The brief and feedback layers live in `services/` rather than in directories
    // of their own, so the tree cannot name them and the prose has to.
    const architecture = section(read('README.md'), 'Architecture');
    for (const layer of ['brief', 'feedback', 'trends', 'discover', 'archive']) {
      expect(
        new RegExp(`\\b${layer}\\b`, 'i').test(architecture),
        `the Architecture section says nothing about the ${layer} layer`,
      ).toBe(true);
    }
  });

  it('says what reaches the modules the application never imports', () => {
    // `src/verify/` is reached by `pnpm secrets:check`, `src/ingest/check-feeds.ts`
    // by `pnpm ingest:check-feeds`, `src/testing/` by the suites and
    // `src/app-wiring.ts` by its own test. A tree entry with no way of saying so
    // reads as dead code, and the next person deletes it.
    const architecture = section(read('README.md'), 'Architecture');
    for (const reached of [
      'pnpm secrets:check',
      'pnpm ingest:check-feeds',
      'src/testing/',
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
    expect(testsSection()).toContain(`${wordFor(count)} test files`);
  });

  it('quotes the number of browser specs the suite holds', () => {
    const count = filesUnder(join(ROOT, 'tests'), (name) => name.endsWith('.spec.ts')).length;
    expect(testsSection()).toContain(`${wordFor(count)} spec files`);
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

  it('numbers them without a gap', () => {
    const numbers = present
      .map(Number)
      .filter((n) => Number.isInteger(n))
      .sort((a, b) => a - b);
    expect(numbers[0]).toBe(1);
    expect(numbers, 'an ADR number was skipped').toEqual(
      numbers.map((_unused, index) => index + 1),
    );
  });

  it('gives every ADR a file with a body', () => {
    const thin = readdirSync(join(ROOT, 'docs', 'adr')).filter(
      (file) => read(`docs/adr/${file}`).trim().length === 0,
    );
    expect(thin).toEqual([]);
  });
});