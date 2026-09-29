import { escapeHtml } from '../domain/html.js';
import { STYLESHEET } from './styles.js';

/**
 * How wide a page's content is allowed to get. The application used to carry six
 * different `max-width` values across sixteen page functions, so the visual
 * difference between two screens was a fact about which file they were in
 * rather than a decision anyone had made.
 */
export type PageWidth = 'narrow' | 'form' | 'default' | 'reading';

export interface NavLink {
  readonly href: string;
  readonly label: string;
}

export interface LayoutInput {
  /** The page's own name. The product name is appended by `layout`. */
  readonly title: string;
  /** The inside of `<main>`, already escaped by the caller. */
  readonly body: string;
  readonly width?: PageWidth;
  /**
   * The signed-in account's email, or null for a page an anonymous visitor can
   * reach. Supplying it is what puts the navigation and the sign-out control on
   * the page: they are account furniture, not page furniture.
   */
  readonly account?: string | null;
  readonly nav?: readonly NavLink[] | null;
  /** The href of the current page, marked `aria-current` in the navigation. */
  readonly activeHref?: string | null;
  /** Markup emitted after `</main>`. Used only by the two pages with a script. */
  readonly afterMain?: string;
}

/**
 * The navigation a signed-in user gets on every page. Five separate
 * implementations used to coexist, one of which left `/archive/search` with no
 * way out of the application at all.
 *
 * "Manage topics" is in here rather than repeated on the pages that used to
 * carry it. It was a link on `/topics` and on the LivingBrief, and dropping it
 * when those pages lost their per-page nav left `/pick-topics` reachable only
 * from the empty state and the paywall: a User who already had topics and was
 * under the cap had no way to add or remove one.
 */
export const PRIMARY_NAV: readonly NavLink[] = [
  { href: '/topics', label: 'Topics' },
  { href: '/pick-topics', label: 'Manage topics' },
  { href: '/archive/search', label: 'Archive' },
  { href: '/settings/delivery', label: 'Delivery time' },
];

const FOOTER = 'Aggregated, clustered, summarised. One brief per topic, every day.';

/**
 * The whole HTML document, from one place.
 *
 * Every page gets the same `<head>`, the same stylesheet, a skip link, landmark
 * elements and a viewport tag. The viewport tag in particular used to appear on
 * two of sixteen pages, which meant the entire onboarding funnel laid out at a
 * nominal 980px on a phone.
 */
export function layout(input: LayoutInput): string {
  const width = input.width ?? 'default';
  const account = input.account ?? null;
  const nav = account === null ? null : input.nav ?? PRIMARY_NAV;

  const header = renderHeader({ account, nav, activeHref: input.activeHref ?? null, width });
  const footer = renderFooter();

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(input.title)} &middot; Brieflyy</title>
  <style>${STYLESHEET}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to content</a>
  ${header}
  <main id="main" class="page page--${width}">
${input.body}
  </main>
  ${footer}${input.afterMain ?? ''}
</body>
</html>`;
}

function renderHeader(input: {
  readonly account: string | null;
  readonly nav: readonly NavLink[] | null;
  readonly activeHref: string | null;
  readonly width: PageWidth;
}): string {
  // The wordmark goes to `/`, which redirects to `/signup` for an anonymous
  // visitor, so the one link that is always safe is the one always rendered.
  const wordmark = `<a class="wordmark" href="/">Brieflyy</a>`;
  if (input.nav === null) {
    return `<header class="site-header">
  <div class="site-header__inner site-header__inner--${input.width}">${wordmark}</div>
</header>`;
  }
  const links = input.nav
    .map((link) => {
      const current = link.href === input.activeHref ? ' aria-current="page"' : '';
      return `<a href="${escapeHtml(link.href)}"${current}>${escapeHtml(link.label)}</a>`;
    })
    .join('\n      ');
  return `<header class="site-header">
  <div class="site-header__inner site-header__inner--${input.width}">
    ${wordmark}
    <nav class="site-nav" aria-label="Primary">
      ${links}
    </nav>
    <div class="account">
      <span class="account__email">${escapeHtml(input.account ?? '')}</span>
      <form class="logout" method="POST" action="/auth/logout"><button class="quiet" type="submit">Sign out</button></form>
    </div>
  </div>
</header>`;
}

function renderFooter(): string {
  return `<footer class="site-footer">
  <div class="site-footer__inner"><p>${escapeHtml(FOOTER)}</p></div>
</footer>`;
}
