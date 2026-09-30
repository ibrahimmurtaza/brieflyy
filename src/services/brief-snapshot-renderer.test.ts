import { describe, expect, it } from 'vitest';
import { BriefSnapshotRenderer } from './brief-snapshot-renderer.js';
import type { LLMSummaryClient, LLMSummaryOutput } from '../domain/llm.js';
import { bulletsFrom, oneLinerFrom } from '../domain/cluster-text.js';
import type { Article } from '../domain/types.js';
import { systemClock } from '../domain/clock.js';
import { makeArticle } from '../testing/fixtures.js';
import { makeTestClock } from '../testing/test-clocks.js';
import { RecordingSummaryClient } from '../testing/summary-client.js';

const PLAN = {
  id: 'p1',
  topicId: 'topic-1',
  userId: 'u1',
  createdAt: new Date('2026-09-02T12:00:00Z'),
  clusterIds: ['c1'],
};

const TOPIC = { id: 'topic-1', slug: 'world-news', title: 'World news' };

/** The pair of tokens a brief carries, one per scope. */
const TOKENS = { topicToken: 'topic-token', globalToken: 'global-token' };

function makeCluster(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'c1',
    topicId: 'topic-1',
    title: 'Cluster 1',
    summary: 'Extractive summary',
    bulletPoints: ['b1'],
    createdAt: new Date('2026-09-01T00:00:00Z'),
    lastSeenAt: new Date('2026-09-01T00:00:00Z'),
    articleCount: 1,
    velocity: 1,
    sourceIds: ['s1'],
    state: 'active',
    ...overrides,
  };
}

/** The Topic the renderer names and links to. Required: there is no id fallback. */
const topicRepo = { getById: async () => TOPIC } as never;

function clusterRepo(
  clusters: readonly Record<string, unknown>[],
  articlesByCluster: Readonly<Record<string, readonly Article[]>> = {},
): never {
  return {
    listByTopicId: async () => clusters,
    listArticlesByClusterId: async (id: string) => articlesByCluster[id] ?? [],
  } as never;
}

class MockLLMClient implements LLMSummaryClient {
  async generateSummary(
    _clusterTitle: string,
    _clusterSummary: string,
    _articles: readonly { url: string; title: string; body: string }[],
  ): Promise<LLMSummaryOutput | null> {
    return {
      summary: 'LLM generated summary',
      bulletPoints: [
        { text: 'Point one', articleUrl: 'https://example.com/article-1' },
      ],
    };
  }
}

/**
 * `count` Clusters, each with its own title, one-liner, bullet and Article.
 *
 * An Article per Cluster because that is the only state a real one is ever in,
 * and a bullet's source link has nothing to point at without one — the
 * assertions that matter would otherwise be about a fixture that cannot happen.
 */
function aPlanOf(count: number): {
  readonly clusters: Record<string, unknown>[];
  readonly articles: Record<string, readonly Article[]>;
} {
  const articles: Record<string, readonly Article[]> = {};
  const clusters = Array.from({ length: count }, (_unused, i) => {
    articles[`c${i}`] = [makeArticle({ id: `a-${i}`, url: `https://example.com/a-${i}` })];
    return makeCluster({
      id: `c${i}`,
      title: `Story ${i}`,
      summary: `Extractive ${i}`,
      bulletPoints: [`Bullet ${i}`],
    });
  });
  return { clusters, articles };
}

function planOf(ids: readonly string[]): typeof PLAN {
  return { ...PLAN, clusterIds: [...ids] };
}

describe('BriefSnapshotRenderer', () => {
  it('renders LLM summary when available', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()], {
        c1: [makeArticle({ id: 'article-1' })],
      }),
      topicRepo,
      llmClient: new MockLLMClient(),
      maxLlmClusters: 5,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app', TOKENS);
    expect(html).toContain('LLM generated summary');
    expect(html).toContain('Point one');
    expect(html).toContain('https://example.com/article-1');
  });

  it('falls back to extractive when LLM client is missing', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app', TOKENS);
    expect(html).toContain('Extractive summary');
    expect(html).toContain('b1');
  });
});

