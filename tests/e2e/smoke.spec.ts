import { test, expect } from '@playwright/test';

/**
 * The Playwright install itself, asserted against a page that has content.
 *
 * A smoke test that visits `about:blank` passes whether or not the browser
 * launches, the config is readable, or the fixture server starts, so it could
 * not tell a working setup from a broken one.
 */
test('the browser suite is actually running a browser', async ({ page }) => {
  await page.goto('/signup');
  await expect(page).toHaveTitle('Sign in · Brieflyy');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in to Brieflyy' })).toBeVisible();
  // The Google button is one of the controls that went white-on-white whenever
  // the browser was in dark mode, because the page declared `color-scheme:
  // light dark` and shipped no dark rules.
  await expect(page.getByRole('link', { name: 'Sign in with Google' })).toBeVisible();
});
