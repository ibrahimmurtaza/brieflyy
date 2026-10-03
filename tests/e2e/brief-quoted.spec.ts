import { test, expect, feedbackFixtureFor } from './fixtures.js';
import { E2E_QUOTED_ARTICLE_TITLE, E2E_QUOTED_SLUG } from './fixture-data.js';

/**
 * A brief that could not be written, followed the way a reader would.
 *
 * The written and the quoted halves of a brief are two paths, not one with a setting.
 * The written path is handed the Article each bullet came from and builds its anchors
 * from the citation; the quoted path has only a stored sentence and has to look that
 * sentence up against the Cluster's own Articles. A brief that quotes every bullet is
 * what a deployment with no credential sends, so it is the kind most likely to be the
 * only kind anybody ever sees, and a lookup that found nothing would leave a reader
 * with sentences and no way to any of them.
 *
 * This used to be checked by building a renderer by hand, writing its output to a
 * temporary file and opening that over the local filesystem. That answers "is this
 * anchor real" for a document nothing ever sent, and it cannot fail if the send path
 * stopped carrying the Articles through, if the stored text stopped being read back,
 * or if the route a reader is pointed at stopped serving what was stored. Those are
 * the failures that reach mailboxes.
 *
 * So it goes through the whole path instead: the Topic page offers to send the brief,
 * the button sends it, and the document that comes back is read in a browser. The one
 * thing not stubbed is which path the renderer takes, and that is not a setting: the
 * summary client answers nothing for this Cluster, which is exactly what it does when
 * a provider fails.
 */
const BRIEF = `/topics/${E2E_QUOTED_SLUG}`;

test('a quoted bullet is a real link to the Article that printed it', async ({
  feedbackPage: page,
}, testInfo) => {
  const { quotedArticleUrl } = feedbackFixtureFor(testInfo);

  await page.goto(BRIEF);
  // The heading, so a later failure is about a brief rather than about a page that
  // was never the right one.
  await expect(page.getByRole('heading', { level: 1, name: 'Grid repairs' })).toBeVisible();

  // The button is there because nothing has stopped this User's mail, which is the
  // other thing that can stand between a Topic page and a brief.
  await page.getByRole('button', { name: 'Email me this brief now' }).click();
  await expect(page.getByText(/sent to .*@/)).toBeVisible();

  // The stored document, which is what the call to action in the email points at.
  const stored = await page.request.get(
    `/e2e/latest-brief?topic=${encodeURIComponent(E2E_QUOTED_SLUG)}`,
  );
  expect(stored.status(), 'the brief was not stored').toBe(200);
  const { id } = (await stored.json()) as { id: string };

  await page.goto(`/briefs/${encodeURIComponent(id)}`);

  // The heading is the Cluster's own, because nothing was written: a brief that said
  // "Written summary of" here would mean the renderer had written one after all.
  await expect(page.getByRole('heading', { level: 2 })).toHaveText(
    E2E_QUOTED_ARTICLE_TITLE,
  );

  // The bullet, which is a stored sentence, carries the Article that printed it.
  const link = page.locator(`li a[href="${quotedArticleUrl}"]`);
  await expect(link).toHaveCount(1);
  await expect(link).toHaveText(E2E_QUOTED_ARTICLE_TITLE);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener');

  // And it points at that Article's own address rather than something the renderer
  // assembled: a lookup that guessed would satisfy every assertion above and send a
  // reader somewhere else entirely.
  expect(quotedArticleUrl).toMatch(/^https:\/\//);
});
