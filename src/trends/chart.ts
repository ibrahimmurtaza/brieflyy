import { escapeHtml } from '../domain/html.js';
import { articlesOn } from '../domain/trends.js';
import type { TrendVolumePoint } from '../domain/types.js';

/**
 * The two shapes a chart takes on this page, drawn as inline SVG.
 *
 * Inline rather than as an image or a canvas because the numbers behind them are
 * the data: an `<img>` would be a picture of a trend with nothing a User could
 * read, a canvas would need a parallel table to be readable at all, and inline SVG
 * is markup — it scales with the reader's text size, it prints, and it can carry
 * an accessible name. No chart library, because the whole of what is drawn here is
 * two polylines and a set of tick marks.
 */

interface Box {
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
}

/** Width, height and the inset the plot is drawn inside. */
interface Geometry {
  readonly width: number;
  readonly height: number;
  readonly box: Box;
}

/** Enough room for a y-axis label, the day numbers and the first/last date. */
const VOLUME_BOX: Box = { left: 40, right: 16, top: 14, bottom: 26 };
const VOLUME: Geometry = { width: 720, height: 240, box: VOLUME_BOX };
/** No labels, no axis: a sparkline is a shape, and the numbers are in the row. */
const SPARK_BOX: Box = { left: 1, right: 1, top: 2, bottom: 2 };
const SPARK: Geometry = { width: 120, height: 24, box: SPARK_BOX };

/** The tallest point of a series, which is the top of the axis. Never zero. */
function peakOf(values: readonly number[]): number {
  return Math.max(1, ...values);
}

/**
 * Where each day of the series sits.
 *
 * Both divisions are guarded, and both guards are cases that actually occur: a
 * Topic measured for a single day, and a Topic nobody has written about yet. An
 * unguarded division puts `NaN` into a coordinate, which a browser renders as
 * nothing at all — so the chart silently loses the very spike it was drawn to show.
 */
function place(values: readonly number[], g: Geometry): readonly { x: number; y: number }[] {
  const span = g.width - g.box.left - g.box.right;
  const height = g.height - g.box.top - g.box.bottom;
  const count = values.length;
  const max = peakOf(values);
  return values.map((value, i) => ({
    x: g.box.left + (count <= 1 ? span / 2 : (i / (count - 1)) * span),
    y: g.box.top + height - (value / max) * height,
  }));
}

/**
 * The round number nearest a magnitude, from the 1/2/5 series every axis on a
 * printed chart is drawn in. A raw maximum put on an axis is an axis nobody can
 * read a value off: a peak of 23 becomes a top line labelled 23, and the gridline
 * under it would be 4.6.
 */
function niceStep(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 1;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const normalized = raw / magnitude;
  const step = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 5 ? 5 : 10;
  return step * magnitude;
}

/**
 * The values the axis is labelled at, from zero to the peak and no further.
 *
 * Bounded at twelve so a malformed peak cannot turn the axis into a wall of
 * labels: the loop is guarded rather than trusted, because the peak is read off
 * stored data and stored data is what a chart is supposed to survive.
 */
function axisTicks(peak: number): readonly number[] {
  const step = niceStep(peak / 4);
  if (!Number.isFinite(step) || step <= 0) return [0, peak];
  const ticks: number[] = [];
  for (let value = 0; value <= peak + step / 2 && ticks.length < 12; value += step) {
    ticks.push(Math.round(value));
  }
  return ticks;
}

/**
 * Two decimals, because SVG takes them and a User never needs six.
 *
 * The rounding also keeps the markup small: a paid chart is thirty-eight points,
 * which is a hundred and fourteen numbers, and full float precision would be a
 * hundred and fourteen long ones.
 */
function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function polyline(points: readonly { x: number; y: number }[]): string {
  return points.map((p) => `${round(p.x)},${round(p.y)}`).join(' ');
}

/**
 * The mention-volume chart: Articles and Stories, day by day, over the whole
 * window.
 *
 * The two are drawn separately rather than summed into one line because they
 * answer different questions and a summed line can answer neither: a day with six
 * Articles carrying two Stories and a day with two Articles carrying two Stories
 * are the same total and not remotely the same event.
 *
 * The axis is drawn, not just the lines. A shape with no scale beside it says
 * "this went up" and not by how much or from what, and the answer to that — the
 * numbers themselves — is a table further down the page. The gridlines and the two
 * axes of numbers put the scale next to the shape, so the chart can be read
 * without scrolling to find out what it is worth. Every labelled value is one of
 * the round numbers the series is actually drawn to, so no label is a value that
 * is not on the plot.
 *
 * Every annotated day gets a rule through the plot. The rule is the visual; the
 * list of Clusters under the chart is the part that can be read and followed,
 * because an SVG cannot carry a link a screen reader will offer.
 */
