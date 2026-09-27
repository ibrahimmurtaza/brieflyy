import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeScan, scanStagedFiles, type StagedFile } from './credential-scan.js';

export interface CheckResult {
  readonly ok: boolean;
  readonly report: string;
}

/** The lines a commit would add, keyed by the file they belong to. */
function stagedFiles(cwd: string): StagedFile[] {
  const diff = execFileSync('git', ['diff', '--cached', '--unified=0', '--no-color'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const files: StagedFile[] = [];
  let path: string | null = null;
  let added: string[] = [];

  const flush = (): void => {
    if (path !== null) files.push({ path, text: added.join('\n') });
    path = null;
    added = [];
  };

  for (const line of diff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      flush();
      const match = /^diff --git a\/(.+?) b\//.exec(line);
      path = match?.[1] ?? null;
      continue;
    }
    if (line.startsWith('+++ ') || line.startsWith('--- ') || line.startsWith('@@')) continue;
    if (line.startsWith('+')) added.push(line.slice(1));
  }
  flush();
  return files;
}

/** True when nothing in the index looks like a live credential. */
export function runCheck(cwd: string): CheckResult {
  const result = scanStagedFiles(stagedFiles(cwd));
  const report = describeScan(result);
  return { ok: result.files.length === 0 && result.forbidden.length === 0, report };
}

const entry = process.argv[1];
if (entry !== undefined && resolve(entry) === fileURLToPath(import.meta.url)) {
  const { ok, report } = runCheck(process.cwd());
  console.log(report);
  process.exit(ok ? 0 : 1);
}
