import type { Topic } from './types.js';

/**
 * Which of a User's Topics this application suggests keeping, once they hold more
 * than their tier's cap allows — or null when there is nothing to suggest.
 *
 * This is the product decision the cancellation left open (ADR-0024): a User who has
 * paid for nine Topics and then is not paying holds a number the free cap does not
 * allow, and something has to give. The answer is not a rule nobody wrote down — it
 * is stated, on the Subscription settings page, with the User's own list on it, and
 * the User may answer with a different one.
 *
 * **The most recently added keep working.** The Topics somebody added last are the
 * ones they have just been reading, and the oldest are the ones most likely to have
 * lapsed; a downgrade that removed the current reading list would be the plan that
 * most surprised the User it was written for. Where two Topics share a `createdAt` —
 * a batch submitted in one submission is written in one transaction against one
 * clock — the later id wins, so the suggestion is the same list however the database
 * happened to return them.
 *
 * **A list, not a pair.** Everything the User holds that is not in it is what
 * stops, so a second list of the same Topics would be a copy of this one to keep in
 * step with it — and the page shows the whole split anyway, as boxes that are ticked
 * and boxes that are not.
 *
 * Null rather than an empty answer for a User within the cap, because "keep all of
 * them" is not a suggestion and rendering one would put a question in front of a User
 * with nothing to answer. Only a User genuinely over the cap is asked, and asking
 * them at the cap is how a page ends up nagging about a state they are in perfectly
 * well.
 *
 * It is a suggestion and nothing acts on it. What actually happens is what the User
 * submits, and nothing at all happens until they do (ADR-0025).
 */
export function planTopicReduction(
  topics: readonly Topic[],
  cap: number,
): readonly Topic[] | null {
  // An uncapped tier is not over anything. Said rather than left to the comparison
  // below, because `Infinity` is a legal cap for a reader of this signature and the
  // comparison would quietly return a suggestion that stops every Topic.
  if (!Number.isFinite(cap)) return null;
  if (topics.length <= cap) return null;

  const newestFirst = [...topics].sort(
    (a, b) => b.createdAt.getTime() - a.createdAt.getTime() || b.id.localeCompare(a.id),
  );
  const keeping = new Set(newestFirst.slice(0, cap).map((topic) => topic.id));
  // In the order they arrived, which is `listByUser`'s: the page lists a User's
  // Topics the way their topic list already does, and a second ordering here would
  // make the same Topics read as a different story.
  return topics.filter((topic) => keeping.has(topic.id));
}
