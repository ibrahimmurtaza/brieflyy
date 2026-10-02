import { test, expect } from './fixtures.js';
import { E2E_TOPIC_SLUG } from './fixture-data.js';

/**
 * The Archive search, driven the way a reader drives it.
 *
 * The HTTP suite proves the route reads the database and applies the tier. This
 * proves the two halves join up in a browser: a box in the shell on a page the User
 * was already on, a results page at the end of it, and a result that opens
 * something. A search that needs a hand-built URL is a search nobody runs.
 *
 * The specs share one fixture server and several of them write briefs, so nothing
 * here asserts what the *first* result is unless the search is for a word only one
 * row holds, and nothing here needs a fixture row that only another spec's side
 * effects would produce. Paging is covered in `src/pages/archive-search.test.ts`,
 * which has thirty rows of its own rather than borrowing another spec's.
 */
test.describe('searching the Archive', () => {
  test('the box in the shell finds this User’s own Archive from any page', async ({
    signedInPage: page,
  }) => {
    await page.goto('/topics');

    const box = page.getByRole('search').getByLabel('Search your archive');
    await expect(box).toBeVisible();
    await box.fill('Acme');
    await box.press('Enter');

    await expect(page).toHaveURL(/\/archive\/search\?q=Acme/);
    await expect(page.getByRole('heading', { level: 1, name: 'Archive search' })).toBeVisible();
    await expect(page.locator('main .results li').first()).toBeVisible();
  });

  test('the same box is on a page the User was not looking at', async ({
    signedInPage: page,
  }) => {
    // "From anywhere" is the whole claim. Checking it on one page would pass whether
    // the box were in the shell or pasted onto the results page, which is the
    // version that leaves a User with nowhere to search from.
    for (const url of ['/trends', '/discover', '/upgrade']) {
      await page.goto(url);
      await expect(
        page.getByRole('search').getByLabel('Search your archive'),
        `${url} has no search box in its shell`,
      ).toBeVisible();
    }
  });

  test('a result opens the thing it found', async ({ signedInPage: page }) => {
    // Narrowed to the one Topic whose Cluster carries this word, because the specs
    // share one server and several of them write briefs: a search for a word the
    // LivingBrief also quotes comes back with a different first result depending on
    // which spec ran first. `competitors` is in this Cluster's own summary, which a
    // written brief replaces rather than repeating.
    await page.goto(`/archive/search?topic=${E2E_TOPIC_SLUG}&q=competitors`);

    const result = page.getByRole('link', { name: 'Acme Corp unveils Foo' });
    await result.click();

    // A Cluster is read where it is listed, and the link lands on that anchor rather
    // than at the top of the page — which is what `clusterAnchor` is shared for.
    await expect(page).toHaveURL(/#cluster-e2e-cluster-1$/);
    await expect(page.locator('#cluster-e2e-cluster-1')).toBeVisible();
  });

  test('every result is a link that goes somewhere', async ({ signedInPage: page }) => {
    await page.goto('/archive/search?q=Acme');

    const links = page.locator('main .results__title a');
    expect(await links.count()).toBeGreaterThan(0);

    // Internal addresses and the outlets' own, and nothing empty: a result that is
    // not a link is a list of strings, and one that links to `undefined` is worse.
    for (const href of await links.evaluateAll((nodes) =>
      nodes.map((n) => (n as HTMLAnchorElement).getAttribute('href') ?? ''),
    )) {
      expect(href.length, 'a result with no address').toBeGreaterThan(0);
      expect(href, `a result pointing at ${href}`).not.toContain('undefined');
      expect(
        href.startsWith('/') || /^https?:\/\//.test(href),
        `a result pointing at ${href}`,
      ).toBe(true);
    }
  });

  test('a search that finds nothing says so, and does not say the Archive is empty', async ({
    signedInPage: page,
  }) => {
    await page.goto('/archive/search?q=zzzznotathing');

    await expect(page.getByText('Nothing matched')).toBeVisible();
    // "Nothing matched" and "you have nothing" are different answers, and the second
    // one would be a lie about a User with a year of briefs behind them.
    await expect(page.getByText('Nothing in your archive yet')).toHaveCount(0);
  });

  test('narrowing by a Source keeps the search in the URL', async ({ signedInPage: page }) => {
    await page.goto('/archive/search');

    await page.getByLabel('Source').selectOption('the-guardian');
    await page.getByLabel('Search words').fill('Acme');
    // Scoped to the page's own form: the shell carries a search box of its own, and
    // submitting that one would throw the filters away.
    await page.locator('main').getByRole('button', { name: 'Search' }).click();

    // A GET, so the narrowed search is an address rather than a state that is gone
    // on reload — and a User can come back to it or send it to themselves.
    await expect(page).toHaveURL(/source=the-guardian/);
    await expect(page).toHaveURL(/q=Acme/);
    await expect(page.locator('main .results li').first()).toBeVisible();
  });

  test('tells a free User that their Archive is bounded', async ({ signedInPage: page }) => {
    await page.goto('/archive/search');

    // Thirty days is a rule somebody wrote; a User who searches and finds nothing
    // is owed the reason rather than left to infer it from a silence.
    await expect(page.getByText(/last 30 days/)).toBeVisible();
    // And what is not bounded, so the sentence is not read as "nothing is kept".
    await expect(page.getByText(/every brief you have been sent is here/i)).toBeVisible();
  });
});

