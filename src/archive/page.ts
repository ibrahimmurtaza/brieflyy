import { ARCHIVE_RESULT_LIMIT, type ArchiveViewer } from '../services/archive-search-service.js';
import { ARCHIVE_SEARCH_PATH, clusterAnchor, layout, TIER_LABELS, type ShellAccount } from '../pages/layout.js';
import { hasDroppedWords, wordsSearched, type ArchiveSearchFilter } from '../domain/archive-query.js';
import { escapeHtml } from '../domain/html.js';
import type {
  ArchiveChoice,
  ArchiveFilters,
  ArchiveItemKind,
  ArchiveResultItem,
  ArchiveSearchResult,
} from '../repos/archive-repo.js';

/**
 * What one kind of Archive item is called, and where it can be read.
 *
 * One table for both, because a fifth kind added to only one of them is a result
 * that either has no label or a link to nothing, and neither failure is visible from
 * the index.
 *
 * An Article is read at the outlet that published it and a BriefSnapshot at the one
 * copy of the brief that was sent, so those two carry their own address. Everything
 * else is read where it is listed, on the Topic page.
 *
 * A Retired Story and a FeedbackEvent both point at the Topic rather than at the one
 * thing they are about. A Story is behind its Cluster, which is what the LivingBrief
 * shows; and a signal's Cluster is where the User pressed the button rather than what
 * they were saying about it, so there is no single thing to link to. Both carry the
 * title of what they are about, which is the half a reader can act on.
 */
const ARCHIVE_KINDS: Readonly<
  Record<ArchiveItemKind, { readonly label: string; readonly href: (item: ArchiveResultItem) => string }>
> = {
  cluster: {
    label: 'Cluster',
    href: (item) => `${topicPath(item)}#${clusterAnchor(item.id)}`,
  },
  snapshot: { label: 'Brief sent', href: (item) => `/briefs/${item.id}` },
  article: { label: 'Article', href: (item) => item.url },
  story: { label: 'Retired story', href: topicPath },
  feedback: { label: 'Feedback given', href: topicPath },
};

function topicPath(item: ArchiveResultItem): string {
  return `/topics/${item.topicSlug}`;
}

/** A date, as `YYYY-MM-DD`, for a form that takes one. */
function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** The first `limit` characters of a body, on a word boundary where there is one. */
function excerpt(body: string, limit = 220): string {
  const text = body.replace(/\s+/g, ' ').trim();
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lastSpace = cut.lastIndexOf(' ');
  return `${lastSpace > limit / 2 ? cut.slice(0, lastSpace) : cut}…`;
}

/**
 * One filter control, as a single grid child.
 *
 * The label wraps the control rather than sitting beside it, because the form is a
 * grid of columns: a label and a control as two children are two cells, and with
 * more than one column the labels and the boxes interleave.
 */
function field(input: {
  readonly name: string;
  readonly label: string;
  readonly control: string;
}): string {
  return `      <label for="archive-${input.name}">${escapeHtml(input.label)}${input.control}</label>`;
}

/**
 * A `<select>` over whatever the Archive can be narrowed by, with the current choice kept.
 *
 * One function for the Source, Entity and Topic selects rather than three: they are
 * the same control over a list of choices, and the only thing that differed between
 * them was which list they were handed — so a fourth filter would have been a fourth
 * copy of the same markup to keep in step with the other three.
 */
function choiceSelect(input: {
  readonly name: string;
  readonly label: string;
  readonly options: readonly { readonly id: string; readonly name: string }[];
  readonly chosen: string | undefined;
}): string {
  const options = input.options
    .map(
      (o) =>
        `        <option value="${escapeHtml(o.id)}"${o.id === input.chosen ? ' selected' : ''}>${escapeHtml(o.name)}</option>`,
    )
    .join('\n');
  return field({
    name: input.name,
    label: input.label,
    control: `
      <select id="archive-${input.name}" name="${input.name}">
        <option value="">Any</option>
${options}
      </select>`,
  });
}

/** A date field, keeping what was asked for so narrowing twice does not retype it. */
function dateField(name: 'from' | 'to', label: string, chosen: Date | undefined): string {
  return field({
    name,
    label,
    control: `<input id="archive-${name}" name="${name}" type="date" value="${chosen === undefined ? '' : escapeHtml(isoDay(chosen))}">`,
  });
}

