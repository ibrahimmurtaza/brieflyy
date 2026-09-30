import { test, expect } from './fixtures.js';

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
    await page.goto('/topics/world-news');

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
    await page.goto('/topics/world-news');
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
    await page.goto('/topics/world-news');
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
    await page.goto('/topics/world-news');

    await expect(
      page.getByRole('heading', { name: /Acme Corp unveiled Foo today, and analysts are split/ }),
    ).toBeVisible();
    await expect(page.getByText('Written summary of')).toHaveCount(0);
  });

  test('a brief is a document a browser renders, not a wall of markup', async ({
    signedInPage: page,
  }) => {
    await page.goto('/topics/world-news');
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
});
