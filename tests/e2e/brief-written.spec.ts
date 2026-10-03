import type { Page } from '@playwright/test';

import { test, expect } from './fixtures.js';
import { E2E_EMAIL, E2E_TOPIC_SLUG } from './fixture-data.js';

/**
 * A brief a User asked for, followed the way a reader would.
 *
 * Every other written-path spec in the suite builds a renderer, writes its output
 * to a temp file and opens that as `file://`. That answers "is this anchor real"
 * and nothing else: it cannot fail if the send path stopped passing the Articles
 * through, if the written text stopped being stored, or if the route a reader is
 * pointed at stopped serving what was sent. Those are the failures that reach
 * mailboxes, and this spec is the one that goes through the whole path — press the
 * button, follow the link the topic page offers, read what comes back.
 *
 * Serial, because the specs share one server process and this one leaves a
 * BriefSnapshot behind — the same reason `unsubscribe.spec.ts` is.
 */
test.describe.configure({ mode: 'serial' });

test.describe('a brief that was written rather than quoted', () => {
  test('the topic page offers to send one, and says so once it has', async ({
    signedInPage: page,
  }) => {
    await page.goto(`/topics/${E2E_TOPIC_SLUG}`);

    await page.getByRole('button', { name: 'Email me this brief now' }).click();
    await expect(page.getByText(/sent to .*@/)).toBeVisible();
  });

  test('the brief the topic page links to carries the written summary', async ({
    signedInPage: page,
  }) => {
    // Found the way a reader finds it: the topic page lists the briefs it has
    // already sent, because a sent brief is otherwise reachable only from an
    // inbox. Following that link is the whole point — it is the same route the
    // call to action in the email points at.
    await page.goto(`/topics/${E2E_TOPIC_SLUG}`);
    const sent = page.locator('a[href^="/briefs/"]').first();
    await expect(sent).toBeVisible();
    await sent.click();

    // The written heading, not the Cluster's own title: the point of the
    // feature is that the leading Clusters read as prose.
    await expect(
      page.getByRole('heading', { name: 'Written summary of Acme Corp unveils Foo' }),
    ).toBeVisible();
  });

  test('every bullet in it is a real link to the Article it cites', async ({
    signedInPage: page,
  }) => {
    await page.goto(`/topics/${E2E_TOPIC_SLUG}`);
    await page.locator('a[href^="/briefs/"]').first().click();

    // The fixture's one Article, which is the only URL a bullet of that Cluster
    // is allowed to cite. A brief whose bullets are bare text satisfies every
    // string assertion in the vitest suite and fails here.
    const link = page.locator('li a[href="https://www.theguardian.com/acme-foo"]');
    await expect(link).toBeVisible();
    await expect(link).toHaveText('A written point.');
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', 'noopener');
  });

  test('the LivingBrief still quotes the Cluster, and never shows the written one', async ({
    signedInPage: page,
  }) => {
    // The decision ADR-0013 records, seen from both sides at once. The page and
    // the email are about the same Cluster; one of them is written and the other
    // is not, and that is the intended difference rather than a bug in one of
    // them. A page that regenerated would say something new on every visit.
    await page.goto(`/topics/${E2E_TOPIC_SLUG}`);

    await expect(
      page.getByRole('heading', { name: /Acme Corp unveiled Foo today, and analysts are split/ }),
    ).toBeVisible();
    await expect(page.getByText('Written summary of')).toHaveCount(0);
  });

  test('a brief is a document a browser renders, not a wall of markup', async ({
    signedInPage: page,
  }) => {
    await page.goto(`/topics/${E2E_TOPIC_SLUG}`);
    await page.locator('a[href^="/briefs/"]').first().click();

    // The brief is served exactly as it was emailed, so it brings its own layout
    // and nothing else does: a 600px table inside a full-width one, which is what
    // Outlook and Gmail both render without surprises, and both unsubscribe
    // scopes still present.
    await expect(
      page.locator('table[role="presentation"] table[role="presentation"]'),
    ).toHaveCount(1);
    await expect(page.locator('a[href*="/unsubscribe/topic"]')).toHaveCount(1);
    await expect(page.locator('a[href*="/unsubscribe/all"]')).toHaveCount(1);
  });

test('the document in the browser is the one that was stored', async ({
    signedInPage: page,
  }) => {
    // A BriefSnapshot is the brief as it was sent, and the call to action in the
    // email points at it rather than at a fresh rendering. Nothing above can tell
    // the two apart: every other assertion here reads whatever the route served, so
    // a route that regenerated the brief from today's Clusters would pass all of
    // them while showing a reader something they were never sent.
    const stored = await latestBrief(page);
    expect(stored.topicSlug).toBe(E2E_TOPIC_SLUG);
    // Both halves of the snapshot, not only the rendered one: the plain text is
    // what a plain-text reader was sent, and nothing else in this file would notice
    // it going missing.
    expect(stored.html).toContain('Written summary of Acme Corp unveils Foo');
    expect(stored.text).toContain('Written summary of Acme Corp unveils Foo');

    // And what the route serves is that row, byte for byte, rather than a document
    // that resembles it.
    const served = await page.request.get(`/briefs/${encodeURIComponent(stored.id)}`);
    expect(served.status()).toBe(200);
    expect(await served.text()).toBe(stored.html);

    // The stored snapshot is the newest one, so the brief the topic page links to is
    // this one rather than an earlier send.
    await page.goto(`/topics/${E2E_TOPIC_SLUG}`);
    const newest = await page.locator('a[href^="/briefs/"]').first().getAttribute('href');
    expect(newest).toBe(`/briefs/${encodeURIComponent(stored.id)}`);
  });

  test('the mail that went out is the brief that was stored', async ({
    signedInPage: page,
  }) => {
    // The snapshot is one of the two renderings a brief exists as, and it is not the
    // one a reader receives: what the transport carried is the plain text the
    // snapshot holds, sent to the address the session was for. Nothing above looks
    // at the transport at all, so a send path that quietly dropped the body, or sent
    // one brief while storing another, would leave every one of them green.
    const stored = await latestBrief(page);

    const inbox = await page.request.get(
      `/e2e/mailbox?email=${encodeURIComponent(E2E_EMAIL)}`,
    );
    expect(inbox.status(), 'no mail was sent for the signed-in address').toBe(200);
    const delivered = (await inbox.json()) as { subject: string; text: string };

    expect(delivered.subject).not.toBe('');
    // The same brief, in the half a plain-text reader gets. The written heading is
    // the whole point of the feature, so it is the sentence worth matching on.
    expect(delivered.text).toContain('Written summary of Acme Corp unveils Foo');
    // And the sentence the stored plain text carries for that heading, which ties
    // the mail to this row rather than to any brief the User has been sent.
    expect(stored.text).toContain('Written summary of Acme Corp unveils Foo');
  });
});

/**
 * The newest brief stored for a Topic, read through the fixture server's read-back
 * route.
 *
 * The spec process cannot reach into the server's memory the way the vitest suite
 * does, so the row is asked for over HTTP. Which row it is does not matter: the point
 * of the assertion is that a served brief is a stored one, and every brief of this
 * Topic was stored the same way.
 */
async function latestBrief(page: Page): Promise<StoredBrief> {
  const response = await page.request.get(
    `/e2e/latest-brief?topic=${encodeURIComponent(E2E_TOPIC_SLUG)}`,
  );
  expect(response.status(), 'no brief was stored for the topic').toBe(200);
  return (await response.json()) as StoredBrief;
}

interface StoredBrief {
  readonly id: string;
  readonly topicSlug: string;
  readonly html: string;
  readonly text: string;
}