/** The query string that reproduces this search, for the paging links. */
function archiveHref(filter: ArchiveSearchFilter, offset: number): string {
  const params = new URLSearchParams();
  if (filter.query !== undefined) params.set('q', filter.query);
  if (filter.from !== undefined) params.set('from', isoDay(filter.from));
  if (filter.to !== undefined) params.set('to', isoDay(filter.to));
  if (filter.source !== undefined) params.set('source', filter.source);
  if (filter.entity !== undefined) params.set('entity', filter.entity);
  if (filter.topic !== undefined) params.set('topic', filter.topic);
  if (offset > 0) params.set('offset', String(offset));
  const query = params.toString();
  return query.length === 0 ? ARCHIVE_SEARCH_PATH : `${ARCHIVE_SEARCH_PATH}?${query}`;
}

function hasAnyFilter(filter: ArchiveSearchFilter): boolean {
  return (
    filter.query !== undefined ||
    filter.from !== undefined ||
    filter.to !== undefined ||
    filter.source !== undefined ||
    filter.entity !== undefined ||
    filter.topic !== undefined
  );
}

/**
 * What the page says when a search found nothing.
 *
 * Three different answers, because "you have no Archive" and "nothing matched" and
 * "you have turned past the last page" are three states and the middle two both look
 * like the first one to a User who only reads the sentence. Which one it is: a
 * filter was set, a page was asked for past the end, or neither — and only the last
 * of those is an empty Archive.
 */
function emptyResults(input: {
  readonly filter: ArchiveSearchFilter;
  readonly offset: number;
}): string {
  if (hasAnyFilter(input.filter)) {
    return 'Nothing matched. Try fewer words, or clear a filter.';
  }
  if (input.offset > 0) {
    return "That is the end of your archive. There is nothing after this page.";
  }
  return "Nothing in your archive yet. Every brief you are sent is kept, so this fills up from your first one &mdash; your topics are where everything is now.";
}

/**
 * The outlets behind a result, named.
 *
 * Read off the filter options rather than looked up again: the options are the
 * Sources this User's Archive holds, so a Source an item came from is in them by
 * construction, and naming it here costs nothing. "Where this came from" is half of
 * what makes a result a result rather than a string.
 */
function sourceNames(
  item: ArchiveResultItem,
  sources: readonly ArchiveChoice[],
): readonly string[] {
  const byId = new Map(sources.map((s) => [s.id, s.name]));
  return item.sourceIds
    .map((id) => byId.get(id))
    .filter((name): name is string => name !== undefined);
}

function resultsList(
  items: readonly ArchiveResultItem[],
  sources: readonly ArchiveChoice[],
): string {
  return `    <ul class="results">
${items
  .map((item) => {
    const body = excerpt(item.body);
    const outlets = sourceNames(item, sources);
    const where =
      outlets.length === 0
        ? ''
        : ` &middot; ${escapeHtml(outlets.join(', '))}`;
    return `      <li>
        <p class="results__kind">${escapeHtml(ARCHIVE_KINDS[item.kind].label)} &middot; ${escapeHtml(item.topicTitle)}${where}</p>
        <p class="results__title"><a href="${escapeHtml(ARCHIVE_KINDS[item.kind].href(item))}">${escapeHtml(item.title)}</a></p>
${body === '' ? '' : `        <p class="muted">${escapeHtml(body)}</p>`}
      </li>`;
  })
  .join('\n')}
    </ul>`;
}

/**
 * Where the next and previous pages of results are, when there are any.
 *
 * Both are the same search with a different offset, so the address a User copies out
 * of the address bar is the page they are looking at. A limit with no way past it is
 * a dead end for a User whose Archive holds more than one page of itself.
 */
