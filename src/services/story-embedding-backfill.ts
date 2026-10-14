/**
 * Giving the Stories that predate the embedding a second reading of their own.
 *
 * A Story formed today carries the vector computed for the Article that formed
 * it (ADR-0037). Every Story already in a database was formed before anything
 * carried one, so those Stories carry none — and grouping reads a missing
 * embedding as no evidence, which means a corpus that has not been through this
 * does not measure the semantic floor at all and reads as though the floor had
 * done nothing (ADR-0038). This is what makes it measurable.
 *
 * **It is a command an operator runs, not something that happens at boot.** The
 * writing needs a credential and spends money, a real corpus is a job of thousands
 * of calls, and each of those is a decision somebody should be making rather than
 * one the application makes on their behalf at startup. So it runs over a copy of
 * the database the way the other corpus commands do, and a corpus either has been
 * through it or has not.
 *
 * Two properties make a second run safe and cheap, and both are enforced below
 * rather than trusted:
 *
 * - **A Story already carrying a vector is never asked about.** It is not offered
 *   to the provider and it is not overwritten. The formation path covers every
 *   Story formed from here on, and replacing its vector with a later one would
 *   make the Story disagree with every other Story formed since.
 * - **The read moves forwards whether or not the last page was a success.** A
 *   Story the provider had nothing for is still carrying none when the next page
 *   is asked for, so a run that restarted at the beginning every time would ask
 *   about the same failures for ever. Stopped halfway, the next run of the command
 *   picks up where it stopped; both are the same code path.
 */
import type {
  BatchingEmbeddingProvider,
  EmbeddingBatch,
  EmbeddingUsage,
  StoryEmbedding,
} from '../domain/embedding.js';
import { articleText } from '../domain/feed-text.js';
import type { StoryId } from '../domain/types.js';
import type { StoryRepo, UnembeddedStory } from '../repos/story-repo.js';

/**
 * What a whole run spent, and how much of it was actually measured.
 *
 * The per-call figures are the provider's, added up over the run; `reportingCalls`
 * is this build's, and it is what keeps the total honest. A run whose replies all
 * carried a figure and a run whose replies half carried one would otherwise print
 * the same number, and the second of those is a sum over fewer calls than it says.
 */
export interface EmbeddingBackfillUsage extends EmbeddingUsage {
  /** Calls that carried a usage figure at all, which is what a total is over. */
  readonly reportingCalls: number;
}

/**
 * What one run of a backfill did.
 *
 * Every figure is a count of something that happened rather than a claim about
 * the corpus afterwards, because those are what a command that may be interrupted
 * is judged on. `considered` in particular is what separates the two answers a
 * zero `embedded` can mean: **a corpus that had nothing left to do** and **a
 * corpus whose calls all came back with nothing**.
 */
export interface EmbeddingBackfillReport {
  /** Stories this run put a vector on. */
  readonly embedded: number;
  /** Stories this run found carrying no vector, whether or not it wrote one. */
  readonly considered: number;
  /** Of those, the ones no vector was written for. */
  readonly unanswered: number;
  /** Of those, the ones holding no Article, so there was no text to embed. */
  readonly withoutArticle: number;
  /** Calls that came back with nothing at all, rather than with too few vectors. */
  readonly refusedCalls: number;
  /** What the run spent. */
  readonly usage: EmbeddingBackfillUsage;
  /** The models the vectors this run wrote carry, sorted. */
  readonly models: readonly string[];
}

export interface EmbeddingBackfillDeps {
  readonly storyRepo: Pick<StoryRepo, 'listUnembedded' | 'backfillEmbedding'>;
  readonly provider: BatchingEmbeddingProvider;
  /**
   * How many Stories to ask about in one call.
   *
   * The endpoint is billed per request, so this number is the whole of what
   * decides whether a corpus costs thousands of calls or hundreds of thousands.
   * Nothing upstream publishes a maximum for the `input` array, so it is an
   * operator's to set rather than one this build can derive — see
   * `OPENROUTER_EMBEDDING_BATCH_SIZE_DEFAULT` for why the shipped value is
   * conservative rather than the largest anyone has seen work.
   */
  readonly batchSize: number;
}

