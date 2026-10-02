import { test, expect, SIGNED_IN_COOKIE } from './fixtures.js';
import { E2E_TOPIC_SLUG } from './fixture-data.js';

/**
 * The two markup contracts that a stylesheet or layout change can break without
 * any route changing, given their own named spec so they cannot be lost in a
 * refactor. Both are also asserted by the vitest suite; this is the copy that
 * fails in a browser, on the page a person would actually see.
 */
test.describe('the markup invariants a layout change can break', () => {
  test('/upgrade has nothing to submit, and says so', async ({ signedInPage: page }) => {
    await page.goto('/upgrade');

    // Billing is not connected, so the page must not offer a control that looks
    // like a checkout. The sign-out form in the shared header is not one.
    const main = page.locator('main');
    await expect(main.locator('form')).toHaveCount(0);
    await expect(page.getByText("Billing isn't connected yet")).toBeVisible();
  });

  test('the delivery-time screens work with no JavaScript at all', async ({ browser }) => {
    const context = await browser.newContext({ javaScriptEnabled: false });
    const page = await context.newPage();

    // The same session, presented without a script to read it.
    await context.addCookies([SIGNED_IN_COOKIE]);

    for (const url of ['/onboarding/delivery-time', '/settings/delivery']) {
      const response = await page.goto(url);
      // A page that carries a script tag cannot work this way, and these two are
      // asserted to carry none.
      expect(await page.locator('script').count(), `${url} carries a script`).toBe(0);
      expect(response?.status()).toBe(200);
    }

    // The change control is a native disclosure, so it opens without a script.
    await page.goto('/settings/delivery');
    await expect(page.locator('details#change-delivery')).toBeVisible();
    await page.locator('details#change-delivery > summary').click();
    await expect(page.locator('details#change-delivery form')).toBeVisible();

    await context.close();
  });
});

test.describe('every page a signed-in User can reach', () => {
  const PAGES: readonly (readonly [string, string])[] = [
    ['/topics', 'Your topics'],
    [`/topics/${E2E_TOPIC_SLUG}`, 'World news'],
    ['/pick-topics', 'Your topics'],
    ['/settings/briefs', 'Email briefs'],
    ['/settings/delivery', 'Delivery time'],
    ['/archive/search', 'Archive search'],
    ['/upgrade', 'Upgrade to paid'],
    ['/discover', 'Discover'],
    ['/trends', 'Trends'],
    [`/topics/${E2E_TOPIC_SLUG}/trends`, 'World news trends'],
  ];

  for (const [url, heading] of PAGES) {
    test(`${url} renders its heading`, async ({ signedInPage: page }) => {
      const response = await page.goto(url);
      expect(response?.status()).toBe(200);
      await expect(page.getByRole('heading', { level: 1, name: heading })).toBeVisible();
    });
  }

  test('an unknown topic is a 404 that still offers a way out', async ({ signedInPage: page }) => {
    const response = await page.goto('/topics/does-not-exist');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('link', { name: 'Back to your topics' })).toBeVisible();
  });
});

