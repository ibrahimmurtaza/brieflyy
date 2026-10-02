import { entitlementsFor } from '../domain/tier.js';
import type { Clock } from '../domain/clock.js';
import type { ArchiveSearchFilter } from '../domain/archive-query.js';
import type { ArchiveFilters, ArchiveRepo, ArchiveSearchResult } from '../repos/archive-repo.js';
import type { Tier, UserId } from '../domain/types.js';

/** How many results one page of the Archive asks for. */
export const ARCHIVE_RESULT_LIMIT = 25;

/**
 * How far into the Archive the paging links will go.
 *
 * A bound rather than an open number because `offset` arrives in a URL: SQLite
 * satisfies `LIMIT 25 OFFSET n` by walking `n` rows, so an unbounded parameter is a
 * way to ask the server to read a whole Archive by typing. Twenty-five hundred rows
 * is further than anybody pages and is a trivial walk; past that a User narrows
 * rather than turning pages.
 */
export const ARCHIVE_MAX_OFFSET = 2_500;

/** The offset a page actually starts at, for whatever the URL asked for. */
export function archiveOffset(asked: number): number {
  if (!Number.isSafeInteger(asked) || asked <= 0) return 0;
  const page = Math.min(asked, ARCHIVE_MAX_OFFSET);
  return Math.floor(page / ARCHIVE_RESULT_LIMIT) * ARCHIVE_RESULT_LIMIT;
}

/**
 * Who is searching and what they are entitled to.
 *
 * One type rather than two parameters because they are never one without the other:
 * a User's id without their tier has no window attached, and a tier without a User is
 * a plan somebody bought. Both methods take it, so the page builds it once and cannot
 * hand one method a different User from the other.
 */
export interface ArchiveViewer {
  readonly userId: UserId;
  readonly tier: Tier;
}

/**
 * Searching a User's own Archive.
 *
 * The service is the layer that knows what a tier is *for*. The repository applies a
 * window to rows; deciding how long that window is, and reading it from the User
 * rather than from a literal, is the whole of what this adds — which is the point.
 * A search that filtered by tier at the page, or an in-memory filter over an array
 * the route happened to be holding, was a paywall with the lock on the wrong side of
 * the door: everything the User was not entitled to had already left the database
 * and been loaded into the process.
 *
 * Everything below this layer is a list of rows and a window. The Clock is passed in
 * because the window is a fact about a request, and a search that measured it
 * against the machine's own clock would put a User's Archive boundary at a different
 * hour depending on which server answered them.
 */
export class ArchiveSearchService {
  constructor(
    private readonly deps: {
      readonly archiveRepo: ArchiveRepo;
      readonly clock: Clock;
    },
  ) {}

  /**
   * How far back this tier's Archive reaches, or null when it reaches all of it.
   *
   * The number comes from the one table that describes tiers rather than from a
   * literal here, so a test exercising the paywall has to put a User on the tier it
   * is testing instead of asserting that a branch works.
   *
   * A BriefSnapshot is exempt on both tiers, and the exemption is not applied here.
   * It is a property of the Archive rather than of a tier — a snapshot is the record
   * of what was sent, and age has nothing to say about that — so it belongs with the
   * rows. Restating it per tier would be a second place for the same rule to live.
   */
  private windowFor(tier: Tier): Date | null {
    const days = entitlementsFor(tier).archiveRetentionDays;
    if (days === null) return null;
    // Copied before it is moved: the Date comes from a Clock the caller owns, and a
    // search that shifted a shared instance backwards by thirty days would change
    // the window for whatever asked the clock next.
    const since = new Date(this.deps.clock.now());
    since.setUTCDate(since.getUTCDate() - days);
    return since;
  }

  /**
   * One page of the Archive, newest first.
   *
   * `offset` is how many matching rows are already behind the caller, which is what
   * makes the page a page. A limit with no way past it is a dead end for a User whose
   * Archive holds more than one page of it.
   */
  async search(input: {
    readonly viewer: ArchiveViewer;
    readonly filter: ArchiveSearchFilter;
    readonly offset?: number;
  }): Promise<ArchiveSearchResult> {
    return this.deps.archiveRepo.search({
      userId: input.viewer.userId,
      filter: input.filter,
      retainedSince: this.windowFor(input.viewer.tier),
      limit: ARCHIVE_RESULT_LIMIT,
      offset: input.offset ?? 0,
    });
  }

  /**
   * What this User can narrow by.
   *
   * Read through the repository rather than assembled here, so the options come from
   * the same rows the results come from and cannot describe a wider Archive than the
   * search will return. A filter for something this User has no Archive of is a link
   * to a page with nothing in it.
   */
  async filtersFor(viewer: ArchiveViewer): Promise<ArchiveFilters> {
    return this.deps.archiveRepo.listFilters({
      userId: viewer.userId,
      retainedSince: this.windowFor(viewer.tier),
    });
  }
}