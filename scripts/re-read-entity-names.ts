/**
 * Re-reads the names the Articles of a corpus carry, and rewrites them where
 * the reading has moved.
 *
 *     pnpm ingest:re-read-entities "D:\path\to\corpus-copy.db"     # a copy, which is the point
 *
 * **Take a copy.** This command rewrites which Entities each Article carries,
 * which is the input Cluster grouping reads — so a run pointed at the working
 * database by a variable nobody was thinking about changes the groupings of
 * every Topic on the next formation pass. Naming the file *is* the act, the
 * same way `pnpm cluster:backfill` is only ever run against a copy.
 *
 * **A second run changes nothing and says so.** The read is the ingest read —
 * names are extracted from the text the Article keeps and resolved through the
 * same identity rule ingest resolves them with — so once the corpus has been
 * re-read, running it again extracts the same names and rewrites nothing. It
 * prints the count of Articles it re-read either way, because a re-read that
 * saw every Article is a re-read even when it moved no name.
 */
import Database from 'better-sqlite3';

import { nodeRandom } from '../src/domain/crypto.js';
import { createDatabase, type Db } from '../src/db/client.js';
import { DrizzleArticleRepo } from '../src/repos/article-repo.js';
import { DrizzleEntityRepo } from '../src/repos/entity-repo.js';
import {
  formatEntityReReadReport,
  reReadArticleNames,
} from '../src/services/entity-names-re-read.js';

/**
 * The file to re-read.
 *
 * **Required, and no fallback to `DATABASE_URL`.** Every other corpus command
 * reads, so naming one is a convenience and falling back costs nothing; this
 * one writes. A re-read of the wrong corpus is not a mistake a line of output
 * can undo.
 */
function databaseFile(): string {
  const argument = process.argv[2];
  if (argument === undefined) {
    throw new Error(
      'name the database to re-read: this command writes, so it takes a copy rather than DATABASE_URL.\n' +
        '  pnpm ingest:re-read-entities "D:\\path\\to\\corpus-copy.db"',
    );
  }
  return argument;
}

async function main(): Promise<number> {
  const file = databaseFile();
  const driver = new Database(file);
  try {
    const db: Db = createDatabase({ driver });
    const report = await reReadArticleNames({
      articleRepo: new DrizzleArticleRepo(db),
      entityRepo: new DrizzleEntityRepo(db),
      random: nodeRandom,
    });
    process.stdout.write(formatEntityReReadReport(report));
    // A run over an empty corpus nothing was carried by, and a run that rewrote
    // nothing, are both a complete job; only a line nobody asked for was missed,
    // and no line anybody asked for is not written.
    return 0;
  } finally {
    driver.close();
  }
}

main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  });