test.describe('the shell', () => {
  test('every signed-in page has the same navigation, and it can be left', async ({ signedInPage: page }) => {
    for (const url of ['/topics', '/pick-topics', '/discover', '/trends', '/archive/search', '/upgrade', '/settings/briefs', '/settings/delivery']) {
      await page.goto(url);
      const nav = page.getByRole('navigation', { name: 'Primary' });
      await expect(nav, `${url} has no primary navigation`).toBeVisible();
      // Exact, because "Topics" is a prefix of "Manage topics" and a substring
      // match would resolve to both.
      await expect(nav.getByRole('link', { name: 'Topics', exact: true })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    }
  });

  test('every signed-in page can reach topic management', async ({ signedInPage: page }) => {
    // "Manage topics" lived on /topics and on the LivingBrief before the shell
    // existed, and went missing with the per-page navigation they carried. This is
    // the check that says it is not allowed to go missing again.
    for (const url of ['/topics', '/topics/world-news', '/settings/briefs', '/settings/delivery', '/upgrade', '/archive/search', '/discover', '/trends', '/topics/world-news/trends']) {
      await page.goto(url);
      const link = page
        .getByRole('navigation', { name: 'Primary' })
        .getByRole('link', { name: 'Manage topics', exact: true });
      await expect(link, `${url} cannot reach /pick-topics`).toBeVisible();
      await expect(link).toHaveAttribute('href', '/pick-topics');
    }
  });

  test('the current page is marked in the navigation', async ({ signedInPage: page }) => {
    await page.goto('/pick-topics');
    const nav = page.getByRole('navigation', { name: 'Primary' });
    await expect(nav.getByRole('link', { name: 'Manage topics', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
    );
    await expect(nav.getByRole('link', { name: 'Topics', exact: true })).not.toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  test('the skip link is the first thing a keyboard reaches, and it works', async ({ signedInPage: page }) => {
    await page.goto('/topics');
    await page.keyboard.press('Tab');
    const skip = page.getByRole('link', { name: 'Skip to content' });
    await expect(skip).toBeFocused();
    await skip.press('Enter');
    await expect(page).toHaveURL(/#main$/);
  });

  test('the account email is in the header, not opening the page', async ({ signedInPage: page }) => {
    await page.goto('/topics');
    await expect(page.locator('.account__email')).toHaveText('iris@example.com');
  });

  test('the header says which tier the User is on, and when the next brief lands', async ({ signedInPage: page }) => {
    // The three facts a User cannot work out for themselves without leaving the
    // page: who is signed in, what they pay for, and when mail next arrives.
    await page.goto('/topics');
    const account = page.locator('.account');
    await expect(account.locator('.account__tier')).toHaveText('Free plan');
    // In the User's own zone, because the fixture server stores
    // `America/New_York` and a clock time with no frame is a claim without one.
    await expect(account.locator('.account__brief')).toContainText('Next brief');
    await expect(account.locator('.account__brief')).toContainText('America/New_York');
    await expect(account.locator('.account__brief')).toContainText('08:00');
  });

  test('an address that does not exist is a page inside the shell', async ({ signedInPage: page }) => {
    const response = await page.goto('/there-is-no-such-page');
    expect(response?.status()).toBe(404);
    // A dead link used to answer with Fastify's JSON, which is neither a page nor
    // a way out of wherever the User was when they clicked it.
    await expect(page.getByRole('heading', { level: 1, name: 'Page not found' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Back to your topics' })).toBeVisible();
  });

  test('an anonymous visitor who lands on a dead address is offered the way in', async ({ page }) => {
    const response = await page.goto('/there-is-no-such-page');
    expect(response?.status()).toBe(404);
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    // And no navigation to pages they cannot reach.
    await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  });
});

test.describe('the pages that used to be broken on a phone', () => {
  // A missing viewport meta tag made the browser lay out at a nominal 980px and
  // scale the result down, which is invisible to a request-injection test and
  // obvious here.
  const PAGES = ['/signup', '/topics', '/pick-topics', '/settings/briefs', '/settings/delivery', '/upgrade', '/trends', `/topics/${E2E_TOPIC_SLUG}/trends`];

  for (const url of PAGES) {
    test(`${url} has no horizontal scroll`, async ({ signedInPage: page }) => {
      await page.goto(url);
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow, `${url} overflows by ${overflow}px`).toBeLessThanOrEqual(1);
    });
  }

  test('the delivery-time fields share a row only when there is room for them', async ({ signedInPage: page }) => {
    await page.goto('/settings/delivery');
    await page.locator('details#change-delivery > summary').click();
    const hour = await page.locator('#hour').boundingBox();
    const timezone = await page.locator('#timezone').boundingBox();
    expect(hour, 'the hour field has no box').not.toBeNull();
    expect(timezone, 'the timezone select has no box').not.toBeNull();

    // The row is `1fr 1fr 2fr` above 40rem and stacked below it. A 130px-wide
    // select showing `America/New…` is the failure this breakpoint exists to
    // prevent, so the narrow case is the one that has to hold.
    const width = page.viewportSize()?.width ?? 0;
    if (width >= 640) {
      expect(timezone!.y, 'the row should be side by side on a wide viewport').toBeCloseTo(hour!.y, 0);
    } else {
      expect(timezone!.y, 'the timezone should stack under the hour on a narrow viewport').toBeGreaterThan(hour!.y);
      // And it should be wide enough to show the name, not three letters of it.
      expect(timezone!.width).toBeGreaterThan(200);
    }
  });

  test('no control is smaller than the minimum target size', async ({ signedInPage: page }) => {
    await page.goto('/topics/world-news');
    const tooSmall = await page.evaluate(() => {
      const offenders: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>('a[href], button, input, select, summary')) {
        const box = el.getBoundingClientRect();
        if (box.width === 0 && box.height === 0) continue;
        if (box.height < 24 || box.width < 24) {
          const label = (el.textContent ?? '').trim().slice(0, 24) || el.getAttribute('aria-label') || '(no text)';
          offenders.push(`${el.tagName.toLowerCase()} "${label}" ${Math.round(box.width)}x${Math.round(box.height)}`);
        }
      }
      return offenders;
    });
    expect(tooSmall, `controls under 24x24: ${tooSmall.join(', ')}`).toEqual([]);
  });
});

test.describe('the LivingBrief', () => {
  test('shows the brief, its sources, and its articles with attribution', async ({ signedInPage: page }) => {
    await page.goto('/topics/world-news');

    await expect(page.getByRole('heading', { name: /Acme Corp unveiled Foo today/ })).toBeVisible();
    await expect(page.getByText('The launch changes the landscape for enterprise customers.')).toBeVisible();

    // The Source filter, with the live one marked.
    const filter = page.locator('p.filter-bar');
    await expect(filter).toBeVisible();
    await expect(filter.getByRole('link', { name: 'The Guardian' })).toBeVisible();
    await expect(filter.locator('a.selected')).toHaveCount(0);

    // An article carries the outlet it came from, not just a bare title.
    const article = page.getByRole('link', { name: 'Acme Corp unveils Foo' });
    await expect(article).toHaveAttribute('href', 'https://www.theguardian.com/acme-foo');
    await expect(page.locator('.articles .outlet')).toHaveText('The Guardian:');
  });

  test('a free-form topic does not show the internal category', async ({ signedInPage: page }) => {
    await page.goto('/topics/fusion-energy');
    await expect(page.getByRole('heading', { name: 'Fusion energy' })).toBeVisible();
    await expect(page.locator('main')).not.toContainText('unspecified');
  });

  test('every cluster control has an accessible name and a reachable target', async ({ signedInPage: page }) => {
    await page.goto('/topics/world-news');
    for (const name of ['Thumbs up', 'Thumbs down', 'More like this', 'Less like this', 'Hide source', 'Dismiss']) {
      await expect(page.getByRole('button', { name, exact: true }).or(page.getByRole('link', { name })).first()).toBeVisible();
    }
  });

  // Read-only on purpose. Every project runs against one seeded server and one
  // database, and these specs run in parallel, so a test that recorded a signal
  // would change the brief the other two viewports are asserting about. What a
  // signal *does* is covered at the HTTP seam in `src/pages/topic-page.test.ts`,
  // where each test has its own database.
  test('says what a signal would do, before any has been given', async ({ signedInPage: page }) => {
    await page.goto('/topics/world-news');

    for (const name of ['Thumbs up', 'Thumbs down', 'More like this', 'Less like this']) {
      await expect(page.getByRole('button', { name, exact: true })).toHaveAttribute(
        'aria-pressed',
        'false',
      );
    }
  });

  test('the hide control names which source and how far the ask reaches', async ({ signedInPage: page }) => {
    await page.goto('/topics/world-news');

    const hide = page.locator('form.hide-source').first();
    await expect(hide.getByRole('combobox', { name: 'Source to hide' })).toBeVisible();
    const scope = hide.getByRole('combobox', { name: 'Where to hide it' });
    await expect(scope).toBeVisible();
    await expect(scope.locator('option')).toHaveText(['This topic', 'All your topics']);
    // The fifth signal shows its state the same way the other four do, so a User
    // who has already hidden something can see that from the button.
    await expect(hide.getByRole('button', { name: 'Hide source' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  test('filtering by a Source marks that Source as the live one', async ({ signedInPage: page }) => {
    await page.goto('/topics/world-news?source=the-guardian');
    const selected = page.locator('p.filter-bar a.selected');
    await expect(selected).toHaveCount(1);
    await expect(selected).toHaveText('The Guardian');
    await expect(selected).toHaveAttribute('aria-current', 'true');
  });
});

test.describe('forms', () => {
  test('a rejected delivery time keeps what was typed and announces why', async ({ signedInPage: page }) => {
    // Posted directly rather than through the form: the hour field carries
    // `max="23"`, so the browser's own constraint validation stops an
    // out-of-range number before it is ever sent, and the server's own check is
    // only reachable for a value the controls cannot produce. `page.request`
    // shares the context's cookies, so this is still the real route with the
    // real session.
    const response = await page.request.post('/settings/delivery', {
      form: { hour: '23', minute: '30', timezone: 'Middle/Earth' },
    });
    expect(response.status()).toBe(400);
    const body = await response.text();

    // The reason is announced rather than only coloured red, and it is the first
    // thing on the page.
    expect(body).toContain('role="alert"');
    expect(body).toContain('valid time');
    // The values the User typed survived the round trip.
    expect(body).toMatch(/name="hour"[^>]*value="23"/);
    expect(body).toMatch(/name="minute"[^>]*value="30"/);
    // And the page that came back is the settings screen with the form on it, not
    // a bare error, and not a form still folded inside a closed disclosure.
    expect(body).toContain('id="main"');
    expect(body).toContain('name="hour"');
  });

  test('a topic the user already holds is not offered again, and says so', async ({ signedInPage: page }) => {
    // The reported defect: ticking a Directory topic already held added a second
    // copy of it, suffixed so both rows could coexist.
    await page.goto('/pick-topics');
    const cards = page.locator('label.card');
    const held = page.locator('label.card--held');

    await expect(held).toHaveCount(1);
    await expect(held.locator('.card__note')).toHaveText('Already added');
    await expect(held.locator('input[type=checkbox]')).toBeDisabled();
    expect(await cards.count()).toBeGreaterThan(1);

    // And the post is refused at the server too, so a crafted submission cannot
    // get around what the page will not offer.
    const title = (await held.locator('.title').textContent())?.trim();
    const outcome = await page.request.post('/pick-topics', {
      form: { templateIds: 'world-news' },
    });
    expect(outcome.status()).toBe(400);
    expect(await outcome.text()).toContain('already have one of those topics');
    expect(title).toBeTruthy();
  });

  test('the picker refuses an empty submission with the server, not just the client', async ({ browser }) => {
    // With the script running, the submit button is disabled before the User can
    // get it wrong. This is the other path: no JavaScript, so the server is the
    // only thing checking.
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.addCookies([SIGNED_IN_COOKIE]);
    const page = await context.newPage();

    await page.goto('/pick-topics');
    await page.locator('form#pick button[type=submit]').click();
    await expect(page.getByRole('alert')).toContainText('Pick at least one topic');
    // A way back to the form rather than a dead end.
    await expect(page.getByRole('link', { name: 'Try again' })).toBeVisible();

    await context.close();
  });
});
