import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { runCheck } from './check-staged-secrets.js';

const OPENAI_KEY = `sk-proj-${'a'.repeat(40)}`;
const GOOGLE_SECRET = `GOCSPX-${'b'.repeat(30)}`;
const RESEND_KEY = `re_${'c'.repeat(24)}`;

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'brieflyy-secrets-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** A throwaway repository with one commit, so there is a HEAD to diff against. */
function initRepo(): void {
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8' });
  git('init', '--quiet');
  git('config', 'user.email', 'test@brieflyy.test');
  git('config', 'user.name', 'Test');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.autocrlf', 'false');
  writeFileSync(join(dir, 'README.md'), '# brieflyy\n');
  git('add', 'README.md');
  git('commit', '--quiet', '-m', 'initial');
}

function stage(relativePath: string, contents: string): void {
  const full = join(dir, relativePath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
  execFileSync('git', ['add', '--', relativePath], { cwd: dir, encoding: 'utf8' });
}

describe('staged credential check', () => {
  it('passes when nothing is staged', () => {
    initRepo();
    const result = runCheck(dir);
    expect(result.ok).toBe(true);
    expect(result.report).toBe('No credentials staged.');
  });

  it('fails when a provider key is staged', () => {
    initRepo();
    stage('src/thing.ts', `const key = '${OPENAI_KEY}';\n`);
    const result = runCheck(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/OpenAI API key/);
    expect(result.report).toMatch(/src\/thing\.ts:1/);
  });

  it('fails on a Google client secret and a Resend key', () => {
    initRepo();
    stage('src/a.ts', `const s = '${GOOGLE_SECRET}';\n`);
    stage('src/b.ts', `const r = '${RESEND_KEY}';\n`);
    const result = runCheck(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/Google OAuth client secret/);
    expect(result.report).toMatch(/Resend API key/);
  });

  it('fails on a private key block', () => {
    initRepo();
    stage('key.pem', '-----BEGIN RSA PRIVATE KEY-----\nMIIEow==\n'); // secret-scan:allow the block is the point of this test
    expect(runCheck(dir).ok).toBe(false);
  });

  it('fails on a secret assigned to a credential-shaped name', () => {
    initRepo();
    stage('.env.production', 'GOOGLE_OAUTH_CLIENT_SECRET=zzzzzzzzzzzzzzzzzzzz\n'); // secret-scan:allow the name is the point of this test
    const result = runCheck(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/never be committed/);
    expect(result.report).toMatch(/secret assignment/);
  });

  it('refuses to commit a local .env even when its values look empty', () => {
    initRepo();
    stage('.env', 'OPENAI_API_KEY=\n');
    const result = runCheck(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/\.env: a local environment file must never be committed/);
  });

  it('passes for .env.example with placeholders and empty values', () => {
    initRepo();
    stage(
      '.env.example',
      [
        'OPENAI_API_KEY=',
        'GOOGLE_OAUTH_CLIENT_SECRET=',
        'RESEND_API_KEY=change-me',
        'DATABASE_URL=file:./brieflyy.db',
        '',
      ].join('\n'),
    );
    const result = runCheck(dir);
    expect(result.ok).toBe(true);
    expect(result.report).toBe('No credentials staged.');
  });

  it('does not let a placeholder word hide a real value', () => {
    initRepo();
    stage(
      'src/config.ts',
      'const SESSION_SECRET = "dev-only-change-me-aB3xQ9zLmN7pR2sT5vW8";\n', // secret-scan:allow the fixture has to look real
    );
    const result = runCheck(dir);
    expect(result.ok).toBe(false);
    expect(result.report).toMatch(/secret assignment/);
  });

  it('does not flag a fixture built from filler characters', () => {
    initRepo();
    stage('src/test-key.ts', "const apiKey = 'xxxxxxxxxxxxxxxx';\n");
    expect(runCheck(dir).ok).toBe(true);
  });

  it('does not flag a value the test suite made up', () => {
    initRepo();
    stage('src/thing.ts', 'const CREDENTIALS = JSON.stringify(creds);\n');
    expect(runCheck(dir).ok).toBe(true);
  });

  it('stays quiet for a line the author marked as deliberate', () => {
    initRepo();
    stage(
      'src/fixture.ts',
      [
        `const key = '${OPENAI_KEY}'; // secret-scan:allow a fixture for the scanner's own tests`,
        `const other = '${OPENAI_KEY}';`,
        '',
      ].join('\n'),
    );
    const result = runCheck(dir);
    expect(result.ok).toBe(false);
    // The marked line passes; the identical one below it does not.
    expect(result.report).toMatch(/:2:/);
    expect(result.report).not.toMatch(/:1:/);
  });

  it('ignores lines that only remove a value', () => {
    initRepo();
    stage('src/old.ts', 'export const key = 1;\n');
    execFileSync('git', ['rm', '--cached', '--quiet', 'src/old.ts'], { cwd: dir, encoding: 'utf8' });
    const result = runCheck(dir);
    expect(result.ok).toBe(true);
  });

  it('ignores a value the application reads at run time', () => {
    initRepo();
    stage(
      'src/server-config.ts',
      [
        "import { readRequiredString } from './env.js';",
        'const appBaseUrl = readRequiredString(env, "APP_BASE_URL");',
        'const token = process.env.GITHUB_TOKEN;',
        'const header = `Authorization: Bearer ${apiKey}`;',
        '',
      ].join('\n'),
    );
    expect(runCheck(dir).ok).toBe(true);
  });
});
