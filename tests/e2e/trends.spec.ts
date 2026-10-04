import { test, expect } from './fixtures.js';
import { E2E_TOPIC_SLUG } from './fixture-data.js';

/**
 * The trends view in a browser, which is the only place a chart can be checked.
 *
 * A request-injection suite can assert that the markup contains an `<svg>`; it
 * cannot tell whether the line is drawn, whether the annotation scrolls to the
 * Cluster it names, or whether the table under the chart is readable. These specs
 * do the parts that need a renderer, and leave the numbers to the HTTP suite.
 */
test.describe('the trends view', () => {
  test('a topic\'s page draws the mentions chart and the emerging list', async ({ signedInPage: page }) => {
    await page.goto(`/topics/${E2E_TOPIC_SLUG}/trends`);

    await expect(page.getByRole('heading', { level: 1, name: 'World news trends' })).toBeVisible();

    // Both lines are present and named, so a reader who cannot see the SVG still
    // knows what each of the two lines is.
    const chart = page.locator('svg.trend-chart');
    await expect(chart).toBeVisible();
    await expect(chart.locator('.trend-chart__articles')).toHaveCount(1);
    await expect(chart.locator('.trend-chart__stories')).toHaveCount(1);
    await expect(page.locator('.legend')).toContainText('Articles');
    await expect(page.locator('.legend')).toContainText('Stories');
  });

  test('the chart says what it shows, for a reader who cannot see it', async ({ signedInPage: page }) => {
    await page.goto(`/topics/${E2E_TOPIC_SLUG}/trends`);
    await expect(page.locator('svg.trend-chart')).toHaveAttribute('role', 'img');
    await expect(page.locator('svg.trend-chart')).toHaveAttribute(
      'aria-label',
      /\d+ days from .* Busiest day .* with \d+ articles and \d+ stories\./,
    );
    // And the numbers themselves, in a table.
    await expect(page.locator('table.trend-table')).toBeVisible();
  });

  test('a spike is annotated with the cluster that caused it, and the link lands there', async ({ signedInPage: page }) => {
    await page.goto(`/topics/${E2E_TOPIC_SLUG}/trends`);

    // The marker is on the drawing.
    await expect(page.locator('.spike-marker')).not.toHaveCount(0);

    const annotation = page.locator('.spikes li a').first();
    await expect(annotation).toBeVisible();
    const href = await annotation.getAttribute('href');
    expect(href).toMatch(/^\/topics\/[^/]+#cluster-/);

    // And following it lands on that Cluster, rather than at the top of the brief.
    await annotation.click();
    await expect(page).toHaveURL(/#cluster-/);
    const id = (href ?? '').split('#')[1] ?? '';
    // By attribute rather than by `#id`: a Cluster id contains characters an id
    // selector would need escaping for, and this runs in Node where there is no
    // `CSS` to escape them with.
    await expect(page.locator(`[id="${id}"]`)).toBeVisible();
  });

  test('every entity has a sparkline beside the counts it is evidence for', async ({ signedInPage: page }) => {
    await page.goto(`/topics/${E2E_TOPIC_SLUG}/trends`);
    const rows = page.locator('.entities li.entity');
    await expect(rows).not.toHaveCount(0);
    await expect(rows.first().locator('.sparkline')).toBeVisible();
    await expect(rows.first()).toContainText('Acme Corp');
  });

  test('a free User is shown three days and told why, with the way to change it', async ({ signedInPage: page }) => {
    await page.goto(`/topics/${E2E_TOPIC_SLUG}/trends`);
    await expect(page.locator('main')).toContainText('The last 3 days');
    await expect(page.getByRole('link', { name: 'Upgrade' })).toHaveAttribute(
      'href',
      '/upgrade',
    );
    // No multiple: the lift compares a seven-day window to a thirty-day baseline,
    // and neither is something this User has been shown.
    await expect(page.locator('main')).not.toContainText('more often than the baseline');
  });

  test('the dashboard rolls every topic up into one figure', async ({ signedInPage: page }) => {
    await page.goto('/topics');
    const rollup = page.locator('main section').filter({ hasText: 'Across your topics' });
    await expect(rollup).toBeVisible();
    await expect(rollup.locator('svg.trend-chart')).toBeVisible();
    await expect(rollup.locator('a[href$="/trends"]')).not.toHaveCount(0);
  });

  test('a rollup entity carries its own series, not just the multiple', async ({ signedInPage: page }) => {
    // The per-Topic list draws a series beside every ratio; the rollup is the same
    // claim at a wider scale, and a multiple with nothing under it is a claim the
    // User cannot check. This is the assertion the gap was missing.
    await page.goto('/topics');
    const rollup = page.locator('main section').filter({ hasText: 'Across your topics' });
    const rows = rollup.locator('.entities li.entity');
    await expect(rows).not.toHaveCount(0);
    await expect(rows.first().locator('.sparkline')).toBeVisible();
    await expect(rows.first()).toContainText('mentions in the last');
  });
});

test.describe('the trends view is reachable', () => {
  test('from the shell, and it can be left again', async ({ signedInPage: page }) => {
    await page.goto('/trends');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Trends', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Manage topics', exact: true })).toBeVisible();
  });

  test('from the living brief, and from the dashboard', async ({ signedInPage: page }) => {
    for (const url of [`/topics/${E2E_TOPIC_SLUG}`, '/topics', '/discover']) {
      await page.goto(url);
      const link = page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'Trends', exact: true });
      await expect(link, `${url} cannot reach /trends`).toBeVisible();
    }
  });

  test('the across-your-topics page lists every topic\'s own trends', async ({ signedInPage: page }) => {
    await page.goto('/trends');
    await expect(page.getByRole('link', { name: 'World news' })).toHaveAttribute(
      'href',
      `/topics/${E2E_TOPIC_SLUG}/trends`,
    );
  });
});