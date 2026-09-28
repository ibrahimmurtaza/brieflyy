import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { createInMemorySqliteDriver } from './client.js';
import { applySchema } from './migrate.js';

const DB_DIR = resolve(dirname(fileURLToPath(import.meta.url)));
const SCHEMA_TS = readFileSync(join(DB_DIR, 'schema.ts'), 'utf8');

interface DeclaredIndex {
  readonly table: string;
  readonly name: string;
  readonly unique: boolean;
}

interface DeclaredForeignKey {
  readonly table: string;
  readonly from: string;
  readonly to: string;
}

const TABLE_NAME_RE = /export const (\w+) = sqliteTable\(\s*\n\s*'(\w+)',/g;

/** Drizzle table variable name -> SQL table name. */
function tableNamesByVariable(): Map<string, string> {
  return new Map(
    [...SCHEMA_TS.matchAll(TABLE_NAME_RE)].map((m) => [m[1] as string, m[2] as string]),
  );
}

function tableNames(): string[] {
  return [...new Set([...SCHEMA_TS.matchAll(TABLE_NAME_RE)].map((m) => m[2] as string))].sort();
}

/** The body of `sqliteTable('name', { ... })`, up to the matching close. */
function tableBlock(name: string): string {
  const start = new RegExp(`sqliteTable\\(\\s*\\n\\s*'${name}',`).exec(SCHEMA_TS)?.index;
  expect(start, `${name} is not declared in schema.ts`).toBeTypeOf('number');
  let depth = 0;
  for (let i = start ?? 0; i < SCHEMA_TS.length; i++) {
    if (SCHEMA_TS[i] === '(') depth++;
    if (SCHEMA_TS[i] === ')') {
      depth--;
      if (depth === 0) return SCHEMA_TS.slice(start, i);
    }
  }
  throw new Error(`unterminated sqliteTable for ${name}`);
}

/** The first `{ ... }` in a block, matched by nesting rather than by position. */
function firstObjectLiteral(block: string): string {
  const open = block.indexOf('{');
  if (open === -1) return '';
  let depth = 0;
  for (let i = open; i < block.length; i++) {
    if (block[i] === '{') depth++;
    if (block[i] === '}') {
      depth--;
      // The table's own columns object, not the index callback that follows it.
      if (depth === 0) return block.slice(open, i + 1);
    }
  }
  throw new Error('unterminated object literal in table block');
}

/** Each column declared in a table's column object, with its SQL column name. */
function columnDeclarations(
  table: string,
): { sqlName: string; body: string }[] {
  const object = firstObjectLiteral(tableBlock(table));
  const starts: { index: number; sqlName: string }[] = [];
  for (const m of object.matchAll(/^\s{4}(\w+):\s*\w+\('([\w]+)'/gm)) {
    starts.push({ index: m.index, sqlName: m[2] ?? '' });
  }
  return starts.map((s, i) => ({
    sqlName: s.sqlName,
    body: object.slice(s.index, starts[i + 1]?.index ?? object.length),
  }));
}

function declaredIndexes(): DeclaredIndex[] {
  const out: DeclaredIndex[] = [];
  for (const table of tableNames()) {
    const block = tableBlock(table);
    for (const i of block.matchAll(/(uniqueIndex|index)\('(\w+)'/g)) {
      out.push({ table, name: i[2] ?? '', unique: i[1] === 'uniqueIndex' });
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

function declaredForeignKeys(): DeclaredForeignKey[] {
  const byVariable = tableNamesByVariable();
  const out: DeclaredForeignKey[] = [];
  for (const table of tableNames()) {
    for (const column of columnDeclarations(table)) {
      const target = /\.references\(\(\)\s*=>\s*(\w+)\.id/.exec(column.body)?.[1];
      if (target) out.push({ table, from: column.sqlName, to: byVariable.get(target) ?? target });
    }
  }
  return out.sort((a, b) =>
    `${a.table}.${a.from}`.localeCompare(`${b.table}.${b.from}`),
  );
}

interface AppliedIndex {
  readonly name: string;
  readonly unique: boolean;
  readonly columns: string;
}

function appliedIndexes(table: string): AppliedIndex[] {
  const driver = createInMemorySqliteDriver();
  applySchema(driver);
  const rows = driver
    .prepare(`SELECT name, "unique" FROM pragma_index_list(?)`)
    .all(table) as { name: string; unique: number }[];
  return rows
    .map((r) => ({
      name: r.name,
      unique: r.unique === 1,
      columns: (
        driver
          .prepare(`SELECT name FROM pragma_index_info(?)`)
          .all(r.name) as { name: string }[]
      )
        .map((c) => c.name)
        .join(','),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

function appliedForeignKeys(
  table: string,
): { from: string; to: string }[] {
  const driver = createInMemorySqliteDriver();
  applySchema(driver);
  const rows = driver
    .prepare(`SELECT "from", "table" AS target FROM pragma_foreign_key_list(?)`)
    .all(table) as { from: string; target: string }[];
  return rows
    .map((r) => ({ from: r.from, to: r.target }))
    .sort((a, b) => a.from.localeCompare(b.from));
}

function appliedColumns(table: string): { name: string; notNull: number; dflt: string | null }[] {
  const driver = createInMemorySqliteDriver();
  applySchema(driver);
  return (
    driver.prepare(`SELECT name, "notnull", dflt_value FROM pragma_table_info(?)`).all(table) as {
      name: string;
      notnull: number;
      dflt_value: string | null;
    }[]
  ).map((r) => ({ name: r.name, notNull: r.notnull, dflt: r.dflt_value }));
}

const TABLES = tableNames();

describe('declared schema and applied DDL agree', () => {
  it('finds every table', () => {
    expect(TABLES.length).toBeGreaterThan(10);
  });

  it('creates every declared index with the declared uniqueness', () => {
    const mismatches: string[] = [];
    for (const declared of declaredIndexes()) {
      const applied = appliedIndexes(declared.table).find(
        (i) => i.name === declared.name,
      );
      if (!applied) {
        mismatches.push(`${declared.name}: declared but not created`);
      } else if (applied.unique !== declared.unique) {
        mismatches.push(
          `${declared.name}: declared ${declared.unique ? 'UNIQUE' : 'non-unique'} but created ${applied.unique ? 'UNIQUE' : 'non-unique'}`,
        );
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('creates no index the schema does not declare', () => {
    const declared = new Set(declaredIndexes().map((i) => i.name));
    const extra: string[] = [];
    for (const table of TABLES) {
      for (const applied of appliedIndexes(table)) {
        const name = applied.name;
        if (name.startsWith('sqlite_autoindex_')) continue;
        if (!declared.has(name)) extra.push(`${table}.${name}`);
      }
    }
    expect(extra.sort()).toEqual([]);
  });

  it('applies every declared foreign key', () => {
    const mismatches: string[] = [];
    for (const fk of declaredForeignKeys()) {
      const applied = appliedForeignKeys(fk.table);
      if (!applied.some((a) => a.from === fk.from && a.to === fk.to)) {
        mismatches.push(`${fk.table}.${fk.from} -> ${fk.to}`);
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('applies every declared column', () => {
    // A column in schema.ts that the DDL does not create reads as `undefined`
    // forever, and nothing else in the suite would notice.
    const missing: string[] = [];
    for (const table of TABLES) {
      const declared = columnDeclarations(table);
      // If the parse stopped matching anything the loop below would pass
      // vacuously, so a table that yielded no columns is itself the failure.
      expect(declared.length, `${table} has no declared columns`).toBeGreaterThan(0);
      const applied = new Set(appliedColumns(table).map((c) => c.name));
      for (const column of declared) {
        if (!applied.has(column.sqlName)) missing.push(`${table}.${column.sqlName}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('declares the mandatory foreign keys on clusters, brief snapshots and email deliveries', () => {
    const declared = declaredForeignKeys()
      .filter((fk) =>
        ['clusters', 'brief_snapshots', 'email_deliveries'].includes(fk.table),
      )
      .map((fk) => `${fk.table}.${fk.from}`);
    expect(declared).toEqual([
      'brief_snapshots.brief_plan_id',
      'brief_snapshots.topic_id',
      'brief_snapshots.user_id',
      'clusters.topic_id',
      'email_deliveries.brief_snapshot_id',
      'email_deliveries.topic_id',
      'email_deliveries.user_id',
    ]);
  });
});
