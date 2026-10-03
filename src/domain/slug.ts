/**
 * How long a Topic's name may be.
 *
 * One number rather than one per form: the picker and the settings page's rename
 * are the same decision about the same thing, and a bound written out twice is a
 * bound that lets one of them accept a name the other refuses. Long enough for a
 * phrase, short enough to render on the dashboard and in a brief's subject line.
 */
export const TOPIC_TITLE_MAX_LENGTH = 80;

export function slugify(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

/**
 * Whether two titles are the same topic as far as a User is concerned.
 *
 * Deliberately *not* the slug. `slugify` throws away case, punctuation and
 * spacing, which is right for a URL and wrong for deciding whether two rows in
 * "Your topics" are the same thing: `Fusion energy` and `fusion  energy!` are
 * one idea typed twice, and both would slugify to `fusion-energy`.
 *
 * The slug is still the fallback for uniqueness, because two genuinely different
 * titles can reduce to the same one — `C++` and `C` both become `c` — and those
 * are allowed to coexist under suffixed slugs. The distinction is what this
 * function exists to draw: same idea, refused; different idea that happens to
 * collide, suffixed.
 */
export function titleKey(input: string): string {
  return input
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}
