/**
 * What text a Cluster is shown with: its title, its one-liner, and its bullets.
 *
 * One decision, in one module. `clusterSummaryOf` reads the Articles already
 * ranked by the formation service and returns the three lines a Cluster carries,
 * none of which repeats another. The three are not independent — the title is the
 * representative Article's headline and the one-liner is a sentence off the same
 * Article, so a rule that excluded the one-liner from the bullets and not the
 * title would put the title straight back in through the headline fallback.
 *
 * Kept out of `cluster-formation-service.js` because formation is the grouping
 * rule and this is the text rule. Two adapters read it: the service, which forms
 * Clusters, and the `cluster:summary` script, which measures what they say. One
 * module behind both keeps the rule from having a second copy that drifts.
 */
import { bulletsFrom, oneLinerFrom } from './cluster-text.js';
import type { Article } from './types.js';

/**
 * How many statements a Cluster's bullets carry.
 *
 * Exported for the same reason `clusterVelocity` is: the summary measurement asks
 * what a Cluster is given rather than what it spends, and a report that read the
 * number off a copy of it would be measuring the copy.
 */
export const MAX_BULLET_POINTS = 3;

/**
 * What a Cluster is shown with, read off its Articles in ranked order.
 */
export interface ClusterSummaryText {
  /** The Cluster's headline: its representative Article's own title. */
  readonly title: string;
  /** The line the bullets sit under: the representative Article's first statement. */
  readonly oneLiner: string;
  /** The statements below it, none of which repeats either of the two. */
  readonly bulletPoints: readonly string[];
}

/**
 * What a Cluster is shown with, read off its Articles in ranked order.
 *
 * One place, because the three lines are not independent: the title is the
 * representative Article's headline and the one-liner is a sentence off the same
 * Article, so a rule that excluded the one-liner from the bullets and not the title
 * would put the title straight back in through the headline fallback.
 */
export function clusterSummaryOf(ranked: readonly Article[]): ClusterSummaryText {
  const representative = ranked[0];
  const oneLiner = representative ? oneLinerFrom(representative) : '';
  const title = representative?.title.trim() ?? '';
  return {
    title,
    oneLiner,
    bulletPoints: bulletsFrom(ranked, MAX_BULLET_POINTS, [oneLiner, title]),
  };
}
