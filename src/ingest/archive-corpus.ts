/**
 * Pure logic for fetching archived feed copies from the Wayback Machine into
 * the corpus cache. Network and filesystem access happen in the CLI script
 * (`scripts/archive-corpus.ts`); this module holds the functions that can be
 * tested without reaching the network.
 *
 * Window: ARCHIVE_CORPUS_FROM / ARCHIVE_CORPUS_TO (YYYYMMDD), defaults to the
 * two weeks the corpus was polled over (2026-10-02 to 2026-10-12).
 *
 * Rate limit: ARCHIVE_CORPUS_RATE (requests per second, default 1).
 */

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface SeedSource {
  readonly slug: string;
  readonly name: string;
  readonly homepageUrl: string;
  readonly feedUrl?: string;
}

export interface CdxRow {
  readonly timestamp: string;
  readonly original: string;
  readonly digest: string;
}

interface SourceResult {
  readonly slug: string;
  readonly name: string;
  readonly feedUrl: string;
  readonly found: number;
  readonly snapshots: readonly string[];
  readonly error?: string;
}

function defaultWindow(): { readonly from: string; readonly to: string } {
  return { from: '20261002', to: '20261012' };
}

export function windowFromEnv(env: Readonly<Record<string, string | undefined>>): { readonly from: string; readonly to: string } {
  const from = env.ARCHIVE_CORPUS_FROM ?? defaultWindow().from;
  const to = env.ARCHIVE_CORPUS_TO ?? defaultWindow().to;
  if (!/^\d{8}$/.test(from)) {
    throw new Error(`ARCHIVE_CORPUS_FROM must be YYYYMMDD, got "${from}"`);
  }
  if (!/^\d{8}$/.test(to)) {
    throw new Error(`ARCHIVE_CORPUS_TO must be YYYYMMDD, got "${to}"`);
  }
  return { from, to };
}

export function rateLimitMs(env: Readonly<Record<string, string | undefined>>): number {
  const raw = env.ARCHIVE_CORPUS_RATE;
  if (raw === undefined) return 1000;
  const perSec = Number.parseFloat(raw);
  if (!Number.isFinite(perSec) || perSec <= 0) {
    throw new Error(`ARCHIVE_CORPUS_RATE must be a positive number, got "${raw}"`);
  }
  return Math.round(1000 / perSec);
}

export function buildCdxUrl(feedUrl: string, from: string, to: string): string {
  const encoded = encodeURIComponent(feedUrl);
  return (
    'https://web.archive.org/cdx/search/cdx' +
    `?url=${encoded}` +
    '&output=json' +
    `&from=${from}` +
    `&to=${to}` +
    '&filter=statuscode:200' +
    '&collapse=digest' +
    '&fl=timestamp,original,digest'
  );
}

export function buildSnapshotUrl(timestamp: string, original: string): string {
  return `https://web.archive.org/web/${timestamp}/${original}`;
}

export function safeCacheName(timestamp: string, url: string): string {
  // Keep the scheme (https:// -> https_), replace the rest of the non-alphanumeric
  // characters so the name is a safe filesystem name. Matches the layout of the
  // existing corpus cache files: <timestamp>__<scheme>_<host>_<path>.xml
  const safe = url.replace(/:\/\//, '_').replace(/[^a-z0-9]/gi, '_');
  return `${timestamp}__${safe}.xml`;
}

export function dedupeSnapshots(rows: readonly CdxRow[]): CdxRow[] {
  const seen = new Set<string>();
  const unique: CdxRow[] = [];
  for (const row of rows) {
    if (seen.has(row.digest)) continue;
    seen.add(row.digest);
    unique.push(row);
  }
  return unique;
}

function registrySources(): readonly SeedSource[] {
  const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
  const SEED = join(SRC, '..', 'directory', 'seed.json');
  const parsed = JSON.parse(readFileSync(SEED, 'utf8')) as {
    readonly sources: readonly SeedSource[];
  };
  return parsed.sources;
}

export { type SeedSource, type SourceResult, registrySources };