describe('BriefSnapshotRenderer generation', () => {
  it('writes the top of the Plan, in the order the Plan chose them', async () => {
    // The Plan is an ordering, so "the top N" is a decision it already made. A
    // renderer that took the top N of the Cluster table instead would write a
    // different brief for the same Plan depending on how the rows came back.
    const plan = aPlanOf(4);
    const client = new RecordingSummaryClient();
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
      maxLlmClusters: 2,
    });

    const { html } = await renderer.render(
      planOf(['c2', 'c0', 'c1', 'c3']) as never,
      'https://app',
      TOKENS,
    );

    expect(client.calls.map((c) => c.clusterTitle)).toEqual(['Story 2', 'Story 0']);
    expect(html).toContain('Written summary of Story 2');
    expect(html).toContain('Written summary of Story 0');
    // And the rest of the Plan is still in the brief, quoted rather than written.
    expect(html).toContain('Extractive 1');
    expect(html).toContain('Extractive 3');
  });

  it('spends no more than N calls on one brief, however many Clusters it carries', async () => {
    const plan = aPlanOf(8);
    const client = new RecordingSummaryClient();
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
      maxLlmClusters: 3,
    });

    const { html } = await renderer.render(
      planOf(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']) as never,
      'https://app',
      TOKENS,
    );

    expect(client.callCount).toBe(3);
    expect(html).toContain('Extractive 7');
  });

  it('writes each Cluster from that Clusters own Articles and no others', async () => {
    // The citation constraint is only meaningful if the Articles offered are the
    // Clusters: a client handed the whole Topics reading can satisfy every
    // citation it is given and the constraint says nothing.
    const plan = aPlanOf(2);
    const client = new RecordingSummaryClient();
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
    });

    await renderer.render(planOf(['c0', 'c1']) as never, 'https://app', TOKENS);

    expect(client.calls[0]?.articleUrls).toEqual(['https://example.com/a-0']);
    expect(client.calls[1]?.articleUrls).toEqual(['https://example.com/a-1']);
  });

  it('quotes the Cluster whose call failed, and keeps the ones that worked', async () => {
    // One Cluster losing its written summary is not a failed brief: the extractive
    // summary is what that Cluster is shown with everywhere else, so falling back
    // is the shape of the answer rather than a hole in it.
    const plan = aPlanOf(3);
    const client = new RecordingSummaryClient((call) => {
      if (call.clusterTitle === 'Story 1') throw new Error('the endpoint fell over');
      return undefined;
    });
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
    });

    const { html } = await renderer.render(
      planOf(['c0', 'c1', 'c2']) as never,
      'https://app',
      TOKENS,
    );

    expect(html).toContain('Written summary of Story 0');
    expect(html).toContain('Extractive 1');
    expect(html).toContain('Written summary of Story 2');
    // A thrown call does not stop the ones after it, because the brief is more
    // than the Cluster that failed.
    expect(client.callCount).toBe(3);
  });

  it('quotes a Cluster the client declined, and carries on with the ones it wrote', async () => {
    const plan = aPlanOf(2);
    const client = new RecordingSummaryClient((call) =>
      call.clusterTitle === 'Story 0' ? null : undefined,
    );
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
    });

    const { html } = await renderer.render(planOf(['c0', 'c1']) as never, 'https://app', TOKENS);

    expect(html).toContain('Extractive 0');
    expect(html).toContain('Written summary of Story 1');
  });

  it('quotes a Cluster the client answered with nothing quotable in', async () => {
    // A heading over an empty list is not a shorter brief, it is a broken one. A
    // Cluster is shown with prose and bullets, so an answer with the bullets gone
    // gets the Cluster's own summary rather than a title and nothing under it.
    const plan = aPlanOf(2);
    const client = new RecordingSummaryClient((call) =>
      call.clusterTitle === 'Story 0'
        ? { summary: 'A heading with nothing under it.', bulletPoints: [] }
        : undefined,
    );
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
    });

    const { html } = await renderer.render(planOf(['c0', 'c1']) as never, 'https://app', TOKENS);

    expect(html).not.toContain('A heading with nothing under it.');
    expect(html).toContain('Extractive 0');
    expect(html).toContain('Written summary of Story 1');
  });

  it('keeps the Clusters own prose when a written answer has bullets but no one-liner', async () => {
    // The prose and the bullets are separate answers, so they fall back
    // separately: replacing a sentence a Source wrote with a bare title would
    // leave the reader with less than the quoted path gave them.
    const plan = aPlanOf(1);
    const client = new RecordingSummaryClient(() => ({
      summary: '',
      bulletPoints: [{ text: 'A point.', articleUrl: 'https://example.com/a-0' }],
    }));
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
    });

    const { html } = await renderer.render(planOf(['c0']) as never, 'https://app', TOKENS);

    expect(html).toContain('Story 0');
    expect(html).toContain('Extractive 0');
    expect(html).toContain('A point.');
  });

  it('quotes the rest of the brief once its time budget is spent', async () => {
    // A brief is sent on a schedule, so the whole plan is not available to wait
    // for: past the budget the remaining Clusters are quoted rather than the
    // reader getting nothing because one call was slow.
    const plan = aPlanOf(4);
    const clock = makeTestClock(PLAN.createdAt);
    const client = new RecordingSummaryClient((call) => {
      clock.advance(20_000);
      return {
        summary: `Written: ${call.clusterTitle}`,
        bulletPoints: [{ text: 'A point.', articleUrl: 'https://example.com/a-0' }],
      };
    });
    const renderer = new BriefSnapshotRenderer({
      clock: clock.clock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
      maxLlmClusters: 4,
      briefLlmTimeoutMs: 15_000,
    });

    const { html } = await renderer.render(
      planOf(['c0', 'c1', 'c2', 'c3']) as never,
      'https://app',
      TOKENS,
    );

    expect(client.callCount).toBe(1);
    expect(html).toContain('Written: Story 0');
    expect(html).toContain('Extractive 3');
  });

  it('links every bullet it writes to the Article that bullet cites', async () => {
    const client = new RecordingSummaryClient(() => ({
      summary: 'Written.',
      bulletPoints: [
        { text: 'First point.', articleUrl: 'https://example.com/a-1' },
        { text: 'Second point.', articleUrl: 'https://example.com/a-2' },
      ],
    }));
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(aPlanOf(1).clusters, {
        c0: [
          makeArticle({ id: 'a-1', url: 'https://example.com/a-1' }),
          makeArticle({ id: 'a-2', url: 'https://example.com/a-2' }),
        ],
      }),
      topicRepo,
      llmClient: client,
    });

    const { html, text } = await renderer.render(planOf(['c0']) as never, 'https://app', TOKENS);

    expect(html).toContain(
      '<a href="https://example.com/a-1" target="_blank" rel="noopener" style="color:#1856c4;">First point.</a>',
    );
    expect(html).toContain(
      '<a href="https://example.com/a-2" target="_blank" rel="noopener" style="color:#1856c4;">Second point.</a>',
    );
    // The text alternative has no anchor to click, so it spells the URL out.
    expect(text).toContain('https://example.com/a-1');
    expect(text).toContain('https://example.com/a-2');
  });

  it('will not link a written bullet to an unsafe scheme', async () => {
    // The constraint is that a bullet cites an Article of the Cluster, not that
    // the Article's URL is safe to put in an anchor, so the scheme is checked
    // where the anchor is built rather than trusted from the citation.
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(aPlanOf(1).clusters, {
        c0: [makeArticle({ id: 'a-1', url: 'javascript:alert(1)' })],
      }),
      topicRepo,
      llmClient: new RecordingSummaryClient(() => ({
        summary: 'Written.',
        bulletPoints: [{ text: 'A point.', articleUrl: 'javascript:alert(1)' }],
      })),
    });

    const { html, text } = await renderer.render(planOf(['c0']) as never, 'https://app', TOKENS);

    expect(html).not.toContain('javascript:');
    expect(text).not.toContain('javascript:');
    expect(html).toContain('A point.');
  });

  it('writes nothing at all when the top of the Plan is switched off', async () => {
    // Zero is a configuration, not a mistake: a deployment with a key it is not
    // using yet turns the written path off without unsetting the credential.
    const plan = aPlanOf(3);
    const client = new RecordingSummaryClient();
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(plan.clusters, plan.articles),
      topicRepo,
      llmClient: client,
      maxLlmClusters: 0,
    });

    const { html } = await renderer.render(
      planOf(['c0', 'c1', 'c2']) as never,
      'https://app',
      TOKENS,
    );

    expect(client.calls).toEqual([]);
    expect(html).toContain('Extractive 0');
  });
});