/**
 * Embeds every Story that carries none, and says what that cost.
 *
 * The whole of a backfill is here rather than in the command, so the parts worth
 * arguing about — which Stories are asked about, what happens to a call the
 * endpoint refuses, and what a run says when it did nothing — can be checked
 * without a database file and a network.
 */
export async function backfillStoryEmbeddings(
  deps: EmbeddingBackfillDeps,
): Promise<EmbeddingBackfillReport> {
  if (deps.batchSize < 1) {
    throw new Error(
      `a backfill asks about ${deps.batchSize} Stories at a time, which is never a batch`,
    );
  }

  const run = new BackfillRun(deps);
  let after: StoryId | undefined;
  for (;;) {
    const page = await deps.storyRepo.listUnembedded({ limit: deps.batchSize, after });
    if (page.length === 0) break;
    await run.embedPage(page);
    after = page[page.length - 1]!.id;
  }
  return run.report();
}

/**
 * One run, and the totals it ends on.
 *
 * A class rather than six locals because the figures are added up across every
 * page and the report has to be one object at the end; a caller keeping that many
 * counters in step by hand is a caller that will print five of them.
 */
class BackfillRun {
  private embedded = 0;
  private considered = 0;
  private unanswered = 0;
  private withoutArticle = 0;
  private refusedCalls = 0;
  private requests = 0;
  private reportingCalls = 0;
  private tokens: number | null = null;
  private credits: number | null = null;
  private readonly models = new Set<string>();

  constructor(private readonly deps: EmbeddingBackfillDeps) {}

  /**
   * Asks about one page of Stories and writes whatever came back.
   *
   * Every vector is written before the next is asked for, so a run stopped part
   * way through leaves what it did behind it and the next run of the command
   * carries on from the first Story still carrying none.
   */
  async embedPage(page: readonly UnembeddedStory[]): Promise<void> {
    this.considered += page.length;
    const embeddable = page.filter((story) => story.title !== null && story.body !== null);
    this.withoutArticle += page.length - embeddable.length;
    if (embeddable.length === 0) return;

    const vectors = await this.askAbout(
      embeddable.map((story) => articleText(story.title as string, story.body as string)),
    );

    for (const [at, embedding] of vectors.entries()) {
      const story = embeddable[at]!;
      if (embedding === null) {
        this.unanswered += 1;
        continue;
      }
      // A write refused because the Story acquired a vector while the call was in
      // flight is counted as a Story this run did not embed — the report counts
      // acts, not outcomes, and a run that reports a write it did not make is the
      // one number here an operator would be misled by.
      const written = await this.deps.storyRepo.backfillEmbedding(story.id, embedding);
      if (!written) {
        this.unanswered += 1;
        continue;
      }
      this.models.add(embedding.model);
      this.embedded += 1;
    }
  }

  /**
   * Asks the provider about a page's texts, and a call it refused about them
   * again one text at a time.
   *
   * The split is what makes the batch size a setting rather than a guess. The
   * endpoint publishes no maximum for the `input` array, so a size that is too
   * large for the account or the payload is a mistake a run can get itself out of
   * — costing one batch of extra requests rather than a whole run per page to
   * discover. Texts that cannot be embedded either way are left carrying none, and
   * the run carries on at the same size afterwards: a refusal is a fact about
   * this call, not a statement about the corpus.
   */
  private async askAbout(texts: readonly string[]): Promise<readonly (StoryEmbedding | null)[]> {
    const batch = await this.deps.provider.embedBatch(texts);
    this.add(batch);
    if (!batch.refused || texts.length <= 1) return batch.embeddings;

    const singly: (StoryEmbedding | null)[] = [];
    for (const text of texts) {
      const one = await this.deps.provider.embedBatch([text]);
      this.add(one);
      singly.push(one.embeddings[0] ?? null);
    }
    return singly;
  }

  /**
   * Adds one call's answer to the run's totals.
   *
   * Tokens and credits are added only where the call reported them, and
   * `reportingCalls` counts the calls that did — so a run in which some replies
   * carried a figure and some did not reports a sum over the ones that did, and
   * the report says which those were rather than printing it as the whole.
   */
  private add(batch: EmbeddingBatch): void {
    this.requests += batch.usage.requests;
    if (batch.usage.tokens !== null) {
      this.reportingCalls += 1;
      this.tokens = (this.tokens ?? 0) + batch.usage.tokens;
    }
    if (batch.usage.credits !== null) this.credits = (this.credits ?? 0) + batch.usage.credits;
    if (batch.refused) this.refusedCalls += 1;
  }

