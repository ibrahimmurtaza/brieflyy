import type { Article, BriefGeneration, BriefPlan, Cluster } from '../domain/types.js';
import { NO_GENERATION } from '../domain/types.js';
import type { ClusterRepo } from '../repos/cluster-repo.js';
import type { TopicRepo } from '../repos/topic-repo.js';
import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';
import type { Clock } from '../domain/clock.js';
import { articleUrlForStatement } from '../domain/cluster-text.js';
import { escapeHtml } from '../domain/html.js';
import { safeExternalUrl } from '../domain/url.js';
import {
  BRIEF_GENERATED_CLUSTERS_DEFAULT,
  BRIEF_GENERATION_BUDGET_MS_DEFAULT,
} from '../config.js';
import {
  allUnsubscribeUrl,
  oneClickHeaders,
  topicUnsubscribeUrl,
} from './unsubscribe-links.js';

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
  /**
   * The RFC 8058 headers, which are the only way a mail client learns it may
   * render a one-click unsubscribe control. A brief cannot be unsubscribable
   * without them, whatever its body says.
   */
  readonly headers: Readonly<Record<string, string>>;
  /**
   * What writing it cost. Part of what rendering produced rather than of the
   * document, and never stored on the snapshot: a brief is a thing a User reads,
   * and how many calls the machine made to assemble it is not part of it. It is
   * returned because the written path fails quietly by design, and the only place
   * that can be noticed is the job that sent the brief.
   */
  readonly generation: BriefGeneration;
}

/**
 * The two tokens a brief carries, one per scope.
 *
 * Required rather than optional because a brief without them cannot be
 * unsubscribed from: a rendered document is stored as sent and never
 * regenerated, so a link added to the renderer tomorrow would never reach the
 * briefs already in inboxes. The caller mints them before rendering for the same
 * reason — the renderer has to write them into a document that will not be
 * rendered again.
 */
export interface BriefUnsubscribe {
  /** Stops this Topic's briefs. */
  readonly topicToken: string;
  /** Stops every brief for the User the brief went to. */
  readonly globalToken: string;
}

export interface BriefSnapshotRendererDeps {
  readonly clusterRepo: ClusterRepo;
  /**
   * What "now" is, for the brief's own time budget. Required because the budget
   * is a promise the application makes to its Users — a brief is sent on a
   * schedule and the schedule does not move — and a promise measured against a
   * clock nobody can hand a test is a promise nothing can check.
   */
  readonly clock: Clock;
  /**
   * The written half of a brief, or nothing at all when the deployment has none
   * configured. Absent is the ordinary state rather than a degraded one: a brief
   * built from the extractive summary is a complete brief, so the renderer runs
   * the same way either way and only the leading Clusters differ.
   */
  readonly llmClient?: LLMSummaryClient | undefined;
  /** How many Clusters of the plan are written rather than quoted. Defaults to five. */
  readonly maxLlmClusters?: number | undefined;
  /**
   * How long one brief's writing may take before the rest of it is quoted
   * instead. Defaults to the shared brief budget.
   */
  readonly briefLlmTimeoutMs?: number | undefined;
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

