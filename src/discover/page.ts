import { escapeHtml } from '../domain/html.js';
import type { TopicCategory } from '../domain/types.js';
import { layout, planLine, type ShellAccount } from '../pages/layout.js';
import type {
  DirectoryEntry,
  DiscoverService,
  Recommendation,
  TrendingEntry,
} from '../services/discover-service.js';

/** How the Directory is grouped, in the order a User reads it. */
const CATEGORY_ORDER: readonly Exclude<TopicCategory, 'unspecified'>[] = [
  'news',
  'technology',
  'science',
  'business',
  'policy',
];

const FIRST_RUN_PATH = '/onboarding/pick-topics';
const ADD_PATH = '/discover/add';

export interface DiscoverPageInput {
  readonly account: ShellAccount;
  readonly discover: DiscoverService;
  /** A refusal from a submission, said in words rather than as a status code. */
  readonly message?: string | undefined;
}

/**
 * The DiscoverTab: where a User finds their next Topic.
 *
 * Three lists, in the order a User would ask for them. What is like what they
 * already read, what everyone is reading, and then the whole Directory. Each is
 * omitted rather than shown empty when it has nothing to say — a heading with
 * nothing under it is a claim, and the claim would be false.
 *
 * The Add control is per card and clones one entry. The onboarding screen's
 * "choose exactly three" is a rule about a checkbox form, and the DiscoverTab is
 * not that form: a User reading a Directory picks the card they are looking at.
 */
export function discoverPage(input: DiscoverPageInput): string {
  const { account, discover } = input;
  const atCap = discover.isAtCap();
  const hasTopics = discover.heldCount > 0;

  const lede = hasTopics
    ? 'Find another topic to follow. Every entry here starts a brief of its own.'
    : 'Find your first topic to follow. Every entry here starts a brief of its own.';

  const messageHtml = input.message
    ? `    <div class="error-summary" role="alert">
      <p>${escapeHtml(input.message)}</p>
    </div>`
    : '';

  const paywallHtml = atCap
    ? `    <div class="callout callout--paywall">You have reached the free-topic limit (${
        discover.cap
      }). <a href="/upgrade">Upgrade</a> to add more, or <a href="/pick-topics">remove one</a> to pick a replacement.</div>`
    : '';

  const emptyStateHtml = hasTopics
    ? ''
    : `    <div class="empty-state">
      <p class="muted">You haven't picked any topics yet, so there is nothing to compare these against. <a href="${FIRST_RUN_PATH}">Pick your topics</a> and this page will suggest the ones that overlap.</p>
    </div>`;

  const body = [
    '    <h1>Discover</h1>',
    `    <p class="lede">${escapeHtml(lede)}</p>`,
    `    <p class="plan">${planLine({
      tier: account.tier,
      heldCount: discover.heldCount,
      cap: discover.cap,
    })}</p>`,
    messageHtml,
    paywallHtml,
    emptyStateHtml,
    renderRecommendations(discover.getRecommendations()),
    renderTrending(discover.getTrending(), discover.windowDays),
    renderDirectory(discover.getDirectory()),
  ]
    .filter((part) => part.length > 0)
    .join('\n');

  return layout({
    title: 'Discover',
    width: 'reading',
    account,
    activeHref: '/discover',
    body,
  });
}

function renderRecommendations(recs: readonly Recommendation[]): string {
  if (recs.length === 0) return '';
  const items = recs
    .map(
      (r) => `        <li class="cluster">
          <h3>${escapeHtml(r.template.title)}</h3>
          <p class="muted">${escapeHtml(r.template.blurb)}</p>
          <p class="hint">${escapeHtml(overlapReason(r))}</p>
        </li>`,
    )
    .join('\n');
  return `    <section>
      <h2>Topics like yours</h2>
      <p class="hint">Directory entries that share sources or entities with the topics you already follow.</p>
      <ul class="topics">
${items}
      </ul>
    </section>`;
}

/**
 * Why this entry was suggested, in the words the score was built from.
 *
 * A number with no units is a ranking nobody can argue with, so the two kinds of
 * overlap are named and counted separately: an Entity is one named thing, while a
 * Source is an outlet that writes about everything, and the two are worth
 * different amounts of the same point.
 */
