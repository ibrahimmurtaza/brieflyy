/**
 * Build the labelled corpus from the archived feed material, through the
 * application's own ingest path, into a database `pnpm cluster:benchmark` and
 * `pnpm cluster:sweep` can run over.
 *
 * Reads the archived feed copies `pnpm archive:corpus` wrote into the corpus
 * cache (default `.cluster-corpus-cache/`), unions them per Source, and places
 * the Articles through `IngestService`. Where a labelled reference's feed
 * carries too little text to be read from, the reference's own page supplies
 * the text, and the corpus records which text each reference was read from.
 *
 * Reports the Articles, Stories, Entities and Sources the corpus holds, names
 * every labelled family the corpus cannot weigh, and refuses a corpus whose
 * embeddings came from more than one model at more than one width.
 *
 *     pnpm corpus:build                                   # .cluster-corpus/corpus.db
 *     pnpm corpus:build "D:\path\to\corpus.db"            # other output file
 *     ARCHIVE_CORPUS_DIR=D:\path\to\cache pnpm corpus:build
 *
 * The output file must not be the live database: the benchmark and the sweep
 * fall back to DATABASE_URL, so writing the corpus there would silently change
 * what they measure.
 */

import Database from 'better-sqlite3';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { applySchema } from '../src/db/migrate.js';
import { createDatabase, type Db } from '../src/db/client.js';
import { directorySeed } from '../src/directory/seed.js';
import { DrizzleArticleRepo } from '../src/repos/article-repo.js';
import { DrizzleEntityRepo } from '../src/repos/entity-repo.js';
import { DrizzleSourceRepo } from '../src/repos/source-repo.js';
import { DrizzleStoryRepo } from '../src/repos/story-repo.js';
import { DrizzleTopicRepo } from '../src/repos/topic-repo.js';
import {
  buildCorpus,
  type CorpusFeedFetcher,
  type LabelledRef,
} from '../src/ingest/build-corpus.js';
import { createEmbeddingProvider } from '../src/services/openrouter-embedding-service.js';
import { nodeRandom } from '../src/domain/crypto.js';
import { systemClock } from '../src/domain/clock.js';
import { formatGroupingRefusal } from '../src/domain/cluster-grouping.js';
import { parseRss } from '../src/ingest/rss-parser.js';
import { stripFeedMetadata } from '../src/domain/feed-text.js';
import {
  SAME_EVENT_PAIRS,
  DIFFERENT_EVENT_PAIRS,
} from '../src/testing/cluster-pair-fixtures.js';

/** Where the archived feed copies live, unless `ARCHIVE_CORPUS_DIR` says otherwise. */
function corpusCacheDir(env: Readonly<Record<string, string | undefined>>): string {
  return env.ARCHIVE_CORPUS_DIR ?? '.cluster-corpus-cache';
}

/** The corpus database file, from the first argument or a default. */
function corpusFile(): string {
  const argument = process.argv[2];
  if (argument !== undefined && !argument.startsWith('--')) return argument;
  return '.cluster-corpus/corpus.db';
}