  async render(
    plan: BriefPlan,
    appBaseUrl: string,
    unsubscribe: BriefUnsubscribe,
  ): Promise<RenderedBrief> {
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

    const { summaries, generation } = await this.writeLeadingClusters(
      selected,
      articlesByCluster,
    );

    // The application routes on the slug, not the id.
    const topicUrl = `${appBaseUrl}/topics/${encodeURIComponent(topic.slug)}`;
    const date = formatDate(plan.createdAt);
    const links: readonly EmailLink[] = [
      { href: `${appBaseUrl}/settings/delivery`, label: 'Change delivery time' },
      { href: `${appBaseUrl}/pick-topics`, label: 'Manage topics' },
      { href: `${appBaseUrl}/topics`, label: 'All your topics' },
    ];

    // Both scopes, in the body as well as in the headers. The headers are what a
    // client that supports one-click acts on and shows nothing for; the body is
    // what every other client shows, and a reader who has to go looking for a
    // menu item to stop the mail will not.
    const unsubscribeUrls = {
      topic: topicUnsubscribeUrl(appBaseUrl, unsubscribe.topicToken),
      global: allUnsubscribeUrl(appBaseUrl, unsubscribe.globalToken),
    };
    const unsubscribeLinks: readonly EmailLink[] = [
      { href: unsubscribeUrls.topic, label: `Stop ${topic.title} briefs` },
      {
        href: unsubscribeUrls.global,
        label: 'Stop all Brieflyy emails',
      },
    ];

    const sections = selected.map((cluster) =>
      this.renderCluster(cluster, articlesByCluster.get(cluster.id as string) ?? [], summaries.get(cluster.id as string) ?? null),
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
        unsubscribeLinks,
      }),
      text: plainTextBrief({
        heading: topic.title,
        date,
        viewInAppUrl: topicUrl,
        sections,
        links,
        unsubscribeLinks,
      }),
      headers: oneClickHeaders(unsubscribeUrls),
      generation,
    };
  }

  /**
   * The written summaries for the leading Clusters of the plan, and what getting
   * them cost.
   *
   * Absence is the fallback, not a stored null: a Cluster that is missing from
   * `summaries` is quoted, whether it was never asked about, the call failed, or
   * there was nothing quotable in the answer. So there is exactly one thing a
   * caller has to check and one way for a brief to degrade.
   *
   * A summary with no bullets is treated as no summary at all, whoever produced
   * it. A Cluster is shown with a heading and some bullets, so a heading over an
   * empty list is not a shorter brief, it is a broken one — and the Cluster's own
   * extractive summary is both a better heading and the thing every other surface
   * shows for it. The bullets it lost are still counted, because a Cluster
   * quietly losing every one of them is the thing worth being able to see.
   *
   * The plan is sliced first and the slice is what is iterated, so the number of
   * calls is a property of the plan rather than of how a counter happened to
   * break — a brief cannot be billed for more Clusters than were asked for. A
   * written top-N larger than the plan carries writes the whole plan, which is
   * the only reading of the two numbers that means anything.
   */
  private async writeLeadingClusters(
    selected: readonly Cluster[],
    articlesByCluster: ReadonlyMap<string, readonly Article[]>,
  ): Promise<{ summaries: ReadonlyMap<string, LLMSummaryOutput>; generation: BriefGeneration }> {
    const client = this.deps.llmClient;
    if (!client) return { summaries: new Map(), generation: NO_GENERATION };

    const leading = selected.slice(
      0,
      this.deps.maxLlmClusters ?? BRIEF_GENERATED_CLUSTERS_DEFAULT,
    );
    const budgetMs = this.deps.briefLlmTimeoutMs ?? BRIEF_GENERATION_BUDGET_MS_DEFAULT;
    const startedAt = this.deps.clock.now().getTime();
    const summaries = new Map<string, LLMSummaryOutput>();
    let calls = 0;
    let discardedBullets = 0;

    for (const cluster of leading) {
      // Measured before the call rather than after, so a budget that is already
      // spent does not start one more, and so a call in flight is the last thing
      // a brief waits for rather than the first thing it can be cut short of.
      if (this.deps.clock.now().getTime() - startedAt > budgetMs) break;

      const id = cluster.id as string;
      // Counted before the call, so a client that throws still cost a request. A
      // call that fails is the most expensive kind to under-report.
      calls += 1;
      try {
        const summary = await client.generateSummary(
          cluster.title,
          cluster.summary,
          (articlesByCluster.get(id) ?? []).map((a) => ({
            url: a.url,
            title: a.title,
            body: a.body,
          })),
        );
        if (summary === null) continue;
        discardedBullets += summary.discardedBullets;
        if (summary.bulletPoints.length > 0) summaries.set(id, summary);
      } catch {
        // A client that throws is the same shape as one that declines: this
        // Cluster is quoted. The rest of the brief is not the casualty of one
        // call, so the loop carries on.
      }
    }

    return {
      summaries,
      generation: { writtenClusters: summaries.size, calls, discardedBullets },
    };
  }

  /**
   * One Cluster: its heading, its one-liner, and its bullets.
   *
   * Both paths — written and quoted — put a link on every bullet that has one to
   * point at. The written path is given the Article each bullet came from; the
   * quoted path has only a sentence, so it looks the sentence up against the
   * Cluster's own Articles. A bullet with no linkable origin is still quoted,
   * in plain text, because dropping it would quietly shorten a brief the plan
   * says includes it.
   *
   * The prose and the bullets fall back separately, because they arrive
   * separately: an answer with bullets and no one-liner gets the Cluster's own
   * one-liner as its prose, because dropping that would replace a sentence a
   * Source wrote with a bare title.
   */
  private renderCluster(
    cluster: Pick<Cluster, 'title' | 'summary' | 'bulletPoints'>,
    articles: readonly Article[],
    written: LLMSummaryOutput | null,
  ): { html: string; text: string } {
    const oneLiner = (written?.summary || cluster.summary).trim();
    const heading = (written?.summary || cluster.title).trim();
    const bullets: { text: string; url: string | null }[] = written
      ? written.bulletPoints.map((b) => ({ text: b.text, url: safeExternalUrl(b.articleUrl) }))
      : cluster.bulletPoints.map((b) => ({
          text: b,
          url: safeExternalUrl(articleUrlForStatement(b, articles) ?? ''),
        }));

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
  readonly unsubscribeLinks: readonly EmailLink[];
}): string {
  const linksHtml = linkRow(input.links);
  const unsubscribeHtml = linkRow(input.unsubscribeLinks);

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
<tr><td style="padding:0 28px 20px 28px;font-family:${FONT};">
  <p style="margin:16px 0 0 0;font-size:13px;line-height:1.6;color:#5b6472;">You are receiving this because you signed up for a Brieflyy brief on this topic.</p>
  <p style="margin:8px 0 0 0;font-size:13px;line-height:1.6;">${linksHtml}</p>
</td></tr>
<tr><td style="padding:0 28px 28px 28px;border-top:1px solid #e9ecf0;font-family:${FONT};">
  <p style="margin:16px 0 0 0;font-size:13px;line-height:1.6;color:#5b6472;">${unsubscribeHtml}</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

/** A line of links, joined the way a footer reads: one, then the next. */
function linkRow(links: readonly EmailLink[]): string {
  return links
    .map(
      (l) =>
        `<a href="${escapeHtml(l.href)}" style="color:#1856c4;text-decoration:underline;">${escapeHtml(l.label)}</a>`,
    )
    .join(' &middot; ');
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
  readonly unsubscribeLinks: readonly EmailLink[];
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
    '',
    ...input.unsubscribeLinks.map((l) => `${l.label}: ${l.href}`),
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
