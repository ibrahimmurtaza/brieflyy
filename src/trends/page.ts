import { escapeHtml } from '../domain/html.js';
import { OBSERVATION_DAYS, articlesOn } from '../domain/trends.js';
import type {
  EmergingEntity,
  Topic,
  TopicTrend,
  TrendsRollup,
} from '../domain/types.js';
import { layout, clusterAnchor, type ShellAccount } from '../pages/layout.js';
import { volumeChartSvg, sparklineSvg } from './chart.js';

/** Where the trends pages live, so the navigation and the links agree. */
export const TRENDS_PATH = '/trends';

export interface TrendsPageInput {
  readonly account: ShellAccount;
  readonly topic: Topic;
  readonly topicSlug: string;
  readonly trend: TopicTrend;
  /**
   * The Clusters the annotations name, by id, with the one-liner each is shown
   * with. A Cluster outside the Topic's own window is no longer retained, so an
   * annotation can name an id that is not in here — see `spikeList`.
   */
  readonly clustersById: ReadonlyMap<string, string>;
  /**
   * How many days this User's tier allows, or null for all of them. The page is
   * told rather than asked, so it can say what it is showing instead of deciding
   * for itself what it is allowed to show.
   */
  readonly historyDays: number | null;
  readonly requestToken?: string | null;
}

/**
 * One Topic's trends: what is getting louder, and what caused it.
 *
 * The chart is the headline and the list under it is the part that can be acted
 * on: every annotated day names the Clusters that arrived on it, and each of those
 * links into the LivingBrief where the Cluster is written out in full. A trend
 * that only said a number had gone up would be something a User could do nothing
 * with at six in the morning.
 */
export function trendsPage(input: TrendsPageInput): string {
  const { account, topic, topicSlug, trend } = input;
  const liveBriefHref = `/topics/${encodeURIComponent(topicSlug)}`;
  const days = trend.volumeOverTime.length;
  const empty = trend.volumeOverTime.every((point) => articlesOn(point) === 0);

  return layout({
    title: `${topic.title} trends`,
    width: 'reading',
    account,
    activeHref: TRENDS_PATH,
    requestToken: input.requestToken ?? null,
    body: `    <h1>${escapeHtml(topic.title)} trends</h1>
    <p class="lede">What is getting louder in this topic, and what caused it.</p>
    <p class="plan">${historyNote(input.historyDays, days)}</p>
    <p class="actions"><a class="button secondary" href="${escapeHtml(liveBriefHref)}">Back to the living brief</a></p>
    <section>
      <h2>Mention volume per day</h2>
      ${empty ? emptyChartNote() : chartBlock(input)}
    </section>
    <section>
      <h2>What is emerging</h2>
      ${entityList(trend)}
    </section>`,
  });
}

/**
 * The chart, its key, and the annotations that explain the jumps in it.
 *
 * Three things rather than one because they answer three different questions:
 * what the shape was, which line is which, and what happened on the days it is not
 * flat. An SVG cannot carry a link a screen reader will offer, so the annotations
 * are also a list.
 *
 * The last day on the chart is today, and today is not over. Saying so is the
 * difference between a chart whose final point looks like a collapse and one whose
 * final point is honestly incomplete; the window ends at the instant the trend was
 * measured, so the very first and very last buckets are partial days.
 */
function chartBlock(input: TrendsPageInput): string {
  const { trend } = input;
  const first = trend.volumeOverTime[0]?.date ?? '';
  const last = trend.volumeOverTime[trend.volumeOverTime.length - 1]?.date ?? '';
  return `      <p class="hint">Articles published and Stories formed, ${escapeHtml(first)} to ${escapeHtml(last)} (UTC). The last day is still being written.</p>
      ${volumeChartSvg({
        volume: trend.volumeOverTime,
        spikeDates: trend.spikes.map((s) => s.date),
      })}
      <ul class="legend">
        <li><span class="legend__swatch legend__swatch--articles" aria-hidden="true"></span>Articles</li>
        <li><span class="legend__swatch legend__swatch--stories" aria-hidden="true"></span>Stories</li>
      </ul>
      ${spikeList(input)}
      ${volumeTable(trend)}`;
}

/**
 * What happened on each day the chart jumps.
 *
 * Every Cluster is named and every one is a link, because a spike with three causes
 * and two links is a hint rather than an answer — the User cannot tell which of the
 * three they are being pointed at.
 *
 * A Cluster that is no longer there is counted rather than dropped. Silently
 * shortening the annotation would leave a User reading "1 cluster" for a day three
 * things arrived and with no way to know why; a note that says one of them is no
 * longer available tells them the difference between "we have hidden it" and "it
 * never happened".
 */
