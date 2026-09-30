import type {
  LLMSummaryClient,
  LLMSummaryOutput,
  LLMBulletPoint,
} from '../domain/llm.js';
import { readOptionalString, readString, type EnvSource } from '../env.js';
import { BRIEF_GENERATION_CALL_TIMEOUT_MS_DEFAULT, OPENAI_API_URL_DEFAULT } from '../config.js';

export interface LLMSummaryServiceOptions {
  readonly timeoutMs?: number | undefined;
  /** The credential, resolved by the caller. Absent means the path is switched off. */
  readonly apiKey?: string | undefined;
  readonly endpointUrl?: string | undefined;
}

/**
 * Talks to the provider, and knows nothing about where any of it came from.
 *
 * The environment is read by `createLLMSummaryClient` rather than here, so this
 * is a plain object a test can build and the composition root is the only thing
 * that has to know what a deployment configured. No key is not a failure either:
 * it is the answer that this deployment does not write briefs, and the renderer
 * is told so before a brief is ever built.
 */
export class OpenAILLMSummaryService implements LLMSummaryClient {
  private readonly timeoutMs: number;
  private readonly apiKey: string | undefined;
  private readonly endpointUrl: string;

  constructor(opts: LLMSummaryServiceOptions = {}) {
    this.timeoutMs = opts.timeoutMs ?? BRIEF_GENERATION_CALL_TIMEOUT_MS_DEFAULT;
    this.apiKey = opts.apiKey;
    this.endpointUrl = opts.endpointUrl ?? OPENAI_API_URL_DEFAULT;
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

      // An answer with none of its bullets left is still an answer, and the count
      // is the only thing anybody learns from a call like it. Returning null
      // instead would throw that away and leave a Cluster that quietly lost every
      // bullet looking exactly like one nobody asked about. The renderer quotes
      // the Cluster on an answer with no bullets, so the reader sees the same
      // thing either way.
      return {
        summary,
        bulletPoints,
        discardedBullets: bulletsRaw.length - bulletPoints.length,
      };
    } catch {
      return null;
    }
  }
}

/**
 * The written path as the deployment has configured it, or nothing at all.
 *
 * Absent rather than a client that returns null, because the renderer reads a
 * missing client as "do not spend this brief's budget finding out" and reads a
 * null as "this one Cluster fell back". A key that is absent is a deliberate
 * configuration — a brief built entirely from the extractive summary is a
 * complete brief, quotable by construction — so it is answered where the
 * application is wired rather than once per Cluster once per brief.
 *
 * Both sources go through the same reader, so a key of whitespace is the same
 * thing here as it is everywhere else configuration is read: unset. A client
 * built from one would spend a brief's budget authenticating as `Bearer   `.
 */
export function createLLMSummaryClient(
  opts: LLMSummaryServiceOptions & {
    /** Where the deployment's configuration is read from. Defaults to nothing set. */
    readonly env?: EnvSource | undefined;
  } = {},
): LLMSummaryClient | null {
  const env = opts.env ?? {};
  const apiKey =
    readOptionalString({ OPENAI_API_KEY: opts.apiKey }, 'OPENAI_API_KEY') ??
    readOptionalString(env, 'OPENAI_API_KEY');
  if (apiKey === undefined) return null;

  const { env: _env, ...options } = opts;
  return new OpenAILLMSummaryService({
    ...options,
    apiKey,
    endpointUrl: options.endpointUrl ?? readString(env, 'OPENAI_API_URL', OPENAI_API_URL_DEFAULT),
  });
}
