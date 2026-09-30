/**
 * The shape of a written summary, and the contract for asking for one.
 *
 * The `articles` are the Cluster's own, and that is the whole contract: a bullet
 * that does not cite one of them is not a claim about the Cluster, so an
 * implementation discards it rather than passing it on. `null` is not an error
 * channel either — it is the answer "there is nothing quotable here", and the
 * caller quotes the Cluster's extractive summary instead of treating a brief as
 * failed.
 */
export interface LLMBulletPoint {
  readonly text: string;
  readonly articleUrl: string;
}

export interface LLMSummaryOutput {
  readonly summary: string;
  readonly bulletPoints: readonly LLMBulletPoint[];
}

export interface LLMSummaryClient {
  generateSummary(
    clusterTitle: string,
    clusterSummary: string,
    articles: readonly { url: string; title: string; body: string }[],
  ): Promise<LLMSummaryOutput | null>;
}
