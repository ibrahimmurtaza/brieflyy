import type { Article, BriefPlan } from '../domain/types.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';
import { articleUrlForStatement } from '../domain/cluster-text.js';
import { escapeHtml } from '../domain/html.js';
import { safeExternalUrl } from '../domain/url.js';

/**
 * The three parts of an email a brief is.
 *
 * A brief is rendered once, when it is sent, and the parts are stored on the
 * snapshot rather than rebuilt on view: a BriefSnapshot is by definition what
 * was sent, so a renderer that could be re-run against changed Clusters would be
 * a renderer of something else.
 */export interface RenderedBrief {
  readonly subject: string;
  /** The plain-text alternative, for the clients that will not show HTML. */
  readonly text: string;
  readonly html: string;
}

export interface BriefSnapshotRendererDeps {
  readonly clusterRepo: ClusterRepo;
  readonly llmClient?: LLMSummaryClient | undefined;
  readonly maxLlmClusters?: number;
  readonly briefLlmTimeoutMs?: number;
  /**
   * Where a brief gets the Topic's own title and slug. Required rather than
   * optional because both of those are the brief's identity: without the Topic
   * the heading falls back to the internal id and the "view in app" link is
   * built from that same id, which is not a URL the application routes on. A
   * brief that would do that is a broken document, so the renderer refuses to
   * produce one.
   */
  readonly topicRepo: TopicRepo;
}

export class BriefSnapshotRenderer {
  constructor(private readonly deps: BriefSnapshotRendererDeps) {}

  async render(plan: BriefPlan, appBaseUrl: string): Promise<RenderedBrief> {
    const topic = await this.deps.topicRepo.getById(plan.topicId);
    if (!topic) {
      // The plan names a Topic the database no longer holds. Rendering anyway
      // would put `plan.topicId` in the heading and in the call to action,
      // which is how the previous renderer shipped a link that 404'd.
      throw new Error(
        `cannot render a brief for topic ${plan.topicId}: no such topic`,
      );
    }

    // A BriefPlan is a selection *and an ordering* of Clusters. The order is the
    // one the plan chose, so it is read here rather than re-derived from the
    // Cluster table, whose own order knows nothing of that decision.
    const clusters = await this.deps.clusterRepo.listByTopicId(plan.topicId);
    const byId = new Map(clusters.map((c) => [c.id as string, c] as const));
    const selected = plan.clusterIds
      .map((id) => byId.get(id as string))
      .filter((c): c is NonNullable<typeof c> => c !== undefined);

    const articlesByCluster = new Map<string, readonly Article[]>();
    for (const cluster of selected) {
      // Loaded for every selected Cluster, not only the ones the LLM gets to:
      // the extractive path needs the same Articles to attribute its own
      // bullets to.
      articlesByCluster.set(
        cluster.id as string,
        await this.deps.clusterRepo.listArticlesByClusterId(
          cluster.id as string,
          topic.sourceIds,
        ),
      );
    }

    const llmResults = new Map<string, LLMSummaryOutput | null>();
    const maxLlm = this.deps.maxLlmClusters ?? 5;
    if (this.deps.llmClient && selected.length > 0) {
      const briefTimeoutMs = this.deps.briefLlmTimeoutMs ?? 15000;
      const briefStart = Date.now();
      let callsMade = 0;
      for (const cluster of selected) {
        if (callsMade >= maxLlm) break;
        // Global brief-level timeout: if exceeded, fall back for all remaining clusters
        if (Date.now() - briefStart > briefTimeoutMs) break;
        callsMade++;
        const id = cluster.id as string;
        try {
          llmResults.set(
            id,
            await this.deps.llmClient.generateSummary(
              cluster.title,
              cluster.summary,
              (articlesByCluster.get(id) ?? []).map((a) => ({
                url: a.url,
                title: a.title,
                body: a.body,
              })),
            ),
          );
        } catch {
          llmResults.set(id, null);
        }
      }
      // For any clusters not processed (beyond maxLlm or failed), fall back to extractive
      for (const cluster of selected) {
        if (!llmResults.has(cluster.id as string)) llmResults.set(cluster.id as string, null);
      }
    }

    // The application routes on the slug, not the id.
    const topicUrl = `${appBaseUrl}/topics/${encodeURIComponent(topic.slug)}`;
    const date = formatDate(plan.createdAt);
    // The old footer linked to `/unsubscribe/topic` and `/unsubscribe/all` with a
    // literal `TOKEN` in the query string, and neither route is registered
    // anywhere in the application: a link that looks real and answers 404 is
    // worse than no link. The footer points at the two things a reader can
    // actually do. Real one-click unsubscribe is a separate change - it needs an
    // opt-out the send path honours, and no route consumes the token yet.
    const links: readonly EmailLink[] = [
      { href: `${appBaseUrl}/settings/delivery`, label: 'Change delivery time' },
      { href: `${appBaseUrl}/pick-topics`, label: 'Manage topics' },
      { href: `${appBaseUrl}/topics`, label: 'All your topics' },
    ];

    const sections = selected.map((cluster) =>
      this.renderCluster(cluster, articlesByCluster.get(cluster.id as string) ?? [], llmResults.get(cluster.id as string) ?? null),
    );

    return {
      subject: `${topic.title} - Brieflyy`,
      html: emailDocument({
        title: `${topic.title} - Brieflyy`,
        heading: topic.title,
        preheader: `Your ${topic.title} brief`,
        date,
        viewInAppUrl: topicUrl,
        content: sections.map((s) => s.html).join(''),
        links,
      }),
      text: plainTextBrief({ heading: topic.title, date, viewInAppUrl: topicUrl, sections, links }),
    };
  }