describe('BriefSnapshotRenderer as a delivered document', () => {
  it('is a real document: doctype, language, viewport, and a width', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain('max-width:600px');
  });

  it('names the Topic rather than calling every brief "Brief"', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html, subject } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    expect(html).toContain('<h1 style="margin:8px 0 0 0;font-size:22px;line-height:1.25;color:#111827;">World news</h1>');
    expect(html).toContain('<title>World news - Brieflyy</title>');
    expect(subject).toBe('World news - Brieflyy');
    expect(html).not.toContain('<h1>Brief</h1>');
  });

  it('links into the app by slug, which is what the app routes on', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    expect(html).toContain('href="https://app/topics/world-news"');
    expect(html).not.toContain('href="https://app/topics/topic-1"');
  });

  it('carries both unsubscribe links, in the body and in the text', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html, text } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    // The routes these point at are registered (route-guard.test.ts checks the
    // allowlist against the routes the application actually registers), so a
    // reader who follows one in a client without one-click support gets an
    // answer rather than a 404 wearing the costume of a working link.
    expect(html).toContain('href="https://app/unsubscribe/topic?token=topic-token"');
    expect(html).toContain('href="https://app/unsubscribe/all?token=global-token"');
    // Both scopes, because a reader who wants neither this topic nor the rest
    // should not have to work out which button does which.
    expect(html).toContain('Stop World news briefs');
    expect(html).toContain('Stop all Brieflyy emails');
    // And the plain-text half carries the URLs, since a text-only client shows
    // no anchor to click.
    expect(text).toContain('https://app/unsubscribe/topic?token=topic-token');
    expect(text).toContain('https://app/unsubscribe/all?token=global-token');
  });

  it('asks the mail client for one-click unsubscribe, per RFC 8058', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { headers } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    // A client that honours these renders its own control and never shows the
    // links in the body, so the body alone is not an unsubscribe feature.
    expect(headers['List-Unsubscribe']).toBe(
      '<https://app/unsubscribe/topic?token=topic-token>, <https://app/unsubscribe/all?token=global-token>',
    );
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('still offers the pages a reader can manage from', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    // Unsubscribe is not the only thing a reader can do with a brief, and a
    // footer that only offers the two stop buttons is a smaller one.
    expect(html).toContain('href="https://app/settings/delivery"');
    expect(html).toContain('href="https://app/pick-topics"');
  });

  it('dates the brief, so two of them are tellable apart', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo,
    });

    const { html, text } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    expect(html).toContain('2 September 2026');
    expect(text).toContain('2 September 2026');
  });

  it('names the Topic in the subject and nowhere leaks the internal id', async () => {
    // The fallback this renderer used to have put `plan.topicId` in the link
    // when no Topic was loaded, so the call to action pointed at a URL form the
    // application does not serve and the heading read as an identifier. There is
    // no id to fall back to now: a brief that cannot name its Topic is not
    // rendered at all.
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster()]),
      topicRepo: { getById: async () => null } as never,
    });

    await expect(renderer.render(PLAN as never, 'https://app', TOKENS)).rejects.toThrow(
      /topic-1/,
    );
  });
});

