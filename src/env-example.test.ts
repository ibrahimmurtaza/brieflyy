import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
const REPO = resolve(SRC, '..');
const ENV_MODULE = join(SRC, 'env.ts');
const ENV_EXAMPLE = join(REPO, '.env.example');

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.endsWith('.ts')) out.push(full);
  }
  return out;
}

const SOURCES = listSourceFiles(SRC);

/** Every function defined in the env module, so the scan stays in step with it. */
function readerNames(source: string): string[] {
  return [
    ...new Set([...source.matchAll(/(?:export\s+)?function\s+(\w+)/g)].map((m) => m[1] as string)),
  ].sort();
}

const DIRECT_ENV_READ_RE = /process\.env\s*[.[]/;

/** Every variable name assigned in a dotenv file. */
function dotenvKeys(file: string): string[] {
  return readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1])
    .filter((key): key is string => key !== undefined);
}

describe('configuration surface', () => {
  const readCallRe = new RegExp(
    `\\b(?:${readerNames(readFileSync(ENV_MODULE, 'utf8')).join('|')})(?:<[^>()]*>)?\\(\\s*\\w+\\s*,\\s*'([A-Z0-9_]+)'`,
    'g',
  );
  /** Every reader call in the application, not only the ones in the env module. */
  const readVariables = [
    ...new Set(
      SOURCES.filter((file) => !file.endsWith('.test.ts')).flatMap((file) =>
        [...readFileSync(file, 'utf8').matchAll(readCallRe)].map((m) => m[1] as string),
      ),
    ),
  ].sort();

  it('reads configuration in exactly one module', () => {
    // Tests are excluded: a test may set or read process.env to exercise a reader.
    const offenders = SOURCES.filter(
      (file) =>
        file !== ENV_MODULE &&
        !file.endsWith('.test.ts') &&
        DIRECT_ENV_READ_RE.test(readFileSync(file, 'utf8')),
    );
    expect(offenders).toEqual([]);
  });

  it('finds the variables the application reads', () => {
    expect(readVariables).toEqual([
      'APP_BASE_URL',
      'COOKIE_SECURE',
      'DATABASE_URL',
      'DEV_TOOLS_ENABLED',
      'EMAIL_FROM',
      'EMAIL_TRANSPORT',
      'GOOGLE_OAUTH_CLIENT_ID',
      'GOOGLE_OAUTH_CLIENT_SECRET',
      'HOST',
      'INGEST_ENABLED',
      'NODE_ENV',
      'OAUTH_PROVIDER',
      'OPENAI_API_KEY',
      'OPENAI_API_URL',
      'PORT',
      'RESEND_API_KEY',
      'TRUST_PROXY',
    ]);
  });

  it('documents every variable the application reads in .env.example', () => {
    expect(dotenvKeys(ENV_EXAMPLE).sort()).toEqual(readVariables);
  });
});
