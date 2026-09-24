import type {
  LLMSummaryClient,
  LLMSummaryOutput,
  LLMBulletPoint,
} from '../domain/llm.js';

export interface LLMSummaryServiceOptions {
  readonly timeoutMs?: number;
  readonly apiKey?: string;
  readonly endpointUrl?: string;
}

export class OpenAILLMSummaryService implements LLMSummaryClient {
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly endpointUrl: string;

  constructor(opts: LLMSummaryServiceOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? 8000;
    this.apiKey = opts.apiKey ?? process.env.OPENAI_API_KEY;
    this.endpointUrl = opts.endpointUrl ?? (process.env.OPENAI_API_URL ?? 'https://api.openai.com/v1/chat/completions');
  }

  async generateSummary(
    clusterTitle: string,
    clusterSummary: string,
    articles: readonly { url: string; title: string; body: string }[],
  ): Promise<LLMSummaryOutput | null> {
    if (!this.apiKey) {
      return null;
    }
    if (articles.length === 0) {
      return null;
    }

    const articleDescriptions = articles
      .map(
        (a, i) =>
          `[Article ${i + 1}] Title: ${a.title}\nURL: ${a.url}\nContent: ${a.body.slice(0, 2000)}`,
      )
      .join('\n\n---\n\n');

    const prompt = `You are summarizing a news cluster for a brief digest.\n` +
      `Cluster title: ${clusterTitle}\n` +
      `Extractive summary: ${clusterSummary}\n\n` +
      `Evidence articles (cite ONLY these URLs):\n\n${articleDescriptions}\n\n` +
      `Generate a one-line summary and 3-5 bullet points. ` +
      `Each bullet must cite exactly ONE of the above articles by its URL. ` +
      `Respond ONLY as JSON: {"summary":"...","bulletPoints":[{"text":"...","articleUrl":"..."},...]}`;

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);

      const response = await fetch(this.endpointUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          model: 'gpt-4o-mini',
          messages: [{ role: 'user', content: prompt }],
          temperature: 0.2,
          max_tokens: 600,
        }),
        signal: controller.signal,
      }).finally(() => clearTimeout(timer));

      if (!response.ok) {
        return null;
      }

      const json = (await response.json()) as { choices?: { message?: { content?: string } }[] };
      const content = json.choices?.[0]?.message?.content;
      if (!content) return null;

      const parsed: unknown = JSON.parse(content);
      if (!parsed || typeof parsed !== 'object') return null;
      const obj = parsed as Record<string, unknown>;

      const summary = typeof obj.summary === 'string' ? obj.summary : '';
      const bulletsRaw = Array.isArray(obj.bulletPoints) ? obj.bulletPoints : [];
      const allowedUrls = new Set(articles.map((a) => a.url));
      const bulletPoints: LLMBulletPoint[] = bulletsRaw
        .map((b) => {
          if (!b || typeof b !== 'object') return null;
          const bb = b as Record<string, unknown>;
          if (typeof bb.text !== 'string' || typeof bb.articleUrl !== 'string') return null;
          if (!allowedUrls.has(bb.articleUrl)) return null; // enforce citation constraint
          return { text: bb.text, articleUrl: bb.articleUrl } as LLMBulletPoint;
        })
        .filter((b): b is LLMBulletPoint => b !== null);

      if (bulletPoints.length === 0) return null;

      return { summary, bulletPoints };
    } catch {
      return null;
    }
  }
}
