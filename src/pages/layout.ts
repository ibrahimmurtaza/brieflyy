import { escapeHtml } from '../domain/html.js';
import type { DeliverySlot } from '../domain/delivery-slot.js';
import type { Tier } from '../domain/types.js';
import { requestTokenInput } from '../http/request-token.js';
import { EMAIL_BRIEFS_PATH } from '../services/unsubscribe-links.js';
import { formatHumanTime } from './human-time.js';
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

/**
 * When this User's next brief arrives.
 *
 * Three states, because a header that promised a brief which will not arrive is
 * worse than one that says nothing, and because a User who has not chosen a
 * delivery time has not missed anything:
 *
 * - `stopped` — they have asked to stop every brief. There is no next brief, and
 *   the header says so with a link to the page that changes it back.
 * - `unset` — they have not set a DeliveryTime yet, so nothing is scheduled.
 * - `scheduled` — the DeliverySlot their DeliveryTime next falls on, and the zone
 *   to read it in. The zone is carried rather than formatted here because a time
 *   without one is a claim without a frame, and the User's own zone is the only
 *   frame they can check it against.
 */
export type ShellBrief =
  | { readonly kind: 'stopped' }
  | { readonly kind: 'unset' }
  | {
      readonly kind: 'scheduled';
      readonly slot: DeliverySlot;
      readonly timezone: string;
    };

/**
 * Who is signed in, as the shell states it.
 *
 * The email, the tier and the next brief are the three things a User cannot work
 * out for themselves without leaving the page they are on, which is what makes
 * them the header's job rather than any one screen's. They are read once per
 * request by `resolveShellAccount` in `./shell.ts` so two pages cannot disagree
 * about them.
 */
export interface ShellAccount {
  readonly email: string;
  readonly tier: Tier;
  readonly brief: ShellBrief;
}

export interface LayoutInput {
  /** The page's own name. The product name is appended by `layout`. */
  readonly title: string;
  /** The inside of `<main>`, already escaped by the caller. */
  readonly body: string;
  readonly width?: PageWidth;
  /**
   * The signed-in User, or null for a page an anonymous visitor can reach.
   *
   * Required rather than optional because supplying it is what puts the
   * navigation, the account summary and the sign-out control on the page, and
   * leaving it out would silently produce a page a signed-in User cannot leave.
   * A page with no signed-in User has to say so.
   */
  readonly account: ShellAccount | null;
  /** The href of the current page, marked `aria-current` in the navigation. */
  readonly activeHref?: string | null;
  /** Markup emitted after `</main>`. Used only by the two pages with a script. */
  readonly afterMain?: string;
  /**
   * The token every POST form on this page echoes, and which the cookie the
   * application set has to agree with. Null where the page has no signed-in
   * User, and so renders no form that submits anything.
   *
   * Optional rather than required because a page that cannot sign a User in —
   * the sign-in page, an expired link — has no form to refuse, and asking for
   * a token it has no use for would be a page carrying a secret for nothing.
   * A signed-in page that forgot this would render its forms without the token
   * and the guard would refuse them, which is a loud failure rather than a
   * silent one.
   */
  readonly requestToken?: string | null;
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
 *
 * "Email briefs" is here for the same reason: every brief carries unsubscribe
 * links, and a link that can only turn something off without any way to turn it
 * back on is not a control. The confirmation page those links land on points
 * straight at this.
 *
 * "Discover" is here because it is the only way to a new Topic from anywhere.
 * The two list pages are where a User manages what they already have; a User who
 * wants a fourth thing has to go looking for it, and finding it only from an
 * empty state or a paywall means the empty state and the paywall are the two
 * screens that decide it.
 *
 * "Trends" is here because the trends view is a paid differentiator, and a
 * differentiator nobody can find is not one. It is the across-your-topics page
 * rather than a per-Topic one, because the navigation has no Topic to be relative
 * to; the per-Topic trends page is reached from the LivingBrief and from this one.
 */
export const PRIMARY_NAV: readonly NavLink[] = [
  { href: '/topics', label: 'Topics' },
  { href: '/pick-topics', label: 'Manage topics' },
  { href: '/discover', label: 'Discover' },
  { href: '/trends', label: 'Trends' },
  { href: '/archive/search', label: 'Archive' },
  { href: EMAIL_BRIEFS_PATH, label: 'Email briefs' },
  { href: '/settings/delivery', label: 'Delivery time' },
];

const FOOTER = 'Aggregated, clustered, summarised. One brief per topic, every day.';

/**
 * Where one Cluster sits on the LivingBrief, so something else can link to it.
 *
 * The trends page annotates a spike with the Clusters that arrived on that day, and
 * each annotation is only worth having if it goes somewhere: a marker that says a
 * jump was caused by something nobody can read is a hint rather than a link. Both
 * pages go through this one function so the id a link is built from and the id the
 * LivingBrief renders cannot drift apart.
 */
export function clusterAnchor(clusterId: string): string {
  return `cluster-${clusterId}`;
}

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
  const account = input.account;

