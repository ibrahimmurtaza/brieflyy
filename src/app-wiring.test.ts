import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFERRED_SERVICES } from './app-wiring.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...listSourceFiles(full));
    } else if (entry.endsWith('.ts') && !entry.endsWith('.test.ts')) {
      out.push(full);
    }
  }
  return out;
}

const SOURCES = listSourceFiles(SRC).map((file) => ({
  file,
  text: readFileSync(file, 'utf8'),
}));

/** Every exported class whose name ends in `Service`. */
function serviceClassNames(): Map<string, string> {
  const found = new Map<string, string>();
  for (const { file, text } of SOURCES) {
    for (const m of text.matchAll(
      /^export\s+class\s+(\w*Service)\b/gm,
    )) {
      const name = m[1];
      if (name) found.set(name, file);
    }
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

const APP_CLOSURE = importClosure(join(SRC, 'app.ts'));
const APP_SOURCE = [...APP_CLOSURE]
  .map((file) => SOURCES.find((s) => s.file === file)?.text ?? '')
  .join('\n');

function isConstructed(className: string): boolean {
  return new RegExp(`new\\s+${className}\\s*[(\\<]`).test(APP_SOURCE);
}

describe('service reachability', () => {
  const services = serviceClassNames();

  it('finds the service classes in the codebase', () => {
    expect(services.size).toBeGreaterThan(0);
    expect([...services.keys()]).toContain('ClusterFormationService');
  });

  it('constructs every service class, or defers it to a named ticket', () => {
    const unwired = [...services]
      .filter(([name]) => !isConstructed(name))
      .map(([name]) => name)
      .filter((name) => !(name in DEFERRED_SERVICES))
      .sort();

    expect(unwired).toEqual([]);
  });

  it('defers only services that are genuinely not yet constructed', () => {
    const stale = Object.keys(DEFERRED_SERVICES)
      .filter((name) => !services.has(name) || isConstructed(name))
      .sort();

    expect(stale).toEqual([]);
  });

  it('gives every deferral a ticket reference', () => {
    for (const [name, ticket] of Object.entries(DEFERRED_SERVICES)) {
      expect(ticket, `${name} is deferred without a ticket`).toMatch(/^#\d+$/);
    }
  });
});