function spikeList(input: TrendsPageInput): string {
  const { trend, clustersById, topicSlug } = input;
  if (trend.spikes.length === 0) {
    return `      <p class="hint">No day stood out in this period.</p>`;
  }
  const liveBriefHref = `/topics/${encodeURIComponent(topicSlug)}`;
  const items = trend.spikes
    .map((spike) => {
      const known = spike.clusterIds.filter((id) => clustersById.has(id));
      const gone = spike.clusterIds.length - known.length;
      const links = known.map((id) => {
        const href = `${liveBriefHref}#${encodeURIComponent(clusterAnchor(id))}`;
        return `<a href="${escapeHtml(href)}">${escapeHtml(clustersById.get(id) ?? id)}</a>`;
      });
      const missing =
        gone > 0
          ? ` <span class="muted">${gone} of these ${gone === 1 ? 'is' : 'are'} no longer in this topic's window.</span>`
          : '';
      return `        <li>
          <span class="spike__date">${escapeHtml(spike.date)}</span>
          <span class="spike__size">${spike.articles} article${spike.articles === 1 ? '' : 's'}</span>
          <span class="spike__clusters">${links.join(', ')}</span>${missing}
        </li>`;
    })
    .join('\n');
  return `      <h3>What caused the jumps</h3>
      <ul class="spikes">
${items}
      </ul>`;
}

/**
 * The Entities that are getting louder, loudest first.
 *
 * The order comes from the trend, which ranked them by lift against the baseline
 * before the tier filter ran. What is printed beside each one is what this User is
 * shown: an Entity's lift and its two window counts are null for a limited tier,
 * because they describe a seven-day window and a thirty-day baseline that tier is
 * not being shown, and the counts on the row are summed from the series it does
 * have.
 */
function entityList(trend: TopicTrend): string {
  if (trend.entities.length === 0) {
    return `      <p class="hint">Nothing is emerging in this period. That is not a fault in your sources &mdash; it means the last ${OBSERVATION_DAYS} days are no louder than the month before them.</p>`;
  }
  const span = spanLabel(trend.volumeOverTime.length);
  const rows = trend.entities
    .map((entity) => {
      const mentions = entity.daily.reduce((sum, point) => sum + point.mentions, 0);
      return `        <li class="entity">
          <span class="entity__name">${escapeHtml(entity.canonicalName)}</span>
          ${sparklineSvg({ points: entity.daily })}
          <span class="entity__mentions">${mentions} mention${mentions === 1 ? '' : 's'} in ${span}</span>
          ${liftLabel(entity)}
        </li>`;
    })
    .join('\n');
  return `      <ul class="entities">
${rows}
      </ul>`;
}

/**
 * How much louder an Entity has got, or nothing when that cannot be said.
 *
 * Nothing rather than a zero and nothing rather than the figure: a null lift is
 * this User's tier declining to show the window it was measured over, and printing
 * `0×` would be a claim about the Entity rather than about the paywall.
 *
 * Takes only the two fields it reads rather than the whole Entity, so a rollup
 * entry and a per-Topic one can be labelled the same way and the two cannot come to
 * spell the same number differently.
 */
function liftLabel(entity: {
  readonly lift: number | null;
  readonly baselineMentions: number | null;
}): string {
  if (entity.lift === null || entity.baselineMentions === null) return '';
  if (entity.baselineMentions === 0) {
    return `<span class="entity__lift">New in this window</span>`;
  }
  return `<span class="entity__lift">${entity.lift.toFixed(1)}&times; more often than the baseline</span>`;
}

function spanLabel(days: number): string {
  return days === 1 ? 'the last day' : `the last ${days} days`;
}

/**
 * The numbers behind the chart.
 *
 * In a table, because a chart is a picture and a User who cannot see it has been
 * given a sentence and nothing to check that sentence against. Open rather than
 * folded away: it is the accessible alternative, and hiding the alternative behind
 * a control is how it stops existing.
 */
function volumeTable(trend: TopicTrend): string {
  const rows = trend.volumeOverTime
    .map(
      (point) =>
        `          <tr><th scope="row">${escapeHtml(point.date)}</th><td>${point.articles}</td><td>${point.stories}</td></tr>`,
    )
    .join('\n');
  return `      <table class="trend-table">
        <caption>Mention volume per day, ${trend.volumeOverTime.length} days (UTC)</caption>
        <thead><tr><th scope="col">Day</th><th scope="col">Articles</th><th scope="col">Stories</th></tr></thead>
        <tbody>
${rows}
        </tbody>
      </table>`;
}

function emptyChartNote(): string {
  return `      <div class="empty-state">
        <p class="muted">Nothing has been published about this topic in this period. Brieflyy polls your sources every half hour, so an empty Topic usually means the outlets it follows have not written about it.</p>
      </div>`;
}

/**
 * How much history this page is showing, and what the tier costs.
 *
 * "The last 3 days" and "the full 38-day history" are both stated rather than left
 * to the shape of the chart: a User who cannot see why their chart is shorter than
 * somebody else's has been given a fact and no explanation of it.
 */
function historyNote(historyDays: number | null, days: number): string {
  if (historyDays === null) {
    return `The full history &mdash; ${days} days. Recomputed hourly from stored Articles.`;
  }
  return `The last ${days} ${days === 1 ? 'day' : 'days'}. <a href="/upgrade">Upgrade</a> for the full history.`;
}

