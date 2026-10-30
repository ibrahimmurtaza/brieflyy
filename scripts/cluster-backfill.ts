/**
 * Embeds the Stories a corpus was holding before anything carried an embedding.
 *
 * `pnpm cluster:benchmark`, `pnpm cluster:sweep`, `pnpm cluster:velocity` and
 * `pnpm cluster:summary` all read a corpus and write nothing. This one reads a
 * corpus and writes to it, so it says what it did and what it cost rather than
 * printing a measurement — and, unlike them, it **requires** the database as an
 * argument rather than falling back to `DATABASE_URL`.
 *
 *     pnpm cluster:backfill "D:\path\to\corpus-copy.db"     # a copy, which is the point
 *
 * **Take a copy.** Every Story already in a database was formed before anything
 * carried an embedding (ADR-0037), and this is the act that changes that. It
 * writes to the two columns a Story's second reading lives in and to nothing
 * else, and it never replaces a vector that is already there — but a corpus that
 * has been through it has grouping reading a third floor where it read none
 * before, and the only way to see that is to run `pnpm cluster:benchmark` over
 * the result and compare it with the run over the copy you kept. That is why the
 * path is required: a run pointed at the working database by a variable nobody was
 * thinking about is the one outcome the copy exists to prevent.
 *
 * **A second run embeds nothing and says so.** A run over an already-backfilled
 * corpus spends no calls and prints a sentence saying every Story already carries
 * an embedding, which is the one line that distinguishes "already done" from a
 * command that did not run.
 *
 * **It needs a credential, and it refuses without one.** `OPENROUTER_API_KEY`
 * builds no provider at all, and a backfill with no provider would report that it
 * had nothing to do — the exact line a finished run prints, said by a command
 * that did no work. So it stops and names what is missing.
 *
 * The batch size is `OPENROUTER_EMBEDDING_BATCH_SIZE`. The endpoint is billed per
 * request, so it is the whole of what decides what a corpus costs, and nothing
 * upstream publishes a maximum for the array it takes — which is why a call the
 * endpoint refuses is asked again one text at a time rather than being the end of
 * the run.
 */
import Database from 'better-sqlite3';

import { createDatabase, type Db } from '../src/db/client.js';
import { DrizzleStoryRepo } from '../src/repos/story-repo.js';
import { createEmbeddingProvider } from '../src/services/openrouter-embedding-service.js';
import {
  backfillStoryEmbeddings,
  formatEmbeddingBackfillReport,
} from '../src/services/story-embedding-backfill.js';
import type { BatchingEmbeddingProvider, EmbeddingProvider } from '../src/domain/embedding.js';
import { readEmbeddingBatchSize } from '../src/env.js';

/**
 * The file to backfill.
 *
 * **Required, and no fallback to `DATABASE_URL`.** The other three corpus
 * commands read, so naming one is a convenience and falling back costs nothing;
 * this one writes. A run pointed at the working database by a variable nobody was
 * thinking about is a corpus whose grouping has silently changed, which is the
 * one outcome the copy exists to prevent. Naming the file *is* the act — the same
 * way `pnpm db:push` is only ever run against a database the operator has decided
 * to lose.
 */
function databaseFile(): string {
  const argument = process.argv[2];
  if (argument === undefined) {
    throw new Error(
      'name the database to backfill: this command writes, so it takes a copy rather than DATABASE_URL.\n' +
        '  pnpm cluster:backfill "D:\\path\\to\\corpus-copy.db"',
    );
  }
  return argument;
}

async function main(): Promise<number> {
  const file = databaseFile();
  const driver = new Database(file);
  try {
    const db: Db = createDatabase({ driver });
    const storyRepo = new DrizzleStoryRepo(db);

    // `createEmbeddingProvider` answers nothing rather than a provider that
    // answers nothing, so a missing credential is visible here rather than as a
    // run that reported nothing to do.
    const provider = createEmbeddingProvider({ env: process.env });
    if (provider === null) {
      throw new Error(
        'a backfill needs OPENROUTER_API_KEYS or OPENROUTER_API_KEY: without one no provider is built, and a run with no provider ' +
          'would report that it had nothing to do, which is the line a finished run prints',
      );
    }
    if (!isBatching(provider)) {
      throw new Error(
        'this deployment embeds one Article at a time, which is what the ingest path uses; a backfill has to ask ' +
          'in batches, because the endpoint is billed per request rather than per text',
      );
    }

    const batchSize = readEmbeddingBatchSize(process.env);
    const report = await backfillStoryEmbeddings({ storyRepo, provider, batchSize });
    process.stdout.write(formatEmbeddingBackfillReport(report, { batchSize }));

    // A run that found nothing to do is the correct outcome of a second run and
    // exits zero. A run that found Stories and could not embed all of them is a
    // corpus the semantic floor still does not apply to, which is worth a
    // non-zero exit rather than a line somebody has to notice.
    return report.considered > 0 && report.unanswered > 0 ? 1 : 0;
  } finally {
    driver.close();
  }
}

/**
 * Whether this provider can be asked about many texts in one call.
 *
 * A deployment whose provider only embeds one text at a time is a complete
 * implementation of the formation contract, so this is asked rather than
 * assumed — and a backfill on one would cost a request per Story, which on a real
 * corpus is not a run anybody should start by accident.
 */
function isBatching(
  provider: EmbeddingProvider,
): provider is EmbeddingProvider & BatchingEmbeddingProvider {
  return typeof (provider as Partial<BatchingEmbeddingProvider>).embedBatch === 'function';
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });