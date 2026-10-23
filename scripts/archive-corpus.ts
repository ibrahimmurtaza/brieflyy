/**
 * Fetch archived copies of each Source's feed from the Wayback Machine over a
 * window of dates and write the union of them per Source into the corpus cache
 * where the corpus builder reads them.
 *
 * Window: ARCHIVE_CORPUS_FROM / ARCHIVE_CORPUS_TO (YYYYMMDD), defaults to the
 * two weeks the corpus was polled over (2026-10-02 to 2026-10-12).
 *
 * Rate limit: ARCHIVE_CORPUS_RATE (requests per second, default 1). Requests
 * are spaced out against the archive rather than sent as fast as possible.
 *
 * Output dir: first argument or ARCHIVE_CORPUS_DIR, default
 * `.cluster-corpus-cache/` (gitignored, reproducible by this command alone).
 *
 * Resumable: a snapshot already on disk is not fetched again, so a run that
 * dies part way through continues from where it left off.
 *
 * Per Source it reports what it found and what it found nothing for, naming
 * every Source whose feed has no copy in the window.
 *
 *     pnpm archive:corpus                                        # default window, 1 req/s
 *     ARCHIVE_CORPUS_FROM=20261002 ARCHIVE_CORPUS_TO=20261012 \
 *       pnpm archive:corpus                                      # explicit window
 *     ARCHIVE_CORPUS_RATE=2 pnpm archive:corpus                  # 2 requests per second
 *     pnpm archive:corpus "D:\path\to\cache"                     # other output dir
 */

import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  buildCdxUrl,
  buildSnapshotUrl,
  dedupeSnapshots,
  rateLimitMs,
  registrySources,
  windowFromEnv,
  type SourceResult,
} from '../src/ingest/archive-corpus.js';

function outputDir(env: Readonly<Record<string, string | undefined>>): string {
  const arg = process.argv[2];
  if (arg !== undefined && !arg.startsWith('--')) return arg;
  return env.ARCHIVE_CORPUS_DIR ?? '.cluster-corpus-cache';
}

async function fetchCdx(url: string): Promise<readonly { timestamp: string; original: string; digest: string }[]> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDX API returned ${res.status} for ${url}`);
  const body = await res.text();
  if (body.trim().length === 0) return [];
  const parsed = JSON.parse(body) as unknown[][];
  const rows: { timestamp: string; original: string; digest: string }[] = [];
  for (const row of parsed) {
    if (!Array.isArray(row) || row.length < 3) continue;
    rows.push({ timestamp: String(row[0]), original: String(row[1]), digest: String(row[2]) });
  }
  return rows;
}

async function fetchSnapshot(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`snapshot returned ${res.status} for ${url}`);
  return res.text();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function processSource(
  source: { readonly slug: string; readonly name: string; readonly feedUrl?: string },
  from: string,
  to: string,
  dir: string,
  limiter: { wait(): Promise<void> },
): Promise<SourceResult> {
  const slug = source.slug;
  const name = source.name;
  const feedUrl = source.feedUrl;
  if (feedUrl === undefined || feedUrl.length === 0) {
    return {
      slug,
      name,
      feedUrl: '',
      found: 0,
      snapshots: [],
      error: 'no feed URL in the registry',
    };
  }

  await limiter.wait();
  let rows: readonly { timestamp: string; original: string; digest: string }[];
  try {
    rows = await fetchCdx(buildCdxUrl(feedUrl, from, to));
  } catch (err) {
    return {
      slug,
      name,
      feedUrl,
      found: 0,
      snapshots: [],
      error: err instanceof Error ? err.message : String(err),
    };
  }

  const unique = dedupeSnapshots(rows as { timestamp: string; original: string; digest: string }[]);
  const saved: string[] = [];
  for (const row of unique) {
    const safe = row.original.replace(/:\/\//, '_').replace(/[^a-z0-9]/gi, '_');
    const path = join(dir, `${row.timestamp}__${safe}.xml`);
    if (existsSync(path)) continue;

    await limiter.wait();
    let body: string;
    try {
      body = await fetchSnapshot(buildSnapshotUrl(row.timestamp, row.original));
    } catch (err) {
      continue;
    }
    writeFileSync(path, body);
    saved.push(row.timestamp);
  }

  return { slug, name, feedUrl, found: saved.length, snapshots: saved };
}

async function main(): Promise<number> {
  const { from, to } = windowFromEnv(process.env);
  const dir = outputDir(process.env);
  mkdirSync(dir, { recursive: true });
  const minInterval = rateLimitMs(process.env);
  let lastRequest = 0;
  const limiter = {
    async wait(): Promise<void> {
      const now = Date.now();
      const elapsed = now - lastRequest;
      if (elapsed < minInterval) {
        await sleep(minInterval - elapsed);
      }
      lastRequest = Date.now();
    },
  };

  const sources = registrySources();
  const results: SourceResult[] = [];
  for (const source of sources) {
    results.push(await processSource(source, from, to, dir, limiter));
  }

  const withCopies = results.filter((r) => r.error === undefined && r.found > 0);
  const noCopies = results.filter((r) => r.error === undefined && r.found === 0);
  const errors = results.filter((r) => r.error !== undefined);

  let total = 0;
  for (const r of withCopies) total += r.found;

  const lines: string[] = [
    `archive corpus: ${from} to ${to}`,
    `  ${sources.length} Sources, ${total} archived copies written to ${dir}`,
    '',
  ];

  for (const r of withCopies) {
    lines.push(
      `  ok   ${r.slug.padEnd(24)} ${r.found} copies ${r.snapshots.join(', ')}`,
    );
  }
  for (const r of noCopies) {
    lines.push(`  none ${r.slug.padEnd(24)} no archived copy in the window`);
  }
  for (const r of errors) {
    lines.push(`  FAIL ${r.slug.padEnd(24)} ${r.error}`);
  }

  process.stdout.write(`${lines.join('\n')}\n`);
  return errors.length > 0 ? 1 : 0;
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
