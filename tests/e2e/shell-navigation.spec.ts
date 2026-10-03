import { test, expect } from './fixtures.js';
import { E2E_TOPIC_SLUG } from './fixture-data.js';

/**
 * The shell, walked the way somebody walks it.
 *
 * `pages.spec.ts` checks that every signed-in page *has* the navigation, that the
 * link to topic management is on it, and that the current page is marked. All three
 * are checks on one page at a time, made by typing its address. What they cannot
 * say is whether a User can get from one surface to another by clicking, because
 * nothing has ever clicked: a link that is present and points at a route that
 * answers is not the same claim as a link that takes you there.
 *
 * So this clicks. One spec, in one pass, rather than one per pair of surfaces,
 * because the claim is that the shell holds together as a whole: a User who has
 * read `aria-current` correctly on seven pages in isolation could still find that
 * the seventh cannot be reached from the sixth.
 */
const SURFACES: readonly (readonly [string, string, string])[] = [
  // The label as the navigation spells it, the address it goes to, the page's own
  // heading once it arrives.
  ['Manage topics', '/pick-topics', 'Your topics'],
  ['Discover', '/discover', 'Discover'],
  ['Trends', '/trends', 'Trends'],
  ['Archive', '/archive/search', 'Archive search'],
  ['Email briefs', '/settings/briefs', 'Email briefs'],
  ['Delivery time', '/settings/delivery', 'Delivery time'],
  ['Topics', '/topics', 'Your topics'],
];

test('the shell takes a User from one surface to the next', async ({
  signedInPage: page,
}) => {
  await page.goto('/topics');
  const nav = page.getByRole('navigation', { name: 'Primary' });

  for (const [label, href, heading] of SURFACES) {
    await nav.getByRole('link', { name: label, exact: true }).click();

    // The address is the one the link claims, which is more than "some page came
    // up": a link that landed on the right page by the wrong route would pass a
    // heading assertion and leave the address bar lying.
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();

    // The shell says where it thinks it is, and only there. Two marked links would
    // be a page that cannot answer the question.
    await expect(nav.getByRole('link', { name: label, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    const marked = nav.locator('a[aria-current="page"]');
    await expect(marked, `${href} marks ${await marked.count()} links as current`).toHaveCount(1);
  }
});

test('a LivingBrief is reachable from the topic list and leads back out', async ({
  signedInPage: page,
}) => {
  await page.goto('/topics');
  const nav = page.getByRole('navigation', { name: 'Primary' });

  // Out through the page's own content rather than the navigation: the brief is
  // the thing on this page, and a User opens their first brief from the list.
  await page.locator('main').getByRole('link', { name: 'World news', exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/topics/${E2E_TOPIC_SLUG}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'World news' })).toBeVisible();

  // The brief is not a place of its own in the navigation, and pretending
  // otherwise would put two marks on the screen at once: it belongs to Topics.
  await expect(nav.locator('a[aria-current="page"]')).toHaveCount(1);
  await expect(nav.getByRole('link', { name: 'Topics', exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );

  // And from in there the rest of the shell still works, which is the part that was
  // not being tested: the brief is the page with the most controls on it, so it is
  // the one whose navigation most needs to be the same as everybody else's.
  for (const [label, href, heading] of SURFACES.slice(1, 4)) {
    await nav.getByRole('link', { name: label, exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`${href}$`));
    await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
  }

  // Including the way back to the brief itself, so the loop is closed rather than
  // merely opened.
  await nav.getByRole('link', { name: 'Topics', exact: true }).click();
  await page
    .locator('main')
    .getByRole('link', { name: 'World news', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/topics/${E2E_TOPIC_SLUG}$`));
  await expect(page.getByRole('heading', { level: 1, name: 'World news' })).toBeVisible();
});
