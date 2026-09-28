/**
 * Poll every Source in the curated registry against its live feed and report
 * what came back.
 *
 * This is the operator's check that the registry is ingestible, which is not
 * something a unit test can assert: a feed URL that 404s, redirects to a paywall
 * or returns an empty document looks perfectly fine to a test that never opens
 * it. Run it with `pnpm ingest:check-feeds`; it exits non-zero if any Source
 * fails, so it can be wired into a deployment check.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpFeedFetcher } from './http-feed-fetcher.js';
import { systemHttpClient } from './system-http-client.js';
import { safeExternalUrl } from '../domain/url.js';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)));
const SEED = join(SRC, '..', 'directory', 'seed.json');

interface SeedSource {
  readonly slug: string;
  readonly name: string;
  readonly homepageUrl: string;
  readonly feedUrl?: string;
}

function registrySources(): readonly SeedSource[] {
  const parsed = JSON.parse(readFileSync(SEED, 'utf8')) as {
    readonly sources: readonly SeedSource[];
  };
  return parsed.sources;
}

const REQUEST_TIMEOUT_MS = 15_000;

interface Outcome {
  readonly slug: string;
  readonly ok: boolean;
  readonly detail: string;
}

async function checkOne(
  fetcher: HttpFeedFetcher,
  source: SeedSource,
): Promise<Outcome> {
  if (source.feedUrl === undefined || source.feedUrl.length === 0) {
    return { slug: source.slug, ok: false, detail: 'no feed URL in the registry' };
  }
  if (safeExternalUrl(source.feedUrl) === null) {
    return {
      slug: source.slug,
      ok: false,
      detail: `feed URL is not a safe http(s) URL: ${source.feedUrl}`,
    };
  }

  const started = Date.now();
  try {
    const feed = await Promise.race([
      fetcher.fetch(source.feedUrl),
      new Promise<never>((_resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`no response in ${REQUEST_TIMEOUT_MS}ms`)),
          REQUEST_TIMEOUT_MS,
        );
        timer.unref?.();
      }),
    ]);
    const entries = feed.entries.length;
    if (entries === 0) {
      return {
        slug: source.slug,
        ok: false,
        detail: `feed parsed but held no items (${Date.now() - started}ms)`,
      };
    }
    const linked = feed.entries.filter((e) => safeExternalUrl(e.url) !== null).length;
    return {
      slug: source.slug,
      ok: true,
      detail: `${entries} items, ${linked} with a safe link (${Date.now() - started}ms)`,
    };
  } catch (err) {
    return {
      slug: source.slug,
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

async function main(): Promise<void> {
  const fetcher = new HttpFeedFetcher({ http: systemHttpClient });
  const sources = registrySources();
  const outcomes: Outcome[] = [];
  // Sequential rather than parallel: a dozen simultaneous requests to a dozen
  // different publishers is how a check like this gets itself rate limited.
  for (const source of sources) {
    outcomes.push(await checkOne(fetcher, source));
  }

  const failed = outcomes.filter((o) => !o.ok);
  for (const o of outcomes) {
    console.log(`${o.ok ? 'ok  ' : 'FAIL'} ${o.slug.padEnd(24)} ${o.detail}`);
  }
  console.log(
    `\n${outcomes.length - failed.length}/${outcomes.length} Sources ingestible.`,
  );
  if (failed.length > 0) {
    console.error(`Not ingestible: ${failed.map((f) => f.slug).join(', ')}`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
