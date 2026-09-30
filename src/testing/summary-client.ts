import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';

export interface RecordedSummaryCall {
  readonly clusterTitle: string;
  readonly clusterSummary: string;
  /** The URLs the Cluster was offered, which is the only set a citation may name. */
  readonly articleUrls: readonly string[];
}

/**
 * The one double for the summary client, so a test that cares what a brief cost
 * is not written twice.
 *
 * It records every call — a brief that asked for more Clusters than it should
 * have is invisible in the document it produced — and answers with whatever the
 * test decides, per call, so one Cluster can fail while the rest do not. An
 * answer of `undefined` means "the ordinary one", which is how a test gives a
 * single Cluster a different fate without restating what the others get.
 */
export class RecordingSummaryClient implements LLMSummaryClient {
  readonly calls: RecordedSummaryCall[] = [];

  private readonly ordinary = (call: RecordedSummaryCall): LLMSummaryOutput => ({
    summary: `Written summary of ${call.clusterTitle}`,
    bulletPoints: call.articleUrls.map((url) => ({ text: 'A written point.', articleUrl: url })),
  });

  constructor(
    private readonly answer: (
      call: RecordedSummaryCall,
    ) => LLMSummaryOutput | null | undefined | Promise<LLMSummaryOutput | null | undefined> = () => undefined,
  ) {}

  /** How many calls this brief spent, which is what it cost. */
  get callCount(): number {
    return this.calls.length;
  }

  async generateSummary(
    clusterTitle: string,
    clusterSummary: string,
    articles: readonly { url: string; title: string; body: string }[],
  ): Promise<LLMSummaryOutput | null> {
    const call: RecordedSummaryCall = {
      clusterTitle,
      clusterSummary,
      articleUrls: articles.map((a) => a.url),
    };
    this.calls.push(call);
    const answered = await this.answer(call);
    return answered === undefined ? this.ordinary(call) : answered;
  }
}