  report(): EmbeddingBackfillReport {
    return {
      embedded: this.embedded,
      considered: this.considered,
      unanswered: this.unanswered + this.withoutArticle,
      withoutArticle: this.withoutArticle,
      refusedCalls: this.refusedCalls,
      usage: {
        requests: this.requests,
        tokens: this.tokens,
        credits: this.credits,
        reportingCalls: this.reportingCalls,
      },
      models: [...this.models].sort(),
    };
  }
}

/**
 * What a run says about itself.
 *
 * The shape the operator reads is drawn here rather than in the command, for the
 * reason `cluster-grouping-benchmark.ts` draws its report in the module that
 * scores it: a rule only a script exercises cannot be checked, and this one has a
 * case that matters most and happens least — **a run that found nothing to do**,
 * which is what every run after the first prints and which reads exactly like a
 * command that did not run at all if it is drawn as a bare zero.
 *
 * The cases are drawn as sentences rather than as one number with a caption,
 * because they are three different things that happened: a corpus with nothing
 * left to do, an ordinary run, and a run whose calls came back with nothing —
 * where the count of Stories it could not embed is named rather than left as a
 * `0 of 136`, which reads as a rule refusing them rather than as calls failing.
 */
export function formatEmbeddingBackfillReport(
  report: EmbeddingBackfillReport,
  context: { readonly batchSize: number },
): string {
  const lines = [
    'story embedding backfill',
    `  rule      every Story carrying no embedding, ${context.batchSize} to a call, and never one that carries one`,
    ...progressLines(report),
  ];
  if (report.models.length > 0) {
    lines.push(
      `  model     ${report.models.join(', ')}  what the provider says produced every vector this run wrote`,
    );
  }
  if (report.considered > 0) {
    lines.push(`  cost      ${costLine(report)}`);
  }
  return `${lines.join('\n')}\n`;
}

/** The lines saying what the run did with the Stories it found. */
function progressLines(report: EmbeddingBackfillReport): readonly string[] {
  if (report.considered === 0) {
    return [
      '  embedded  nothing to do: every Story in this corpus already carries an embedding, so none was asked about',
    ];
  }

  const lines = [
    `  embedded  ${report.embedded} of ${report.considered} stories now carry an embedding`,
  ];
  if (report.unanswered > 0) {
    lines.push(
      `  asked     the provider had nothing for ${report.unanswered - report.withoutArticle} of them` +
        (report.refusedCalls > 0
          ? `, over ${report.refusedCalls} of ${report.usage.requests} calls that returned nothing at all`
          : '') +
        (report.withoutArticle > 0
          ? `, and ${report.withoutArticle} of them hold no Article to take a reading from`
          : ''),
    );
  }
  return lines;
}

/**
 * What the run spent, in the three figures that decide whether it is worth
 * running again.
 *
 * Requests first, because that is the only one this build counted itself and the
 * one a free account is actually limited by. Tokens and credits are read out of
 * the replies, and a figure that came back from fewer calls than the run made is
 * marked as one — an unmarked total over half the calls is a number the operator
 * would take as the whole of it.
 */
function costLine(report: EmbeddingBackfillReport): string {
  const { requests, tokens, credits, reportingCalls } = report.usage;
  const calls =
    requests === 0
      ? 'no calls made'
      : requests === 1
        ? '1 request'
        : `${requests} requests`;
  return [
    calls,
    figure(tokens, reportingCalls, requests, 'token'),
    figure(credits, reportingCalls, requests, 'credit'),
  ].join(', ');
}

/**
 * One reported figure, saying how many calls it is a sum over where that is not
 * all of them.
 *
 * `null` is the absence of a measurement and prints as such — the one reading of
 * the pair that would be certainly wrong, since a run that spent money and said it
 * had spent none is the failure this line exists to prevent.
 */
function figure(
  value: number | null,
  reportingCalls: number,
  requests: number,
  unit: string,
): string {
  if (value === null) return `${unit}s not reported`;
  const plural = value === 1 ? unit : `${unit}s`;
  return reportingCalls < requests
    ? `${value} ${plural}, as reported by ${reportingCalls} of ${requests} calls`
    : `${value} ${plural}`;
}