export function volumeChartSvg(input: {
  readonly volume: readonly TrendVolumePoint[];
  readonly spikeDates: readonly string[];
}): string {
  const { width, height, box } = VOLUME;
  const articleCounts = input.volume.map((p) => p.articles);
  const storyCounts = input.volume.map((p) => p.stories);
  const articles = place(articleCounts, VOLUME);
  const stories = place(storyCounts, VOLUME);
  const plotBottom = height - box.bottom;
  const plotRight = width - box.right;

  // One scale for both lines, so they are read against each other. The two
  // polylines are compared by eye in a way the two tables below them are not, and
  // a scale per line would make "Stories always sit under Articles" true of the
  // drawing and false of the data.
  const peak = Math.max(peakOf(articleCounts), peakOf(storyCounts));

  const gridlines = axisTicks(peak)
    .map((value) => {
      const y = round(box.top + (height - box.top - box.bottom) * (1 - value / peak));
      return `<line class="trend-chart__grid" x1="${box.left}" y1="${y}" x2="${plotRight}" y2="${y}"/>
      <text class="trend-chart__tick" x="${box.left - 8}" y="${y + 3}" text-anchor="end">${value}</text>`;
    })
    .join('');

  // Every few days rather than every day: fourteen labels along 720 units is
  // about 46 units each, which is narrower than the three digits of a date. The
  // first and the last day are always labelled, because those are the two a
  // reader is looking for.
  const step = Math.max(1, Math.round(input.volume.length / 8));
  const dayLabels = input.volume
    .map((_, i) => i)
    .filter((i) => i === 0 || i === input.volume.length - 1 || i % step === 0)
    .map((i) => {
      const x = articles[i]?.x ?? box.left;
      return `<text class="trend-chart__tick" x="${round(x)}" y="${height - 8}" text-anchor="middle">${i + 1}</text>`;
    })
    .join('');

  const spikeRules = input.spikeDates
    .map((date) => {
      const index = input.volume.findIndex((p) => p.date === date);
      // A spike whose day the tier's cutoff removed is not drawn: the User is not
      // shown that day's volume, so marking where it would have been would point
      // at a day they cannot see.
      if (index === -1) return '';
      const x = articles[index]?.x ?? box.left;
      return `<line class="spike-marker" x1="${round(x)}" y1="${box.top}" x2="${round(x)}" y2="${plotBottom}"/>`;
    })
    .join('');

  return `<svg class="trend-chart" viewBox="0 0 ${width} ${height}" width="100%" height="${height}" role="img" aria-label="${escapeHtml(chartLabel(input.volume))}" preserveAspectRatio="xMinYMid meet">
    ${gridlines}
    <line class="trend-chart__axis" x1="${box.left}" y1="${plotBottom}" x2="${plotRight}" y2="${plotBottom}"/>
    <polyline class="trend-chart__articles" points="${polyline(articles)}"/>
    <polyline class="trend-chart__stories" points="${polyline(stories)}"/>
    ${spikeRules}
    ${dayLabels}
  </svg>`;
}

/**
 * One Entity's mention rate, drawn small beside its name.
 *
 * Hidden from assistive technology on purpose: the row it sits in already says how
 * many times the Entity was named and by how much that is up, so the shape is the
 * evidence for those two numbers, and narrating it would say the same thing three
 * times in three different vocabularies.
 */
export function sparklineSvg(input: {
  readonly points: readonly { readonly date: string; readonly mentions: number }[];
}): string {
  const { width, height } = SPARK;
  const placed = place(
    input.points.map((p) => p.mentions),
    SPARK,
  );
  return `<svg class="sparkline" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" aria-hidden="true" focusable="false"><polyline points="${polyline(placed)}"/></svg>`;
}

/**
 * What the chart says, in a sentence.
 *
 * The range and the peak rather than the shape, because that is what a sighted
 * reader takes from it in a second and what a screen reader has to be given in a
 * sentence. The figures are the same ones the chart is drawn from, so the two
 * cannot disagree.
 */
function chartLabel(volume: readonly TrendVolumePoint[]): string {
  if (volume.length === 0) return 'No days to show.';
  const busiest = volume.reduce((best, point) =>
    articlesOn(point) > articlesOn(best) ? point : best,
  );
  const last = volume[volume.length - 1]?.date;
  return `${volume.length} days from ${volume[0]?.date} to ${last}. Busiest day ${busiest.date} with ${articlesOn(busiest)} articles and ${busiest.stories} stories.`;
}