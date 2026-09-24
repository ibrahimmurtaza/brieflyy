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
