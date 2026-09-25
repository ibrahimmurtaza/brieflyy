import type { BriefPlan } from '../domain/types.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';

export interface BriefSnapshotRendererDeps {
  readonly clusterRepo: ClusterRepo;
  readonly llmClient?: LLMSummaryClient | undefined;
  readonly maxLlmClusters?: number;
  readonly briefLlmTimeoutMs?: number;
}

export class BriefSnapshotRenderer {
  constructor(private readonly deps: BriefSnapshotRendererDeps) {}

  // The HTML produced here is intended to be saved once as BriefSnapshot.html.
  // It should not be regenerated on view — the snapshot is immutable.
  async render(plan: BriefPlan, appBaseUrl: string): Promise<string> {
    const clusters = await this.deps.clusterRepo.listByTopicId(plan.topicId);
    const selectedClusters = clusters.filter((c) => plan.clusterIds.includes(c.id as string));
    const maxLlm = this.deps.maxLlmClusters ?? 5;
    const llmEnabled = !!this.deps.llmClient && selectedClusters.length > 0;

    const llmResults = new Map<string, LLMSummaryOutput | null>();
    const briefTimeoutMs = this.deps.briefLlmTimeoutMs ?? 15000;
    const briefStart = Date.now();
    if (llmEnabled) {
      let callsMade = 0;
      for (const cluster of selectedClusters) {
        if (callsMade >= maxLlm) break;
        // Global brief-level timeout: if exceeded, fall back for all remaining clusters
        if (Date.now() - briefStart > briefTimeoutMs) {
          break;
        }
        callsMade++;
        try {
          const articles = await this.deps.clusterRepo.listArticlesByClusterId(cluster.id as string);
          const articleInputs = articles.map((a) => ({
            url: a.url,
            title: a.title,
            body: a.body,
          }));
          const result = await this.deps.llmClient!.generateSummary(
            cluster.title,
            cluster.summary,
            articleInputs,
          );
          llmResults.set(cluster.id as string, result);
        } catch {
          llmResults.set(cluster.id as string, null);
        }
      }
      // For any clusters not processed (beyond maxLlm or failed), fall back to extractive
      for (const cluster of selectedClusters) {
        if (!llmResults.has(cluster.id as string)) {
          llmResults.set(cluster.id as string, null);
        }
      }
    }

    let html = `<html><head><meta charset="utf-8"><title>Brief for ${plan.topicId}</title></head><body>`;
    html += `<h1>Brief</h1>`;
    html += `<a href="${appBaseUrl}/topics/${plan.topicId}">View in app</a>`;

    for (const cluster of selectedClusters) {
      const llmResult = llmResults.get(cluster.id as string);
      const hasLlm = llmResult !== null && llmResult !== undefined;

      if (hasLlm) {
        html += `<h2>${escapeHtml(llmResult!.summary || cluster.title)}</h2>`;
        html += `<ul>`;
        for (const bullet of llmResult!.bulletPoints) {
          html += `<li><a href="${escapeHtml(bullet.articleUrl)}" target="_blank" rel="noopener">${escapeHtml(bullet.text)}</a></li>`;
        }
        html += `</ul>`;
      } else {
        html += `<h2>${escapeHtml(cluster.title)}</h2>`;
        html += `<p>${escapeHtml(cluster.summary)}</p>`;
        html += `<ul>`;
        for (const bullet of cluster.bulletPoints) {
          html += `<li>${escapeHtml(bullet)}</li>`;
        }
        html += `</ul>`;
      }
    }

    html += `<hr><p><a href="${appBaseUrl}/unsubscribe/topic?t=${plan.topicId}&token=TOKEN">Unsubscribe from this topic</a> | <a href="${appBaseUrl}/unsubscribe/all?token=TOKEN">Unsubscribe from all</a></p>`;
    html += `</body></html>`;
    return html;
  }
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