  /**
   * One Cluster: its heading, its one-liner, and its bullets.
   *
   * Both paths — generated and extractive — put a link on every bullet that has
   * one to point at. The generated path is given the Article each bullet came
   * from; the extractive path has only a sentence, so it looks the sentence up
   * against the Cluster's own Articles. A bullet with no linkable origin is
   * still quoted, in plain text, because dropping it would quietly shorten a
   * brief the plan says includes it.
   */
  private renderCluster(
    cluster: { readonly title: string; readonly summary: string; readonly bulletPoints: readonly string[] },
    articles: readonly Article[],
    llmResult: LLMSummaryOutput | null,
  ): { html: string; text: string } {
    const heading = (llmResult ? llmResult.summary || cluster.title : cluster.title).trim();
    const bullets: { text: string; url: string | null }[] = llmResult
      ? llmResult.bulletPoints.map((b) => ({ text: b.text, url: safeExternalUrl(b.articleUrl) }))
      : cluster.bulletPoints.map((b) => ({
          text: b,
          url: safeExternalUrl(articleUrlForStatement(b, articles) ?? ''),
        }));

    const oneLiner = llmResult ? '' : cluster.summary;

    return {
      html:
        `<h2 style="${H2}">${escapeHtml(heading)}</h2>` +
        (oneLiner ? `<p style="${P}">${escapeHtml(oneLiner)}</p>` : '') +
        `<ul style="${UL}">${bullets.map((b) => `<li style="${LI}">${bulletHtml(b)}</li>`).join('')}</ul>`,
      text: textSection(heading, oneLiner, bullets),
    };
  }
}

/** A bullet as an anchor when it has an Article to point at, and as text when it does not. */
function bulletHtml(bullet: { text: string; url: string | null }): string {
  const text = escapeHtml(bullet.text);
  if (bullet.url === null) return text;
  return `<a href="${escapeHtml(bullet.url)}" target="_blank" rel="noopener" style="${LINK}">${text}</a>`;
}

interface EmailLink {
  readonly href: string;
  readonly label: string;
}

interface BriefSection {
  readonly html: string;
  readonly text: string;
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

/**
 * The brief as plain text.
 *
 * Not a stripped copy of the HTML: a client that shows this is showing a reader
 * the brief, so it is composed rather than derived. Every part a reader needs to
 * act on the brief — the call to action, every bullet's source — is spelled out,
 * because a link is the one thing markup carries that text cannot leave implicit.
 */
function plainTextBrief(input: {
  readonly heading: string;
  readonly date: string;
  readonly viewInAppUrl: string;
  readonly sections: readonly BriefSection[];
  readonly links: readonly EmailLink[];
}): string {
  return [
    `Brieflyy - ${input.date}`,
    '',
    input.heading,
    '',
    `View this brief in Brieflyy: ${input.viewInAppUrl}`,
    ...input.sections.flatMap((s) => ['', s.text]),
    '',
    'You are receiving this because you signed up for a Brieflyy brief on this topic.',
    input.links.map((l) => `${l.label}: ${l.href}`).join('\n'),
  ].join('\n');
}

function textSection(
  heading: string,
  oneLiner: string,
  bullets: readonly { text: string; url: string | null }[],
): string {
  return [
    heading,
    ...(oneLiner ? [oneLiner] : []),
    ...bullets.map((b) => (b.url === null ? `  - ${b.text}` : `  - ${b.text}\n    ${b.url}`)),
  ].join('\n');
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