function overlapReason(rec: Recommendation): string {
  const parts: string[] = [];
  if (rec.sharedEntityIds.length > 0) {
    parts.push(plural(rec.sharedEntityIds.length, 'entity', 'entities'));
  }
  if (rec.sharedSourceIds.length > 0) {
    parts.push(plural(rec.sharedSourceIds.length, 'source'));
  }
  return `Recommended because it shares ${parts.join(' and ')} with your topics.`;
}

/**
 * The trending section, headed with the window the numbers came from.
 *
 * Not the words "this week": those would be a second, vaguer answer to the same
 * question the heading answers with a number, and widening the window would leave
 * it asserting a period the query no longer covers. Each item therefore carries
 * the count alone and lets the heading it sits under carry the period.
 */
function renderTrending(
  entries: readonly TrendingEntry[],
  windowDays: number,
): string {
  if (entries.length === 0) return '';
  const items = entries
    .map(
      (t) => `        <li class="cluster">
          <h3>${escapeHtml(t.template.title)}</h3>
          <p class="muted">${escapeHtml(t.template.blurb)}</p>
          <p class="hint">${plural(t.mentionCount, 'article')}</p>
        </li>`,
    )
    .join('\n');
  return `    <section>
      <h2>Trending in the last ${windowDays} days</h2>
      <p class="hint">How much has been published by the sources these entries follow.</p>
      <ul class="topics">
${items}
      </ul>
    </section>`;
}

/** `1 article`, `3 articles`. The singular spelled out rather than left to `0 articles`. */
function plural(count: number, one: string, many: string = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The Directory, grouped by the category each entry was curated under.
 *
 * `CATEGORY_ORDER` covers every category a TopicTemplate can carry — the type
 * excludes `unspecified`, which is a free-form Topic's sentinel and never a
 * Directory entry — so the filter below drops nothing. `directory/seed.test.ts`
 * asserts that every category is represented, which is what stops an empty
 * category from looking like a broken picker.
 */
function renderDirectory(entries: readonly DirectoryEntry[]): string {
  if (entries.length === 0) {
    return `    <section>
      <h2>Directory</h2>
      <div class="empty-state">
        <p class="muted">You already follow every topic in the Directory. <a href="/pick-topics">Manage your topics</a>, or <a href="/upgrade">upgrade</a> for more.</p>
      </div>
    </section>`;
  }
  const grouped = new Map<Exclude<TopicCategory, 'unspecified'>, DirectoryEntry[]>();
  for (const entry of entries) {
    const list = grouped.get(entry.template.category);
    if (list) list.push(entry);
    else grouped.set(entry.template.category, [entry]);
  }
  const sections = CATEGORY_ORDER.filter((c) => grouped.has(c))
    .map((category) => {
      const cards = (grouped.get(category) ?? [])
        .map(directoryCard)
        .join('\n        ');
      return `      <section>
        <h3>${escapeHtml(category)}</h3>
        <div class="grid">
        ${cards}
        </div>
      </section>`;
    })
    .join('\n');
  return `    <section>
      <h2>Directory</h2>
${sections}
    </section>`;
}

/**
 * One card, with the control the User can act on.
 *
 * No control at all where there is nothing to press: a disabled button on every
 * card is a wall of controls that do nothing, and the paywall above has already
 * said what to do instead. Whether it can be cloned is the service's answer, which
 * already accounts for the tier cap, so the page does not ask a second question
 * and risk a second opinion.
 */
function directoryCard(entry: DirectoryEntry): string {
  const t = entry.template;
  const control = entry.canClone
    ? `          <form method="POST" action="${ADD_PATH}">
            <input type="hidden" name="templateId" value="${escapeHtml(t.id)}">
            <button class="secondary" type="submit">Add</button>
          </form>`
    : '';
  return `        <div class="card card--entry">
          <span class="title">${escapeHtml(t.title)}</span>
          <span class="blurb">${escapeHtml(t.blurb)}</span>
          <span class="card__note">${plural(t.defaultSourceIds.length, 'source')}</span>
${control}
        </div>`;
}