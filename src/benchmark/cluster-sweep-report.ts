/**
 * What the sweep reports: the shape of the corpus at every cell of the grid, the
 * accuracy of each cell over the labelled families the corpus holds, and the
 * frontier over those cells.
 *
 * The sweep is the operator's reading of the rule at every point of the grid
 * rather than at the one the rule ships, and it is only worth reading if the
 * number it prints beside the shape is the number the benchmark prints for the
 * same corpus. So a cell's accuracy is measured over exactly the families
 * `pnpm cluster:benchmark` measures over: the same-event families a Topic holds
 * both Stories for, and the different-event families of the same kind. The
 * sweep's shipped cell is therefore the benchmark's shipped point, and the two
 * are read against each other rather than reconciled by hand.
 *
 * **What it says when a family cannot be weighed.** Four things stop a family
 * being measured: the corpus does not hold the reference at all, both labelled
 * sets claim the family, one set claims it twice, and no Topic holds both
 * Stories for. Each is named rather than counted, because the number beside it
 * is only as good as the set it was taken over, and a reader who cannot see the
 * set cannot tell a rule that merged nothing from a rule that was never asked.
 *
 * A corpus holding no family at all is not measured over the empty set. Every
 * cell says it has nothing to weigh, and the report says so in words rather
 * than printing a ratio over nothing, which would read as a rule that got every
 * family right.
 *
 * **The frontier.** A cell is on the frontier when no other cell is at least as
 * good on both recall and precision and better on one: the cells where one
 * number has been bought with the other. A cell that could not be measured on
 * both sides is not on it, because there is no pair of numbers to compare.
 *
 * The report is a report and not a script's printing, so it lives here rather
 * than in `scripts/cluster-sweep.ts` and has a suite, the same way the
 * benchmark's report does.
 */
import {
  clustersOf,
  evaluateClusterGrouping,
  type GroupedTopic,
  type PairResolution,
  type PairScore,
  type ResolvedStoryPair,
} from './cluster-grouping-benchmark.js';
import {
  describeThresholds,
  groupIntoClusters,
  type GroundedStory,
  type MergeGate,
  type MergeThresholds,
} from '../domain/cluster-grouping.js';
import type { StoryId, TopicId } from '../domain/types.js';

/**
 * One Topic's Stories and how each of them reads.
 *
 * The same shape the benchmark runner reads: the Entities come off the grounding
 * the rule groups with, so a cell measures the rule rather than a second reading
 * of the corpus.
 */
export interface SweepRead {
  readonly topicId: TopicId;
  readonly storyIds: readonly StoryId[];
  readonly grounding: readonly GroundedStory[];
}

/**
 * One cell of the sweep: the floors and the gate it was grouped under, and what
 * that cell did to the corpus and to the labelled families.
 */
export interface SweepCell {
  /** The gate the cell was grouped under: the one the rule ships, or the wider one. */
  readonly gate: MergeGate;
  /** The three floors the cell was grouped at. */
  readonly thresholds: MergeThresholds;
  /** The recall over the same-event families the corpus could weigh. */
  readonly recall: PairScore;
  /** The precision over the different-event families the corpus could weigh. */
  readonly precision: PairScore;
  /** How many Clusters the corpus holds at this cell. */
  readonly clusters: number;
  /** How many Stories the largest of them holds. */
  readonly largestCluster: number;
  /** The share of the Clusters holding one Story. */
  readonly singletonProportion: number | null;
}

/**
 * Group the corpus at these floors and score it, as one cell of the sweep.
 *
 * Grouped with no `thresholds` marker on the GroupedTopic, because
 * `evaluateClusterGrouping` scores only the unmarked grouping: the marker is how
 * the benchmark keeps a swept grouping out of the shipped point's totals.
 */
export function sweepCell(input: {
  readonly reads: readonly SweepRead[];
  readonly resolution: PairResolution;
  /** How each Story reads, for the ceilings and the margins beside the numbers. */
  readonly readingOf: (storyId: StoryId) => GroundedStory;
  readonly thresholds: MergeThresholds;
  readonly gate: MergeGate;
  /** Whether the Entity reading must also clear as a veto on the merge. */
  readonly requireEntity?: boolean;
}): SweepCell {
  const grouped: GroupedTopic[] = input.reads.map((read) => ({
    topicId: read.topicId,
    clusters: clustersOf(
      groupIntoClusters(
        read.storyIds,
        (_storyId, index) => read.grounding[index]!,
        {
          thresholds: input.thresholds,
          gate: input.gate,
          ...(input.requireEntity !== undefined ? { requireEntity: input.requireEntity } : {}),
        },
      ),
    ),
  }));
  const report = evaluateClusterGrouping({
    grouped,
    resolution: input.resolution,
    readingOf: input.readingOf,
    signatureFloor: input.thresholds.signature,
    semanticFloor: input.thresholds.semantic,
  });
  return {
    gate: input.gate,
    thresholds: input.thresholds,
    recall: report.recall,
    precision: report.precision,
    clusters: report.clusters,
    largestCluster: report.largestCluster,
    singletonProportion: report.singletonProportion,
  };
}

