import { test, expect } from '@playwright/test';

test('Playwright smoke', async ({ page }) => {
  await page.goto('about:blank');
  expect(await page.title()).toBe('');
});