describe('BriefSnapshotRenderer bullets', () => {
  const articles = [
    makeArticle({
      id: 'a-1',
      body: 'Acme Corp unveiled Foo today. Analysts were surprised by the launch.',
    }),
    makeArticle({
      id: 'a-2',
      body: 'Regulators opened a review into the Acme Corp launch.',
    }),
  ];
  const bulletPoints = bulletsFrom(articles, 3, oneLinerFrom(articles[0]!));
  const clusters = [makeCluster({ bulletPoints })];

  it('links every bullet it quotes, on the extractive path', async () => {
    // A bullet is a sentence lifted verbatim from an Article, so the Article it
    // came from is already known. Rendering it as plain text asks the reader to
    // take the attribution on trust, which is the one thing a brief quoting
    // Sources should not ask.
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(clusters, { c1: articles }),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    for (const bullet of bulletPoints) {
      expect(html).toContain(`>${bullet}</a>`);
    }
    expect(html).toContain('href="https://example.com/a-1"');
    expect(html).toContain('href="https://example.com/a-2"');
  });

  it('still quotes a bullet it cannot attribute, rather than dropping it', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo([makeCluster({ bulletPoints: ['A sentence no Article here says.'] })]),
      topicRepo,
    });

    const { html } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    expect(html).toContain('A sentence no Article here says.');
  });

  it('will not link a URL in an unsafe scheme, on either path', async () => {
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(
        [makeCluster({ bulletPoints: ['Acme Corp unveiled Foo today.'] })],
        { c1: [makeArticle({ id: 'a-1', url: 'javascript:alert(1)', body: 'Acme Corp unveiled Foo today.' })] },
      ),
      topicRepo,
    });

    const { html, text } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    expect(html).not.toContain('javascript:');
    expect(text).not.toContain('javascript:');
  });

  it('renders the Clusters in the order the Plan chose them', async () => {
    // The Plan is a selection *and an ordering*: the velocity it sorted by is a
    // decision taken at a moment, and a brief that re-derives its own order from
    // the Cluster table throws that decision away.
    const ordered = [
      makeCluster({ id: 'c-slow', title: 'Second story', summary: 'B summary' }),
      makeCluster({ id: 'c-fast', title: 'First story', summary: 'A summary' }),
    ];
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(ordered),
      topicRepo,
    });

    const { html, text } = await renderer.render(
      { ...PLAN, clusterIds: ['c-fast', 'c-slow'] } as never,
      'https://app',
      TOKENS,
    );

    expect(html.indexOf('First story')).toBeLessThan(html.indexOf('Second story'));
    expect(text.indexOf('A summary')).toBeLessThan(text.indexOf('B summary'));
  });
});

describe('BriefSnapshotRenderer as a plain-text alternative', () => {
  const articles = [
    makeArticle({ id: 'a-1', body: 'Acme Corp unveiled Foo today. Analysts were surprised.' }),
  ];

  it('carries the same brief as the HTML, with no markup in it', async () => {
    // `EmailMessage.text` is required, and a client that falls back to it is
    // showing a reader the brief, not an error. So the text part is the brief
    // written in plain text rather than the HTML with tags stripped, and it
    // carries the same links.
    const renderer = new BriefSnapshotRenderer({
      clock: systemClock,
      clusterRepo: clusterRepo(
        [makeCluster({ bulletPoints: ['Analysts were surprised.'] })],
        { c1: articles },
      ),
      topicRepo,
    });

    const { text } = await renderer.render(PLAN as never, 'https://app', TOKENS);

    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).toContain('World news');
    expect(text).toContain('2 September 2026');
    expect(text).toContain('https://app/topics/world-news');
    expect(text).toContain('Extractive summary');
    expect(text).toContain('Analysts were surprised.');
    expect(text).toContain('https://example.com/a-1');
  });
});
