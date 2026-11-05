import type { Page } from '@playwright/test';

import { test, expect } from './fixtures.js';
import { E2E_ALL_SOURCES_SLUG, E2E_TOPIC_SLUG } from './fixture-data.js';

/**
 * The topic settings page's buttons, driven in a browser.
 *
 * The vitest suite asserts what the route returns, which cannot say whether a
 * User can enable a save button — the script that disables the three forms lives
 * inline in the page and only runs in a browser. This spec is that script. No
 * test submits a form, so the shared fixture account stays read-only.
 */
const SETTINGS = `/topics/${E2E_TOPIC_SLUG}/settings`;

const renameSave = (page: Page) =>
  page.getByRole('button', { name: 'Save name' });
const cadenceSave = (page: Page) =>
  page.getByRole('button', { name: 'Save', exact: true });
const addSource = (page: Page) =>
  page.getByRole('button', { name: 'Add source' });

test.describe('the topic settings page', () => {
  test('starts with every save disabled, because nothing has changed', async ({
    signedInPage: page,
  }) => {
    await page.goto(SETTINGS);

    await expect(renameSave(page)).toBeDisabled();
    await expect(cadenceSave(page)).toBeDisabled();
    await expect(addSource(page)).toBeDisabled();
  });

  test('the name save enables on a real edit and disables again on revert', async ({
    signedInPage: page,
  }) => {
    await page.goto(SETTINGS);
    const title = page.locator('#title');
    const save = renameSave(page);

    await title.fill('World news and weather');
    await expect(save).toBeEnabled();

    // Back to the stored name, which is not a change to save.
    await title.fill('World news');
    await expect(save).toBeDisabled();

    // A name of only spaces is not a name either.
    await title.fill('   ');
    await expect(save).toBeDisabled();

    await title.fill('Elections');
    await expect(save).toBeEnabled();
  });

  test('a weekly cadence cannot be saved with no day, and picking one enables it', async ({
    signedInPage: page,
  }) => {
    await page.goto(SETTINGS);
    const save = cadenceSave(page);
    const day = page.locator('#day');

    // The dropdown offers an explicit unanswered state rather than a borrowed day.
    await expect(day.locator('option[value=""]')).toHaveText('Please select');

    await page.locator('input[name="cadence"][value="weekly"]').check();
    await expect(save).toBeDisabled();

    await day.selectOption('thursday');
    await expect(save).toBeEnabled();

    // A different day is still a change worth saving.
    await day.selectOption('friday');
    await expect(save).toBeEnabled();

    // Back to no day: a weekly brief without one is refused by the server.
    await day.selectOption('');
    await expect(save).toBeDisabled();
  });

  test('reverting the schedule to the stored one disables the save again', async ({
    signedInPage: page,
  }) => {
    await page.goto(SETTINGS);
    const save = cadenceSave(page);
    const day = page.locator('#day');

    await page.locator('input[name="cadence"][value="weekly"]').check();
    await day.selectOption('thursday');
    await expect(save).toBeEnabled();

    // The stored cadence is daily with no day, so daily plus a day on the sheet
    // is a revert, not a change: the day only means something for weekly.
    await page.locator('input[name="cadence"][value="daily"]').check();
    await expect(save).toBeDisabled();
  });

  test('a day picked beside daily or never is not a change', async ({
    signedInPage: page,
  }) => {
    await page.goto(SETTINGS);
    const save = cadenceSave(page);
    const day = page.locator('#day');

    await day.selectOption('friday');
    await expect(save).toBeDisabled();

    // never is a different cadence from the stored daily, so the save enables…
    await page.locator('input[name="cadence"][value="never"]').check();
    await expect(save).toBeEnabled();

    // …but a day picked beside never is not itself a change…
    await day.selectOption('saturday');
    await expect(save).toBeEnabled();

    // …and neither is one picked beside daily once the cadence is reverted.
    await page.locator('input[name="cadence"][value="daily"]').check();
    await expect(save).toBeDisabled();
  });

  test('the add-source button enables only when a source is picked', async ({
    signedInPage: page,
  }) => {
    await page.goto(SETTINGS);
    const add = addSource(page);
    const select = page.locator('#sourceId');

    await expect(select.locator('option[value=""]')).toHaveText('Please select');

    // A registry Source this topic does not already follow.
    await select.selectOption('npr-news');
    await expect(add).toBeEnabled();

    // Back to the placeholder, which is not a Source.
    await select.selectOption('');
    await expect(add).toBeDisabled();
  });

  test('a button left pending is restored when the page returns from the browser cache', async ({
    signedInPage: page,
  }) => {
    // A real submission would mutate the shared fixture account, so the pending
    // state is applied by hand and pageshow is dispatched — the same event a
    // back-forward-cache restore fires, and the one the page's restore logic
    // listens for. Without it the User lands on a page whose buttons are stuck
    // on what they were doing when the request was made.
    await page.goto(SETTINGS);
    const add = addSource(page);
    const select = page.locator('#sourceId');

    await select.selectOption('npr-news');
    await expect(add).toBeEnabled();

    await page.evaluate(() => {
      const button = document.querySelector<HTMLButtonElement>('#source-add-submit')!;
      button.disabled = true;
      button.textContent = 'Adding…';
      window.dispatchEvent(new Event('pageshow'));
    });

    await expect(add).toHaveText('Add source');
    // The form's own check re-ran: the picked source means the save is live again.
    await expect(add).toBeEnabled();
  });

  test('offers no add control when the topic already follows every source', async ({
    allSourcesPage: page,
  }) => {
    await page.goto(`/topics/${E2E_ALL_SOURCES_SLUG}/settings`);

    // The followed list is still there; only the picker is gone.
    await expect(page.getByRole('heading', { name: 'Sources', exact: true })).toBeVisible();
    await expect(page.locator('ul.topics li').first()).toBeVisible();
    await expect(page.locator('#sourceId')).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Add source' })).toHaveCount(0);
  });
});