function paging(input: {
  readonly filter: ArchiveSearchFilter;
  readonly results: ArchiveSearchResult;
  readonly offset: number;
}): string {
  const { results, offset } = input;
  if (results.items.length === 0) return '';
  const previous = offset > 0 ? offset - ARCHIVE_RESULT_LIMIT : null;
  const next = offset + results.items.length < results.total ? offset + ARCHIVE_RESULT_LIMIT : null;
  if (previous === null && next === null) return '';
  const links = [
    previous === null
      ? ''
      : `<a class="quiet" href="${escapeHtml(archiveHref(input.filter, Math.max(previous, 0)))}" rel="prev">Newer</a>`,
    next === null
      ? ''
      : `<a class="quiet" href="${escapeHtml(archiveHref(input.filter, next))}" rel="next">Older</a>`,
  ].join('\n      ');
  return `    <p class="actions">
      ${links}
    </p>`;
}

/**
 * `/archive/search`: everything Brieflyy has delivered to this User, found by word
 * and narrowed by date, Source, Entity and Topic.
 *
 * The form and the results are one page rather than a form that posts to a different
 * address, because a search is a GET: the URL a User is looking at is the search
 * they ran, so it survives a reload, can be shared, and can be reached from the
 * header's box on every other page without a second implementation of the same
 * request.
 */
export function archiveSearchPage(input: {
  readonly account: ShellAccount;
  readonly viewer: ArchiveViewer;
  readonly filter: ArchiveSearchFilter;
  readonly filters: ArchiveFilters;
  readonly results: ArchiveSearchResult;
  readonly offset: number;
  /** How far back this tier reaches, or null when it reaches all of it. */
  readonly retentionDays: number | null;
}): string {
  const { filter, filters, results, offset } = input;

  // Said on the page rather than left for the User to infer, because "nothing
  // matched" and "your last thirty days are not searchable" are different answers
  // and a silent one reads as the first.
  const notes: string[] = [];
  if (input.retentionDays !== null) {
    notes.push(
      `    <p class="muted">Your archive reaches back the last ${input.retentionDays} days. Every brief you have been sent is here regardless of how old it is.</p>`,
    );
  }
  if (filter.query !== undefined && hasDroppedWords(filter.query)) {
    notes.push(
      `    <p class="muted">Searched the first ${wordsSearched(filter.query).length} words. Narrow the search to look at the rest.</p>`,
    );
  }

  const body = results.items.length === 0
    ? `    <div class="empty-state">
      <p class="muted">${emptyResults({ filter, offset })}</p>
      <p class="empty-state__actions"><a href="/topics">Your topics</a>${
        offset > 0
          ? ` <a href="${escapeHtml(archiveHref(filter, 0))}" rel="prev">Back to the newest</a>`
          : ''
      }</p>
    </div>`
    : `    <p class="plan">${
        results.total === results.items.length
          ? `${results.total} result${results.total === 1 ? '' : 's'}`
          : `Showing ${offset + 1}&ndash;${offset + results.items.length} of ${results.total}`
      }</p>
${resultsList(results.items, filters.sources)}
${paging({ filter, results, offset })}`;

  return layout({
    title: 'Archive search',
    width: 'form',
    account: input.account,
    activeHref: ARCHIVE_SEARCH_PATH,
    body: `    <h1>Archive search</h1>
    <p class="lede">Search everything Brieflyy has delivered to you, by word or topic.</p>
    <p class="plan">${escapeHtml(TIER_LABELS[input.viewer.tier])}</p>
    <form class="archive-search" method="GET" action="${ARCHIVE_SEARCH_PATH}" role="search">
${choiceSelect({ name: 'source', label: 'Source', options: filters.sources, chosen: filter.source })}
${choiceSelect({ name: 'entity', label: 'Entity', options: filters.entities, chosen: filter.entity })}
${choiceSelect({ name: 'topic', label: 'Topic', options: filters.topics.map((t) => ({ id: t.id, name: t.title })), chosen: filter.topic })}
${dateField('from', 'From', filter.from)}
${dateField('to', 'To', filter.to)}
      <label for="archive-words">Search words</label>
      <input id="archive-words" name="q" type="search" value="${escapeHtml(filter.query ?? '')}" autofocus>
      <p class="actions"><button type="submit">Search</button> <a class="quiet" href="${ARCHIVE_SEARCH_PATH}">Clear</a></p>
    </form>
${notes.join('\n')}
${body}
    <p class="actions"><a class="button" href="/topics">Back to your topics</a></p>`,
  });
}