export interface RollupBlockInput {
  readonly rollup: TrendsRollup;
  /** `2` on the trends page, `3` on the dashboard, so the headings nest correctly. */
  readonly headingLevel: 2 | 3;
}

/**
 * Every Topic this User holds, added together — the Trends rollup.
 *
 * Shown on the dashboard as well as on the trends page, which is why it takes a
 * heading level: the same figures twice is the point, since "what is getting louder
 * in general" and "what is getting louder in this Topic" are asked at two different
 * scales and neither answer is a substitute for the other.
 *
 * Every entry carries the daily series its lift was measured against, so a multiple
 * on this surface is as checkable as one on the per-Topic view. A ratio with nothing
 * drawn under it is a claim a User cannot check, and that holds at this scale too.
 */
export function rollupBlock(input: RollupBlockInput): string {
  const { rollup, headingLevel } = input;
  const heading = headingLevel === 2 ? 'h2' : 'h3';
  const totals = rollup.volumeOverTime.reduce(
    (sum, point) => ({
      articles: sum.articles + point.articles,
      stories: sum.stories + point.stories,
    }),
    { articles: 0, stories: 0 },
  );
  const span = spanLabel(rollup.volumeOverTime.length);
  const items =
    rollup.entities.length === 0
      ? `        <p class="hint">Nothing is emerging across your topics right now.</p>`
      : rollup.entities
          .map((entity) => {
            // The same count the sparkline is drawn from, and named with the span
            // the rollup's own chart covers rather than the entry's: the series is
            // already cut to what this tier may see, so the two agree.
            const mentions = entity.daily.reduce((sum, point) => sum + point.mentions, 0);
            // The series belongs to the one Topic the entry is attributed to, which
            // is the Topic the lift beside it was measured in. Naming that Topic on
            // the row is what stops the days reading as a figure for every Topic.
            // Nothing is drawn for an entry with no days to draw, which is the same
            // rule the per-Topic list follows rather than a second one.
            const spark =
              entity.daily.length === 0 ? '' : sparklineSvg({ points: entity.daily });
            return `          <li class="entity">
            <span class="entity__name">${escapeHtml(entity.canonicalName)}</span>
            ${spark}
            <span class="entity__mentions">${mentions} mention${mentions === 1 ? '' : 's'} in ${span}</span>
            <span class="entity__mentions">${escapeHtml(entity.topicTitle)}</span>
            ${liftLabel(entity)}
            <a href="/topics/${encodeURIComponent(entity.topicSlug)}/trends">See trends</a>
          </li>`;
          })
          .join('\n');
  const chart =
    rollup.volumeOverTime.length === 0
      ? ''
      : volumeChartSvg({
          volume: rollup.volumeOverTime,
          spikeDates: [],
        });
  return `      <${heading}>Across your topics</${heading}>
      <p class="hint">${totals.articles} article${totals.articles === 1 ? '' : 's'} and ${totals.stories} stor${totals.stories === 1 ? 'y' : 'ies'} across ${spanLabel(rollup.volumeOverTime.length)}.</p>
      ${chart}
      <ul class="entities">
${items}
      </ul>`;
}

export interface TrendsOverviewInput {
  readonly account: ShellAccount;
  readonly topics: readonly Topic[];
  readonly rollup: TrendsRollup;
  readonly historyDays: number | null;
  readonly requestToken?: string | null;
}

/**
 * `/trends`: the across-your-topics view, and the way into each Topic's own.
 *
 * The per-Topic trends are the detailed answer and this is the summary one, so the
 * two are on the same page with the links between them rather than two pages a User
 * has to know the difference between. It exists at all because the shell
 * navigation has no Topic to be relative to: a per-Topic page cannot be a
 * navigation entry, so without this the trends view would be reachable only from
 * the LivingBrief.
 */
export function trendsOverviewPage(input: TrendsOverviewInput): string {
  const { account, topics, rollup } = input;
  const rows =
    topics.length === 0
      ? `        <li class="empty-state"><span class="muted">You have no topics yet, so there is nothing to chart. <a href="/pick-topics">Pick your topics</a>.</span></li>`
      : topics
          .map(
            (t) => `        <li>
          <a href="/topics/${encodeURIComponent(t.slug)}/trends">${escapeHtml(t.title)}</a>
          <a href="/topics/${encodeURIComponent(t.slug)}" class="muted">living brief</a>
        </li>`,
          )
          .join('\n');
  return layout({
    title: 'Trends',
    width: 'reading',
    account,
    activeHref: TRENDS_PATH,
    requestToken: input.requestToken ?? null,
    body: `    <h1>Trends</h1>
    <p class="lede">What is getting louder across every topic you follow.</p>
    <p class="plan">${historyNote(input.historyDays, rollup.volumeOverTime.length)}</p>
${topics.length === 0 ? '' : rollupBlock({ rollup, headingLevel: 2 })}
    <section>
      <h2>Each topic</h2>
      <ul class="topics">
${rows}
      </ul>
    </section>`,
  });
}