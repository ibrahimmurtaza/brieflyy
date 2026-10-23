/**
 * Re-reading the names the Articles already in the corpus carry.
 *
 * The names an Article carries are stored, so a change to how a name is read —
 * a word a feed stamps on an item stops being a name, a spelling an outlet used
 * folds onto the thing actually named — leaves every previously ingested Article
 * holding the old reading. Ingest cannot revisit it: a feed poll only ever hands
 * over what the feed serves today. So the re-read is a command an operator runs,
 * the same way the embedding backfill is (see `story-embedding-backfill.ts`),
 * and for the same shape of reason: it rewrites the corpus it runs over, so the
 * file it runs over should be the copy an operator chose to name.
 *
 * Two properties make it safe to run more than once, and both are carried by the
 * rule the pipeline already runs rather than by anything added here:
 *
 * - **The read is the ingest read.** Names are extracted from the text the
 *   Article keeps — headline and body through `articleText`, feed bookkeeping
 *   and publisher furniture stripped — and resolved through the Entity repo
 *   exactly as ingest resolves them. A re-read is not a second way of deciding
 *   what an Article is about; it is the one way, applied again over the corpus.
 * - **A second run has nothing to redo.** The read is deterministic and the
 *   stored keys it resolves against do not move after a run has passed, so the
 *   run after this one extracts the same names about the same Articles, resolves
 *   the same keys to the same rows, and finds every set equal. It reports that
 *   nothing changed, which is the line that separates "already done" from a
 *   command that did not run.
 */
import type { RandomSource } from '../domain/crypto.js';
import { extractEntities } from '../domain/entity-extraction.js';
import { articleText } from '../domain/feed-text.js';
import type { Article, EntityId } from '../domain/types.js';
import type { ArticleRepo } from '../repos/article-repo.js';
import type { EntityRepo } from '../repos/entity-repo.js';

/** What one run of the re-read did. */
export interface EntityReReadReport {
  /**
   * The Articles the text was re-read over, whether or not one of them moved.
   * A zero here beside a zero `namesChanged` means the corpus was empty, not
   * that the command did no work.
   */
  readonly articlesReRead: number;
  /** Articles whose set of Entities the re-read rewrote. */
  readonly articlesChanged: number;
  /**
   * Entity links the re-read added or removed. One per name-for-better-name,
   * plus one per name-for-no-name: a count of the moves, not just of the
   * Articles that hold at least one.
   */
  readonly namesChanged: number;
}

/** The default number of Articles one pass of the re-read works over. */
const DEFAULT_BATCH_SIZE = 200;

export interface ReReadArticleNamesDeps {
  readonly articleRepo: ArticleRepo;
  readonly entityRepo: EntityRepo;
  /** Minted only for an Entity the re-read names for the first time. */
  readonly random: RandomSource;
  /** Absent: the default batch is used. */
  readonly batchSize?: number;
}

/**
 * Re-read the names every Article carries, in batches.
 *
 * The write is per Article and only where the read moved a name: an Article
 * whose re-read agrees with what it already carries is left exactly as it
 * stands, which is what a second run — and every untouched Article of a first
 * run, by the same measure — depends on.
 */
export async function reReadArticleNames(
  deps: ReReadArticleNamesDeps,
): Promise<EntityReReadReport> {
  const batchSize = deps.batchSize ?? DEFAULT_BATCH_SIZE;
  let offset = 0;
  let articlesReRead = 0;
  let articlesChanged = 0;
  let namesChanged = 0;
  for (;;) {
    const page = await deps.articleRepo.listArticles({
      offset,
      number: batchSize,
    });
    for (const article of page.articles) {
      const moved = await reReadArticle(deps, article);
      if (moved > 0) {
        articlesChanged += 1;
        namesChanged += moved;
      }
    }
    articlesReRead += page.articles.length;
    if (!page.hasMore) break;
    offset += page.articles.length;
  }
  return {
    articlesReRead,
    articlesChanged,
    namesChanged,
  };
}

/**
 * The number of the links one Article's re-read would add or take away.
 * Zero is the answer "nothing moved", and only a positive count writes.
 */
async function reReadArticle(
  deps: ReReadArticleNamesDeps,
  article: Article,
): Promise<number> {
  const text = articleText(article.title, article.body);
  // The ids are gathered into a Set because two keys the one Article names — a
  // short name and the name it was read as the shortening of — can both resolve
  // onto the same Entity row, and what the Article carries is one link per
  // Entity, not one link per way of writing it.
  const next = new Set<EntityId>();
  for (const name of extractEntities(text)) {
    const resolved = await deps.entityRepo.upsertByKey({
      entity: name,
      id: deps.random.uuid() as EntityId,
    });
    next.add(resolved.id);
  }
  const carried = new Set(article.entities.map((e) => e.id));
  let added = 0;
  for (const id of next) {
    if (!carried.has(id)) added += 1;
  }
  let removed = 0;
  for (const id of carried) {
    if (!next.has(id)) removed += 1;
  }
  if (added === 0 && removed === 0) return 0;
  await deps.articleRepo.replaceArticleEntities({
    articleId: article.id,
    entityIds: [...next],
  });
  return added + removed;
}

/**
 * What the operator reads when the re-read is done.
 *
 * Drawn here rather than in the command, for the same reason the embedding
 * backfill's is: a run that rewrote nothing and a run that saw nothing are
 * different events, and a bare `0` reads as either of them.
 */
export function formatEntityReReadReport(
  report: EntityReReadReport,
): string {
  if (report.articlesReRead === 0) {
    return 'No Articles to re-read: the corpus holds none.\n';
  }
  if (report.namesChanged === 0) {
    return (
      `Re-read ${report.articlesReRead} Articles. Every set of names matched ` +
      'what the corpus already carries, so nothing was rewritten.\n'
    );
  }
  return (
    `Re-read ${report.articlesReRead} Articles. ` +
    `${report.namesChanged} name${report.namesChanged === 1 ? '' : 's'} moved ` +
    `across ${report.articlesChanged} of them.\n`
  );
}
