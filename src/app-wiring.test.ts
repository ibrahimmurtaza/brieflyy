import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  DEFERRED_SERVICES,
  REACHED_BY_SUITES,
  deferralsWithoutATicket,
  staleDeferrals,
  suiteEntriesWithNoReachingModule,
} from './app-wiring.js';

/**
 * What this file holds the build over, in the words the Tests section's bullet
 * uses. `docs-agreement.test.ts` holds the bullet to this sentence, so it cannot
 * be an index marker that names nothing.
 */
export const GUARD =
  'every class the application is built from is constructed by it, or is named';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));

/** Every module under `src/`, at any depth. `withTests` keeps the suites. */
function listSourceFiles(dir: string, withTests = false): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full, withTests));
    } else if (entry.endsWith('.ts') && (withTests || !entry.endsWith('.test.ts'))) {
      out.push(full);
    }
  }
  return out;
}

const FILES = listSourceFiles(SRC);
const SOURCES = FILES.map((file) => ({ file, text: readFileSync(file, 'utf8') }));

/**
 * Every exported class in `files`, mapped to the file that declares it.
 *
 * Read out of the syntax tree rather than out of a regular expression. A pattern
 * bound to one declaration shape — `export class Name` at the start of a line —
 * cannot see `export default class`, `export abstract class`, `export declare
 * class`, an `export` on its own line, or a class nested in a `declare module`.
 * A service it cannot see is a service it will never report, which is the same
 * failure as having no guard at all.
 *
 * Every exported class rather than every `*Service`: the suffix is a naming
 * convention, and a convention is not a boundary. A class called
 * `IngestScheduler` is as much an unwired service as `BriefPlanService`, and a
 * guard that only asks about the second kind cannot fail on the first.
 */