/** Turn a feed URL into the safe name the archive writer uses for its files. */
function safeCacheName(feedUrl: string): string {
  return feedUrl.replace(/:\/\//, '_').replace(/[^a-z0-9]/gi, '_');
}

/** The labelled references the corpus is measured against. */
function labelledRefs(): readonly LabelledRef[] {
  return [
    ...SAME_EVENT_PAIRS.flatMap((pair) => [pair.left, pair.right]),
    ...DIFFERENT_EVENT_PAIRS.flatMap((pair) => [pair.left, pair.right]),
  ];
}

/**
 * Reads the archived copies of one feed out of the corpus cache, unions them,
 * and — for labelled references whose feed text is too thin to be read from —
 * takes the text from the reference's own page and records that it did so.
 */
class ArchivedFeedFetcher implements CorpusFeedFetcher {
  readonly provenance = new Map<string, 'page'>();

  constructor(
    private readonly dir: string,
    private readonly refs: readonly LabelledRef[],
    private readonly page: (url: string) => Promise<string | null>,
  ) {}

  async fetch(
    feedUrl: string,
  ): Promise<{
    readonly entries: readonly {
      readonly externalId: string;
      readonly title: string;
      readonly body: string;
      readonly url: string;
      readonly publishedAt: Date;
    }[];
  }> {
    const safe = safeCacheName(feedUrl);
    let files: string[];
    try {
      files = readdirSync(this.dir).filter(
        (name) => name.endsWith(`__${safe}.xml`),
      );
    } catch {
      return { entries: [] };
    }
    files.sort();

    const byRef = new Map(
      this.refs.map((ref) => [`${ref.source}~${ref.externalId}`, ref]),
    );
    const source = this.sourceSlug(feedUrl);

    const entries: {
      externalId: string;
      title: string;
      body: string;
      url: string;
      publishedAt: Date;
    }[] = [];
    for (const file of files) {
      const xml = readFileSync(join(this.dir, file), 'utf8');
      const feed = parseRss(xml);
      for (const entry of feed.entries) {
        let body = entry.body;
        const ref = byRef.get(`${source}~${entry.externalId}`);
        if (
          ref !== undefined &&
          stripFeedMetadata(entry.body).trim().length === 0
        ) {
          const page = await this.page(entry.url);
          if (page !== null) {
            body = page;
            this.provenance.set(`${ref.source}~${ref.externalId}`, 'page');
          }
        }
        entries.push({
          externalId: entry.externalId,
          title: entry.title,
          body,
          url: entry.url,
          publishedAt: entry.publishedAt,
        });
      }
    }
    return { entries };
  }

  private sourceSlug(feedUrl: string): string {
    const known = directorySeed.sources.find((s) => s.feedUrl === feedUrl);
    return known === undefined ? '' : known.slug;
  }
}

/** The text of a reference's own page: its `og:description`, then its `description` meta, and nothing at all where neither can be read. */
async function pageText(url: string): Promise<string | null> {
  try {
    const res = await fetch(url);
    if (!res.ok) return null;
    const html = await res.text();
    const og =
      /<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']*)["']/i.exec(
        html,
      );
    if (og?.[1]) return og[1];
    const desc =
      /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i.exec(
        html,
      );
    if (desc?.[1]) return desc[1];
    return null;
  } catch {
    return null;
  }
}

async function main(): Promise<number> {
  const file = corpusFile();
  const driver = new Database(file);
  try {
    applySchema(driver);
    const db: Db = createDatabase({ driver });

    const dir = corpusCacheDir(process.env);
    const refs = labelledRefs();
    const fetcher: CorpusFeedFetcher = new ArchivedFeedFetcher(dir, refs, pageText);

    const sourceRepo = new DrizzleSourceRepo(db);
    const articleRepo = new DrizzleArticleRepo(db);
    const storyRepo = new DrizzleStoryRepo(db);
    const entityRepo = new DrizzleEntityRepo(db);
    const topicRepo = new DrizzleTopicRepo(db);

    for (const source of directorySeed.sources) {
      await sourceRepo.insert({
        id: source.slug,
        slug: source.slug,
        name: source.name,
        homepageUrl: source.homepageUrl,
        feedUrl: source.feedUrl ?? null,
        lastPolledAt: null,
        lastSuccessAt: null,
        backoff: {
          consecutiveFailures: 0,
          lastError: null,
          nextAttemptAt: null,
        },
      });
    }

    const provider = createEmbeddingProvider({ env: process.env });
    const report = await buildCorpus({
      db,
      sourceRepo,
      articleRepo,
      storyRepo,
      entityRepo,
      topicRepo,
      feedFetcher: fetcher,
      clock: systemClock,
      random: nodeRandom,
      embeddingProvider: provider,
      labelledRefs: refs,
    });

    const lines: string[] = [
      `corpus build: ${file}`,
      `  cache       ${dir}`,
      `  sources     ${report.sources}`,
      `  articles    ${report.articles}`,
      `  stories     ${report.stories}`,
      `  entities    ${report.entities}`,
    ];

    if (report.unresolved.length > 0) {
      lines.push('  unresolved  ' + report.unresolved.join(' '));
      lines.push('');
      for (const name of report.unresolved) {
        lines.push(
          `  missing     labelled reference the corpus does not hold: ${name}`,
        );
      }
    } else {
      lines.push('  unresolved  none');
    }

    const pageRefs = [...report.provenance.entries()]
      .filter(([, from]) => from === 'page')
      .map(([key]) => key);
    if (pageRefs.length > 0) {
      lines.push('');
      lines.push('  provenance  labelled references read from their own page:');
      for (const key of pageRefs) {
        lines.push(`    ${key}`);
      }
    }

    if (report.mixed) {
      lines.push('');
      lines.push(
        formatGroupingRefusal(
          [
            {
              label: `the corpus at ${file}`,
              models: report.models,
              widths: report.widths,
            },
          ],
          {
            corpus: `${report.sources} sources, ${report.articles} articles`,
          },
        ),
      );
      process.stdout.write(`${lines.join('\n')}\n`);
      return 1;
    }

    process.stdout.write(`${lines.join('\n')}\n`);
    return 0;
  } finally {
    driver.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((err: unknown) => {
    console.error(err);
    process.exitCode = 1;
  });
