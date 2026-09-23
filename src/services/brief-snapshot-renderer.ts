import type { BriefPlan } from '../domain/types.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';

export interface BriefSnapshotRendererDeps {
  readonly clusterRepo: ClusterRepo;
}

export class BriefSnapshotRenderer {
  constructor(private readonly deps: BriefSnapshotRendererDeps) {}

  async render(plan: BriefPlan, appBaseUrl: string): Promise<string> {
    const clusters = await this.deps.clusterRepo.listByTopicId(plan.topicId);
    const selectedClusters = clusters.filter((c) => plan.clusterIds.includes(c.id as string));

    let html = `<html><head><meta charset="utf-8"><title>Brief for ${plan.topicId}</title></head><body>`;
    html += `<h1>Brief</h1>`;
    html += `<a href="${appBaseUrl}/topics/${plan.topicId}">View in app</a>`;

    for (const cluster of selectedClusters) {
      html += `<h2>${escapeHtml(cluster.title)}</h2>`;
      html += `<p>${escapeHtml(cluster.summary)}</p>`;
      html += `<ul>`;
      for (const bullet of cluster.bulletPoints) {
        html += `<li>${escapeHtml(bullet)}</li>`;
      }
      html += `</ul>`;
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
