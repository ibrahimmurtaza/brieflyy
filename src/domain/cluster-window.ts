/**
 * How far back a Topic looks when it forms Clusters, in days.
 *
 * The glossary makes the Cluster window a per-Topic tunable, so this is the
 * default a Topic starts on rather than a value baked into the pipeline. Seven
 * days is the number the glossary names.
 */
export const DEFAULT_CLUSTER_WINDOW_DAYS = 7;

/**
 * Bounds on that tunable. A window of zero would cluster nothing at all, and a
 * window of years would put a Topic's entire history into one Cluster, so the
 * editable value is clamped to a range that still means something.
 */
export const MIN_CLUSTER_WINDOW_DAYS = 1;
export const MAX_CLUSTER_WINDOW_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The start of a Topic's Cluster window, `days` back from `now`. */
export function clusterWindowStart(now: Date, days: number): Date {
  return new Date(now.getTime() - clampClusterWindowDays(days) * DAY_MS);
}

/**
 * The nearest sane window to `days`. A Topic whose stored value is missing or
 * nonsense gets the default rather than a window that would cluster everything
 * or nothing.
 */
export function clampClusterWindowDays(days: number): number {
  if (!Number.isFinite(days)) return DEFAULT_CLUSTER_WINDOW_DAYS;
  const rounded = Math.round(days);
  if (rounded < MIN_CLUSTER_WINDOW_DAYS) return MIN_CLUSTER_WINDOW_DAYS;
  if (rounded > MAX_CLUSTER_WINDOW_DAYS) return MAX_CLUSTER_WINDOW_DAYS;
  return rounded;
}