/**
 * The cells no other cell beats on both recall and precision.
 *
 * A cell is beaten by another when the other is at least as good on both and
 * better on one: that is what a frontier is. The looser rule — beaten only when
 * the other is strictly better on both — would keep a cell that ties on one side
 * and loses on the other, which is not a choice a reader of the list would make
 * and would put on it a floor that another cell already improves on.
 *
 * A cell is identified by its gate and its floors, so the cell both tables sweep
 * is one cell and not two.
 */
export function accuracyFrontier(cells: readonly SweepCell[]): readonly SweepCell[] {
  const comparable = distinctCells(cells).flatMap((cell) => {
    const recall = cell.recall.ratio;
    const precision = cell.precision.ratio;
    if (recall === null || precision === null) return [];
    return [{ cell, recall, precision }];
  });
  return comparable
    .filter(
      (entry) =>
        !comparable.some(
          (other) =>
            other.recall >= entry.recall &&
            other.precision >= entry.precision &&
            (other.recall > entry.recall || other.precision > entry.precision),
        ),
    )
    .map((entry) => entry.cell);
}

/** The cells of one gate and one set of floors, which is one cell however often it was swept. */
function distinctCells(cells: readonly SweepCell[]): readonly SweepCell[] {
  const seen = new Set<string>();
  const distinct: SweepCell[] = [];
  for (const cell of cells) {
    const key = `${cell.gate}|${describeThresholds(cell.thresholds)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    distinct.push(cell);
  }
  return distinct;
}

/**
 * The grid of cells, one row each: the shape of the corpus and the accuracy
 * beside it.
 *
 * The columns are the ones the sweep has always printed, in the order it has
 * always printed them, because two sweeps are read against each other and a
 * column that moved would be a column nobody could compare.
 */
export function formatSweepGrid(cells: readonly SweepCell[]): string {
  return `${GRID_COLUMNS}\n${cellRows(cells).join('\n')}\n`;
}

/**
 * The semantic floor as its own axis, with the other two held still.
 *
 * The column is named for the axis the table moves and the value names the whole
 * cell, because a row read on its own has to say which cell it is: the Entity
 * floor and the signature floor are held at one point, and the point they are
 * held at is part of what the row says.
 */
export function formatSweepSemanticAxis(
  cells: readonly SweepCell[],
  context: { readonly entity: number; readonly signature: number },
): string {
  return (
    `\nsemantic floor, with the Entity floor at ${context.entity} and the signature floor at ${context.signature}\n` +
    `gate\tsemantic\trecall\tprecision\tclusters\tlargest\tsingletons\n${cellRows(cells).join('\n')}\n`
  );
}

/**
 * The Entity floor as its own axis, with the signature and semantic floors held
 * at the shipped point. The Entity floor here is a veto on the merge, so each
 * cell says what the rule looks like when the Entity reading must also clear.
 */
export function formatSweepEntityAxis(
  cells: readonly SweepCell[],
  context: { readonly signature: number; readonly semantic: number },
): string {
  return (
    `\nEntity floor as a veto, with the signature floor at ${context.signature} and the semantic floor at ${context.semantic}\n` +
    `gate\tentity\trecall\tprecision\tclusters\tlargest\tsingletons\n${entityCellRows(cells).join('\n')}\n`
  );
}

/** One row of an entity-axis table: the cell, its two numbers, and the shape it left the corpus in. */
function entityCellRows(cells: readonly SweepCell[]): readonly string[] {
  return cells.map(
    (cell) =>
      `${cell.gate}\t${cell.thresholds.entity.toFixed(2)}\t${percentage(cell.recall.ratio)}\t` +
      `${percentage(cell.precision.ratio)}\t${cell.clusters}\t${cell.largestCluster}\t` +
      `${percentage(cell.singletonProportion)}`,
  );
}

/**
 * The frontier: the cells no other cell beats on both recall and precision.
 *
 * The same columns as the grid, because a frontier is read as a set of cells and
 * a reader wants the shape of each one beside the numbers that put it there. The
 * rule the list is built on is printed with it, because a list of cells without
 * it is a list the reader has to work out what a cell on it means.
 */
export function formatSweepFrontier(cells: readonly SweepCell[]): string {
  const heading = '\nfrontier, the cells no other cell beats on both recall and precision\n';
  const rule =
    '  a cell is on this list when no other cell is at least as good on both and better on one\n';
  if (cells.length === 0) {
    return `${heading}${rule}no cell could be compared on both recall and precision\n`;
  }
  return `${heading}${rule}${GRID_COLUMNS}\n${cellRows(cells).join('\n')}\n`;
}

/**
 * What every cell's accuracy is over, and what it could not be weighed over.
 *
 * The families a cell is weighed over are the same for every cell — they depend
 * on the corpus rather than on the floors — so one cell carries the set for the
 * whole sweep.
 */
export function formatScoredOver(input: {
  readonly cell: SweepCell;
  readonly resolution: PairResolution;
}): string {
  const { cell, resolution } = input;
  const weighed = [
    ...cell.recall.measured.map((pair) => `same-event family weighed: ${pair.name}`),
    ...cell.precision.measured.map((pair) => `different-event family weighed: ${pair.name}`),
  ];
  const unweighable = [
    // A reference two families name is one reference the corpus does not hold,
    // so it is named once rather than once per family that wanted it.
    ...distinct(resolution.unresolved).map(
      (name) => `labelled reference the corpus does not hold: ${name}`,
    ),
    ...resolution.contested.map(
      (name) => `family both labelled sets claim, dropped as unusable: ${name}`,
    ),
    ...resolution.duplicated.map(
      (name) => `family one labelled set claims twice, dropped as unusable: ${name}`,
    ),
    ...cell.recall.unshared.map(
      (name) => `same-event pair no topic holds both stories for: ${name}`,
    ),
    ...cell.precision.unshared.map(
      (name) => `different-event pair no topic holds both stories for: ${name}`,
    ),
  ];
  const lines = [
    'scored over',
    `  recall      ${over(cell.recall, 'same-event')}`,
    `  precision   ${over(cell.precision, 'different-event')}`,
  ];
  // Said only when it is true: a family the corpus does not hold is out of the
  // measurement, and the benchmark's numbers are over the same families, so both
  // reports are over a smaller set than the labelled one.
  if (resolution.unresolved.length > 0) {
    lines.push(
      '  why         the corpus does not hold every labelled family, so the measurement is over the families it holds',
    );
  }
  lines.push(
    '  weighed over',
    ...(weighed.length === 0 ? ['    none'] : weighed.map((line) => `    ${line}`)),
    '  could not be weighed over',
    ...(unweighable.length === 0 ? ['    none'] : unweighable.map((line) => `    ${line}`)),
  );
  return `${lines.join('\n')}\n`;
}

/**
 * The set of families one side of the accuracy is over.
 *
 * A side with nothing to weigh says so in words: a ratio over no family is not a
 * measurement, and a report that printed one would be reporting a rule that got
 * every family right.
 */
function over(score: PairScore, label: string): string {
  if (score.families === 0) {
    return `nothing to weigh: the corpus holds no ${label} family a Topic holds both Stories for`;
  }
  return `over ${score.families} ${label} families`;
}

/** The names in the order they were first seen, each of them once. */
function distinct(names: readonly string[]): readonly string[] {
  return [...new Set(names)];
}

/** The columns the sweep has always printed, in the order it has always printed them. */
const GRID_COLUMNS = 'gate\tfloors\trecall\tprecision\tclusters\tlargest\tsingletons';

/** One row of a cell table: the cell, its two numbers, and the shape it left the corpus in. */
function cellRows(cells: readonly SweepCell[]): readonly string[] {
  return cells.map(
    (cell) =>
      `${cell.gate}\t${describeThresholds(cell.thresholds)}\t${percentage(cell.recall.ratio)}\t` +
      `${percentage(cell.precision.ratio)}\t${cell.clusters}\t${cell.largestCluster}\t` +
      `${percentage(cell.singletonProportion)}`,
  );
}

/** A share of families, as a percentage, or a dash when none could be measured. */
function percentage(ratio: number | null): string {
  return ratio === null ? '  -  ' : `${(ratio * 100).toFixed(1)}%`;
}