function exportedClasses(
  files: readonly { file: string; text: string }[],
): Map<string, string> {
  const found = new Map<string, string>();
  for (const { file, text } of files) {
    const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const visit = (node: ts.Node): void => {
      if (ts.isClassDeclaration(node) && node.name !== undefined) {
        const modifiers = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined;
        const exported = modifiers?.some(
          (modifier) =>
            modifier.kind === ts.SyntaxKind.ExportKeyword ||
            modifier.kind === ts.SyntaxKind.DefaultKeyword,
        );
        if (exported === true && !found.has(node.name.text)) {
          found.set(node.name.text, file);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  return found;
}

/** Every module reachable from `entry` by following relative imports. */
function importClosure(entry: string): Set<string> {
  const byPath = new Map(SOURCES.map((s) => [s.file, s.text]));
  const seen = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    const text = byPath.get(file);
    if (text === undefined) continue;
    seen.add(file);
    for (const m of text.matchAll(/from\s+'(\.[^']*)'/g)) {
      const spec = m[1];
      if (!spec) continue;
      const target = resolve(dirname(file), spec.replace(/\.js$/, '.ts'));
      queue.push(target);
    }
  }
  return seen;
}

/**
 * Every module the application is built from.
 *
 * Two entries, because composition happens in two steps: the entrypoint
 * resolves configuration and builds the seams, and the factory wires the
 * services that hold them. A seam the entrypoint builds and hands over — the
 * email transport, the summary client — is constructed by the application, and a
 * guard that could only see the factory would report a wired service as unwired
 * and ask for a service to be deferred after it had been built.
 */
const APP_CLOSURE = new Set([
  ...importClosure(join(SRC, 'server.ts')),
  ...importClosure(join(SRC, 'app.ts')),
]);
const APP_SOURCE = [...APP_CLOSURE]
  .map((file) => SOURCES.find((s) => s.file === file)?.text ?? '')
  .join('\n');

/** Whether `sources` holds a `new ClassName(`. */
function constructsSomewhere(sources: readonly { text: string }[], className: string): boolean {
  return sources.some(({ text }) =>
    new RegExp(`new\\s+${className}\\s*[(\\<]`).test(text),
  );
}

/** Whether the application closure holds a `new ClassName(`. */
const isConstructed = (className: string): boolean =>
  constructsSomewhere([{ text: APP_SOURCE }], className);

/** Whether `path`, named relative to `src/`, is a module on disk, suite or not. */
const moduleExists = (relativePath: string): boolean =>
  listSourceFiles(SRC, true).some(
    (file) => relative(SRC, file).split('\\').join('/') === relativePath,
  );

/**
 * Every `.ts` file under `src/` outside the application closure, the suites
 * included.
 *
 * Where a test double is constructed: a suite, or a helper the suites reach. The
 * closure is subtracted rather than the application source simply being ignored,
 * because the two answers differ — a double the application constructs is
 * application code in the wrong list, and only the subtraction can say so. The
 * guard's own two files are excluded because they are what reads this.
 */
const OUTSIDE_THE_CLOSURE = listSourceFiles(SRC, true)
  .filter((file) => !APP_CLOSURE.has(file))
  .filter((file) => !file.endsWith('app-wiring.ts'))
  .map((file) => ({ file, text: readFileSync(file, 'utf8') }));

/**
 * The classes the application is built from that nothing constructs and that
 * neither list accounts for.
 *
 * `accountedFor` is passed in rather than read from the module, so the rule can be
 * run against a codebase with no lists at all.
 */
function unwiredClasses(
  classes: ReadonlyMap<string, string>,
  closure: ReadonlySet<string>,
  appSource: string,
  accountedFor: ReadonlySet<string>,
): string[] {
  return [...classes]
    .filter(([, file]) => closure.has(file))
    .filter(([name]) => !constructsSomewhere([{ text: appSource }], name))
    .map(([name]) => name)
    .filter((name) => !accountedFor.has(name))
    .sort();
}

/** Exported classes the application closure does not contain and nothing names. */
function unnamedOutsideTheClosure(
  classes: ReadonlyMap<string, string>,
  closure: ReadonlySet<string>,
  accountedFor: ReadonlySet<string>,
): string[] {
  return [...classes]
    .filter(([, file]) => !closure.has(file))
    .map(([name]) => name)
    .filter((name) => !accountedFor.has(name))
    .sort();
}

/** Suite-only classes that nothing in `sources` constructs. */
function unreachableOutsideTheClosure(
  entries: Readonly<Record<string, string>>,
  sources: readonly { text: string }[],
): string[] {
  return Object.keys(entries)
    .filter((name) => !constructsSomewhere(sources, name))
    .sort();
}

describe('the class scanner', () => {
  it('finds the service classes in the codebase', () => {
    const classes = exportedClasses(SOURCES);
    expect(classes.size).toBeGreaterThan(0);
    expect([...classes.keys()]).toContain('ClusterFormationService');
  });

  it('sees an exported class however it is declared', () => {
    // Each of these is a declaration the shape-bound pattern the scanner
    // replaced could not match, so each one is a class that used to be invisible
    // to the guard. The scanner is checked against them rather than assumed.
    const shapes = [
      'export class PlainService {}',
      'export default class DefaultService {}',
      'export abstract class AbstractService {}',
      'export declare class DeclaredService {}',
      'export\nclass OnItsOwnLineService {}',
      'export class GenericService<T> {}',
      'declare module "shapes" { export class NestedService {} }',
    ];
    const classes = exportedClasses([{ file: 'shapes.ts', text: shapes.join('\n') }]);

    expect([...classes.keys()].sort()).toEqual([
      'AbstractService',
      'DeclaredService',
      'DefaultService',
      'GenericService',
      'NestedService',
      'OnItsOwnLineService',
      'PlainService',
    ]);
  });

  it('sees a class whose name is not the `*Service` convention', () => {
    // The suffix is a convention rather than a boundary, and a guard bound to it
    // cannot fail on a service named anything else.
    const classes = exportedClasses([
      { file: 'other.ts', text: 'export class IngestScheduler {}\nexport class IntervalLoop {}' },
    ]);
    expect([...classes.keys()].sort()).toEqual(['IngestScheduler', 'IntervalLoop']);
  });

  it('reports a class nothing constructs, in a shape the codebase never uses', () => {
    // The load-bearing check. Run against the repository, the guard is evidence
    // only while the repository happens to be clean; run against a codebase with
    // one unwired service in it, it is evidence that it reports. Both halves call
    // `unwiredClasses`, so this is the guard's own rule rather than a restatement
    // of it — a second copy of the rule would be a second thing to be wrong.
    const classes = exportedClasses([
      { file: 'service.ts', text: 'export abstract class OpaqueService {}' },
      { file: 'other.ts', text: 'export class WiredService {}' },
    ]);

    expect(
      unwiredClasses(
        classes,
        new Set(['service.ts', 'other.ts']),
        'new WiredService();',
        new Set(),
      ),
    ).toEqual(['OpaqueService']);
  });

  it('reports a class outside the application closure only when nothing names it', () => {
    // A class nobody imports is correctly not unwired — `src/verify/` and
    // `src/testing/` are reached by a command and by the suites — but it must be
    // named rather than skipped by path, or the guard has a hole shaped like a
    // directory prefix.
    const classes = exportedClasses([
      { file: 'service.ts', text: 'export class WiredService {}' },
      { file: 'testing/double.ts', text: 'export class SuiteOnlyService {}' },
    ]);
    const closure = new Set(['service.ts']);

    expect(
      unwiredClasses(classes, closure, 'new WiredService();', new Set()),
    ).toEqual([]);
    expect(unnamedOutsideTheClosure(classes, closure, new Set())).toEqual([
      'SuiteOnlyService',
    ]);
    expect(
      unnamedOutsideTheClosure(classes, closure, new Set(['SuiteOnlyService'])),
    ).toEqual([]);
  });
});

describe('service reachability', () => {
  const classes = exportedClasses(SOURCES);
  const accountedFor = new Set([
    ...Object.keys(DEFERRED_SERVICES),
    ...Object.keys(REACHED_BY_SUITES),
  ]);

  it('constructs every class in the application closure, or has it accounted for', () => {
    expect(
      unwiredClasses(classes, APP_CLOSURE, APP_SOURCE, accountedFor),
      'a class in the application closure that nothing constructs: wire it, or name it in src/app-wiring.ts',
    ).toEqual([]);
  });

  it('classifies every exported class, so one the guard has never heard of is not invisible', () => {
    expect(
      unnamedOutsideTheClosure(
        classes,
        APP_CLOSURE,
        new Set(Object.keys(REACHED_BY_SUITES)),
      ),
      'an exported class outside the application closure has to be named in REACHED_BY_SUITES with the module that reaches it',
    ).toEqual([]);
  });

  it('holds a real deferral to the same rule it holds a synthetic one to', () => {
    // The synthetic cases above show the rule reports; this shows the rule is the
    // one the repository is held to. A deferral is a debt with an owner, so a
    // named class is excused rather than passed: it is reported as unwired by the
    // rule above and excused by the list here.
    const deferred = { ClusterFormationService: '#94' };
    expect(unwiredClasses(classes, APP_CLOSURE, APP_SOURCE, new Set())).not.toContain(
      'ClusterFormationService',
    );
    expect(
      unwiredClasses(classes, APP_CLOSURE, APP_SOURCE, new Set(Object.keys(deferred))),
    ).toEqual([]);
  });

  it('names a ticket for every deferral, and would refuse one that does not', () => {
    expect(deferralsWithoutATicket(DEFERRED_SERVICES)).toEqual([]);
    // An empty list cannot show that the check would reject anything, so the rule
    // is exercised against a wrong entry as well. A check that rejects nothing is
    // not a check.
    expect(deferralsWithoutATicket({ UnwiredService: '#94' })).toEqual([]);
    expect(deferralsWithoutATicket({ UnwiredService: 'later' })).toEqual([
      'UnwiredService',
    ]);
    expect(deferralsWithoutATicket({ UnwiredService: '' })).toEqual([
      'UnwiredService',
    ]);
  });

  it('defers only classes that exist and are genuinely not yet constructed', () => {
    const declared = new Set(classes.keys());
    expect(staleDeferrals(DEFERRED_SERVICES, declared, isConstructed)).toEqual([]);
    // Both ways of being stale, exercised: a class that is not in the codebase at
    // all, and one the application has since started constructing.
    expect(
      staleDeferrals({ NeverExistedService: '#94' }, declared, isConstructed),
    ).toEqual(['NeverExistedService']);
    expect(
      staleDeferrals({ ClusterFormationService: '#94' }, declared, isConstructed),
    ).toEqual(['ClusterFormationService']);
  });

  it('gives every suite-only class a module that reaches it, and would refuse one that does not', () => {
    expect(suiteEntriesWithNoReachingModule(REACHED_BY_SUITES, moduleExists)).toEqual([]);
    expect(
      suiteEntriesWithNoReachingModule(
        { UnusedDouble: 'testing/there-is-no-such-file.ts' },
        moduleExists,
      ),
    ).toEqual(['UnusedDouble']);
    expect(suiteEntriesWithNoReachingModule({ UnusedDouble: '' }, moduleExists)).toEqual([
      'UnusedDouble',
    ]);
  });

  it('reaches every suite-only class from outside the application closure', () => {
    // The entry says how the class is reached; this asks whether that is true
    // rather than whether the entry is spelled properly. A double nothing
    // constructs is a fixture the suites stopped using, and a double the
    // application constructs is application code in the wrong list.
    expect(
      unreachableOutsideTheClosure(REACHED_BY_SUITES, OUTSIDE_THE_CLOSURE),
      'a suite-only class nothing outside the closure constructs is dead code, not a double',
    ).toEqual([]);
    expect(
      Object.keys(REACHED_BY_SUITES)
        .filter((name) => isConstructed(name))
        .sort(),
      'a class in REACHED_BY_SUITES that the application constructs belongs in the wiring, not in the suite list',
    ).toEqual([]);
  });

  it('reports a suite-only class nothing constructs, and would not report one that is used', () => {
    // The rule above, against both answers, so the empty list cannot be the only
    // evidence that it reports.
    const source = (text: string): { file: string; text: string }[] => [
      { file: 'suite.ts', text },
    ];
    expect(
      unreachableOutsideTheClosure({ GhostDouble: 'suite.ts' }, source('')),
    ).toEqual(['GhostDouble']);
    expect(
      unreachableOutsideTheClosure(
        { LiveDouble: 'suite.ts' },
        source('new LiveDouble();'),
      ),
    ).toEqual([]);
  });
});