  const header = renderHeader({
    account,
    nav: account === null ? null : PRIMARY_NAV,
    activeHref: input.activeHref ?? null,
    width,
    requestToken: input.requestToken ?? null,
  });
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

/**
 * How a tier reads on screen.
 *
 * One table, because the topic list, the upgrade page and this header all name
 * the tier, and two spellings of it is one more thing a reader of a screenshot
 * has to reconcile. Exported so the pages that name it read this and not their
 * own spelling of the same word.
 */
export const TIER_LABELS: Readonly<Record<Tier, string>> = {
  free: 'Free plan',
  paid: 'Paid plan',
};

/**
 * The one line that says which tier this User is on and how much of it they use.
 *
 * Two pages needed it and would otherwise have written it twice: the topic list
 * and the DiscoverTab. They read the same three facts — the tier's own name from
 * the table above, how many Topics are held, and the cap that allows — and the
 * only thing that differs is whether a cap exists to count down. So the count is
 * assembled here, once, and a page that names the tier differently cannot.
 *
 * The separator is a literal `&middot;` because the parts are escaped and the
 * punctuation between them is not markup.
 */
export function planLine(input: {
  readonly tier: Tier;
  readonly heldCount: number;
  readonly cap: number;
}): string {
  const count = Number.isFinite(input.cap)
    ? `${input.heldCount} of ${input.cap} topics`
    : `${input.heldCount} topics`;
  return `${escapeHtml(TIER_LABELS[input.tier])} &middot; ${count}`;
}

/**
 * What the header says about the brief that is coming, and where to change it.
 *
 * A User who has stopped their emails is told that, with the page that turns them
 * back on, rather than being shown a time for a brief that is not coming. A User
 * with no delivery time is offered the setting rather than an absence. Both link
 * rather than only saying, because the header is the one piece of a page that is
 * on every page and so is the one piece a User can act on from anywhere.
 */
function renderBriefFact(brief: ShellBrief): string {
  if (brief.kind === 'stopped') {
    return `<p class="account__brief"><a href="${escapeHtml(
      EMAIL_BRIEFS_PATH,
    )}">Briefs are off &mdash; turn them back on</a></p>`;
  }
  if (brief.kind === 'unset') {
    return `<p class="account__brief"><a href="/settings/delivery">No delivery time set</a></p>`;
  }
  const when = formatHumanTime(brief.slot, brief.timezone);
  return `<p class="account__brief">Next brief ${escapeHtml(when)} (${escapeHtml(
    brief.timezone,
  )})</p>`;
}

/**
 * The search box every signed-in page carries, and where it leads.
 *
 * The Archive is the one thing a User reaches for from anywhere, and a control that
 * only exists on the Archive's own results page is a control they have to already be
 * on. It is in the header rather than in the navigation because it is a control and
 * not a place: seven links already wrap onto two rows on a phone, and a seventh
 * shape of "go somewhere" beside a box would be one more thing to read past.
 *
 * A GET, so a search is a link a User can share, bookmark or come back to, and so
 * the results page works with no JavaScript at all. It takes `q`, the same field the
 * results page's own form takes, so arriving here from the box and then narrowing it
 * further is one form rather than two that have to be kept in step.
 *
 * Named "Search archive" rather than "Search" because the results page has a second
 * button of its own called exactly that, and two controls with one name are one
 * control to anyone reading the page aloud.
 *
 * Only rendered for a signed-in User: the Archive is theirs, and an empty box that
 * answers "nothing to search" to a visitor who has nothing to search is a control
 * that cannot do anything.
 */
export const ARCHIVE_SEARCH_PATH = '/archive/search';

function renderArchiveSearch(): string {
  return `    <form class="shell-search" method="GET" action="${ARCHIVE_SEARCH_PATH}" role="search">
      <label class="visually-hidden" for="shell-search-q">Search your archive</label>
      <input id="shell-search-q" name="q" type="search" placeholder="Search your archive" autocomplete="off">
      <button class="quiet" type="submit">Search archive</button>
    </form>`;
}

function renderHeader(input: {
  readonly account: ShellAccount | null;
  readonly nav: readonly NavLink[] | null;
  readonly activeHref: string | null;
  readonly width: PageWidth;
  readonly requestToken: string | null;
}): string {
  // The wordmark goes to `/`, which redirects to `/signup` for an anonymous
  // visitor, so the one link that is always safe is the one always rendered.
  const wordmark = `<a class="wordmark" href="/">Brieflyy</a>`;
  const { account, nav } = input;
  if (account === null || nav === null) {
    return `<header class="site-header">
  <div class="site-header__inner site-header__inner--${input.width}">${wordmark}</div>
</header>`;
  }
  const links = nav
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
${renderArchiveSearch()}
    <div class="account">
      <div class="account__who">
        <span class="account__email">${escapeHtml(account.email)}</span>
        <span class="account__tier">${escapeHtml(TIER_LABELS[account.tier])}</span>
      </div>
      ${renderBriefFact(account.brief)}
      <form class="logout" method="POST" action="/auth/logout">${input.requestToken ? requestTokenInput(input.requestToken) : ''}<button class="quiet" type="submit">Sign out</button></form>
    </div>
  </div>
</header>`;
}

function renderFooter(): string {
  return `<footer class="site-footer">
  <div class="site-footer__inner"><p>${escapeHtml(FOOTER)}</p></div>
</footer>`;
}
