import type { BriefPlan, TopicId } from '../domain/types.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';
import { escapeHtml } from '../domain/html.js';

export interface BriefSnapshotRendererDeps {
  readonly clusterRepo: ClusterRepo;
  readonly llmClient?: LLMSummaryClient | undefined;
  readonly maxLlmClusters?: number;
  readonly briefLlmTimeoutMs?: number;
  /**
   * Used to put the Topic's own title and slug on the brief. Optional, so a
   * caller holding only a Plan can still render; without it the brief falls back
   * to the internal topic id, which is a worse heading and a link that 404s, but
   * not a broken document.
   */
  readonly topicRepo?: TopicRepo | undefined;
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

    const topic = this.deps.topicRepo
      ? await this.deps.topicRepo.getById(plan.topicId as TopicId)
      : null;
    // The application routes on the slug, not the id, so a link built from the
    // id has always resolved to nothing.
    const topicPath = topic?.slug ?? plan.topicId;
    const topicTitle = topic?.title ?? 'Your brief';
    const topicUrl = `${appBaseUrl}/topics/${encodeURIComponent(topicPath)}`;

    let content = '';
    for (const cluster of selectedClusters) {
      const llmResult = llmResults.get(cluster.id as string);
      const hasLlm = llmResult !== null && llmResult !== undefined;

      if (hasLlm) {
        content += `<h2 style="${H2}">${escapeHtml(llmResult!.summary || cluster.title)}</h2>`;
        content += `<ul style="${UL}">`;
        for (const bullet of llmResult!.bulletPoints) {
          content += `<li style="${LI}"><a href="${escapeHtml(bullet.articleUrl)}" target="_blank" rel="noopener" style="${LINK}">${escapeHtml(bullet.text)}</a></li>`;
        }
        content += `</ul>`;
      } else {
        content += `<h2 style="${H2}">${escapeHtml(cluster.title)}</h2>`;
        content += `<p style="${P}">${escapeHtml(cluster.summary)}</p>`;
        content += `<ul style="${UL}">`;
        for (const bullet of cluster.bulletPoints) {
          content += `<li style="${LI}">${escapeHtml(bullet)}</li>`;
        }
        content += `</ul>`;
      }
    }

    // The old footer linked to `/unsubscribe/topic` and `/unsubscribe/all` with a
    // literal `TOKEN` in the query string, and neither route is registered
    // anywhere in the application: a link that looks real and answers 404 is
    // worse than no link. The footer now points at the two things a reader can
    // actually do. Real one-click unsubscribe is a separate change - it needs an
    // opt-out the send path honours, and the `email_deliveries.unsubscribe_token`
    // columns are still never written.
    const links: readonly EmailLink[] = [
      { href: `${appBaseUrl}/settings/delivery`, label: 'Change delivery time' },
      { href: `${appBaseUrl}/pick-topics`, label: 'Manage topics' },
      { href: `${appBaseUrl}/topics`, label: 'All your topics' },
    ];

    return emailDocument({
      title: `${topicTitle} - Brieflyy`,
      heading: topicTitle,
      preheader: `Your ${topicTitle} brief`,
      date: formatDate(plan.createdAt),
      viewInAppUrl: topicUrl,
      content,
      links,
    });
  }
}

interface EmailLink {
  readonly href: string;
  readonly label: string;
}

// Inline styles, because email clients strip a <style> block in the head and
// ignore it in others. The values are the same semantic tokens the pages use,
// flattened: #111827 text, #4b5563 body copy, #5b6472 meta, #1856c4 links.
const FONT = '-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif';
const H2 = `margin:20px 0 6px 0;font-size:16px;line-height:1.35;color:#111827;font-family:${FONT};`;
const P = `margin:0 0 8px 0;font-size:15px;line-height:1.6;color:#4b5563;font-family:${FONT};`;
const UL = `margin:0 0 8px 0;padding:0 0 0 18px;font-size:15px;line-height:1.7;color:#111827;font-family:${FONT};`;
const LI = 'margin:0 0 4px 0;';
const LINK = 'color:#1856c4;';

/**
 * The whole document around the brief.
 *
 * A BriefSnapshot is the form of a brief that is emailed and kept forever, so it
 * is the surface the product is judged on and it was previously an unstyled
 * stack of headings. The layout is a single 600px table inside a 100% one,
 * which is what Outlook and Gmail both render without surprises.
 */
function emailDocument(input: {
  readonly title: string;
  readonly heading: string;
  readonly preheader: string;
  readonly date: string;
  readonly viewInAppUrl: string;
  readonly content: string;
  readonly links: readonly EmailLink[];
}): string {
  const links = input.links
    .map(
      (l) =>
        `<a href="${escapeHtml(l.href)}" style="color:#1856c4;text-decoration:underline;">${escapeHtml(l.label)}</a>`,
    )
    .join(' &middot; ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<title>${escapeHtml(input.title)}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7f9;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHtml(input.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f6f7f9;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:600px;background:#ffffff;border:1px solid #e9ecf0;border-radius:8px;">
<tr><td style="padding:24px 28px 0 28px;font-family:${FONT};">
  <p style="margin:0;font-size:13px;letter-spacing:0.06em;text-transform:uppercase;color:#5b6472;">Brieflyy &middot; ${escapeHtml(input.date)}</p>
  <h1 style="margin:8px 0 0 0;font-size:22px;line-height:1.25;color:#111827;">${escapeHtml(input.heading)}</h1>
  <p style="margin:12px 0 0 0;font-size:15px;line-height:1.6;color:#4b5563;">
    <a href="${escapeHtml(input.viewInAppUrl)}" style="color:#1856c4;">View this brief in Brieflyy</a>
  </p>
</td></tr>
<tr><td style="padding:8px 28px 24px 28px;font-family:${FONT};">${input.content}</td></tr>
<tr><td style="padding:0 28px 28px 28px;border-top:1px solid #e9ecf0;font-family:${FONT};">
  <p style="margin:16px 0 0 0;font-size:13px;line-height:1.6;color:#5b6472;">You are receiving this because you signed up for a Brieflyy brief on this topic.</p>
  <p style="margin:8px 0 0 0;font-size:13px;line-height:1.6;">${links}</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

function formatDate(date: Date): string {
  try {
    return new Intl.DateTimeFormat('en-GB', {
      day: 'numeric',
      month: 'long',
      year: 'numeric',
      timeZone: 'UTC',
    }).format(date);
  } catch {
    return date.toISOString().slice(0, 10);
  }
}
