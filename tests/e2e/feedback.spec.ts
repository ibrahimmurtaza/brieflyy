import { test, expect, feedbackFixtureFor } from './fixtures.js';
import { E2E_FEEDBACK_SLUG } from './fixture-data.js';

/**
 * What a User says about a Cluster, and finding it still said.
 *
 * Every other spec either refuses to press anything or asserts only that the buttons
 * are un-pressed. That was a deliberate choice while the suite had one shared account:
 * a signal is stored per User and outlives the page load, so a spec that pressed a
 * button would change what every later spec saw. It was also the reason nothing here
 * was covered in a browser at all. The five controls on a Cluster are the only part of
 * the LivingBrief a reader actually operates, and "pressed" being right for one page
 * load says nothing about whether it is right on the next one, which is the only time
 * it matters to them.
 *
 * So each viewport has a User of their own for this, holding one Topic with one
 * Cluster. That is what makes the first assertion in the first test possible: a shared
 * User would have had a signal on the Cluster before this spec arrived, and "the
 * button is not pressed yet" is only true before anything has been pressed.
 *
 * The fixture's Cluster is carried by both of that User's Sources, which is what makes
 * the second test say anything: hiding one outlet has to leave the other outlet's
 * account of the same story on the page, and a Cluster with one Article could not tell
 * "hid the Source" apart from "took the story away".
 */
const BRIEF = `/topics/${E2E_FEEDBACK_SLUG}`;

test.describe('the LivingBrief remembers what a User said', () => {
  test('a Cluster a User liked still says so on the next visit', async ({
    feedbackPage: page,
  }) => {
    await page.goto(BRIEF);

    const cluster = page.locator('article.cluster').first();
    const up = cluster.getByRole('button', { name: 'Thumbs up', exact: true });
    await expect(up).toHaveAttribute('aria-pressed', 'false');

    // The route answers with a redirect rather than a page of its own, so what the
    // User sees after pressing a button is what a reload would give them.
    await up.click();
    await expect(page).toHaveURL(new RegExp(`${BRIEF}$`));
    await expect(up).toHaveAttribute('aria-pressed', 'true');

    // And again from scratch, because a control that shows a state it kept in the
    // page rather than one it read back is a different claim.
    await page.reload();
    await expect(up).toHaveAttribute('aria-pressed', 'true');
    // The other three are untouched: one signal is not a mood.
    for (const name of ['Thumbs down', 'More like this', 'Less like this']) {
      await expect(cluster.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  });

  test('a Source a User hid is still hidden on the next visit', async ({
    feedbackPage: page,
  }, testInfo) => {
    // Both read out of the fixture rather than written here, so "the outlet that is
    // not the first one" is a fact about the fixture rather than an assumption about
    // it, and the pages show a Source's name rather than its id.
    const { sources, articles } = feedbackFixtureFor(testInfo);
    const [hiddenSourceId, hiddenSourceName] = sources[1]!;
    const hiddenHeadline = articles[1]![1];
    const keptHeadline = articles[0]![1];

    await page.goto(BRIEF);

    const cluster = page.locator('article.cluster').first();
    // Both outlets' accounts of the story are here to begin with, which is the state
    // the hide is judged from.
    await expect(cluster.getByRole('link', { name: hiddenHeadline })).toBeVisible();
    await expect(cluster.getByRole('link', { name: keptHeadline })).toBeVisible();

    const hide = cluster.locator('form.hide-source');
    await hide.getByLabel('Source to hide').selectOption(hiddenSourceId);
    await hide.getByLabel('Where to hide it').selectOption('this_topic');
    await hide.getByRole('button', { name: 'Hide source' }).click();
    await expect(page).toHaveURL(new RegExp(`${BRIEF}$`));

    // The hidden outlet's Article is gone and the other outlet's is not: a hide that
    // took the story with it would satisfy "the BBC link is absent".
    await expect(page.getByRole('link', { name: hiddenHeadline })).toHaveCount(0);
    await expect(page.getByRole('link', { name: keptHeadline })).toBeVisible();
    // And the Cluster is still there, rather than being emptied along with it.
    await expect(page.locator('article.cluster')).toHaveCount(1);

    // On a fresh load: the button says it is on, names what it did, and still offers
    // the scope it was given so the choice can be changed rather than only repeated.
    await page.reload();
    const reloaded = page.locator('article.cluster').first().locator('form.hide-source');
    await expect(reloaded.getByRole('button', { name: 'Hide source' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(reloaded.locator('.hide-source__state')).toHaveText(
      `${hiddenSourceName}: hidden on this topic`,
    );
    await expect(reloaded.getByLabel('Source to hide')).toHaveValue(hiddenSourceId);
    await expect(reloaded.getByLabel('Where to hide it')).toHaveValue('this_topic');
    // The source filter offers only what can still show something.
    await expect(
      page.locator('p.filter-bar').getByRole('link', { name: hiddenSourceName }),
    ).toHaveCount(0);
  });
});
