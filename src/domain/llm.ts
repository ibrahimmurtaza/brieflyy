/**
 * The shape of a written summary, and the contract for asking for one.
 *
 * The `articles` are the Cluster's own, and that is the whole contract: a bullet
 * that does not cite one of them is not a claim about the Cluster, so an
 * implementation discards it rather than passing it on — and says how many it
 * threw away, because a Cluster that quietly loses bullets to a model citing
 * things nobody checked is indistinguishable from one that never lost any.
 *
 * An answer whose bullets all failed is still an answer: it comes back with none
 * of them and the count that says why, and the renderer quotes the Cluster
 * instead. `null` is narrower than that — no credential, no Articles, an error, a
 * reply that was not the JSON asked for — and means the call produced nothing to
 * report on at all.
 */
export interface LLMBulletPoint {
  readonly text: string;
  readonly articleUrl: string;
}

export interface LLMSummaryOutput {
  readonly summary: string;
  readonly bulletPoints: readonly LLMBulletPoint[];
  /**
   * Everything in the reply that was offered as a bullet and did not survive:
   * a citation of something outside the Cluster, and a bullet that was not a text
   * citing a URL at all. One number because an operator watching it cannot act on
   * the difference — a model that is returning malformed bullets and a model that
   * is inventing citations are the same problem, a provider that has stopped
   * obeying the contract.
   */
  readonly discardedBullets: number;
}

export interface LLMSummaryClient {
  generateSummary(
    clusterTitle: string,
    clusterSummary: string,
    articles: readonly { url: string; title: string; body: string }[],
  ): Promise<LLMSummaryOutput | null>;
}
