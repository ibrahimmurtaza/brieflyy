import { test, expect } from './fixtures.js';
import {
  E2E_ALL_UNSUBSCRIBE_TOKEN,
  E2E_TOPIC_UNSUBSCRIBE_TOKEN,
  E2E_UNSUBSCRIBE_TOPIC_ID,
} from './fixture-data.js';

/**
 * Stopping the mail, in a browser.
 *
 * Every one of these behaviours was already covered by the vitest suite, which
 * injects requests and can therefore assert what a route returns and nothing
 * about what a person sees. That is exactly the gap that let a confirmation page
 * saying "You have stopped undefined briefs" reach main: the route returned 200
 * and the test passed, because nothing had ever rendered the page. The specs
 * below are the copy that fails in a browser, on the links a reader would follow.
 *
 * Serial, and restoring the state it changes, for two reasons. The specs share
 * one server process, and a token is single-use by design — so a spec that spends
 * one has to put the state back for whatever runs next, or the order of the suite
 * becomes part of what it is testing. And `fullyParallel` would otherwise have
 * three viewports spending the same token at the same moment, which tests the
 * race rather than the reader.
 */
const TOPIC_LINK = `/unsubscribe/topic?token=${E2E_TOPIC_UNSUBSCRIBE_TOKEN}`;
const ALL_LINK = `/unsubscribe/all?token=${E2E_ALL_UNSUBSCRIBE_TOKEN}`;

/**
 * Put the fixture back to a reader who still wants their mail.
 *
 * A token is single-use by design, and the specs share one server process, so a
 * spent token is a fact about the whole run rather than about one spec. Reset
 * before each test rather than after, so a test that fails halfway through still
 * leaves the next one looking at a clean state instead of inheriting its mess.
 */
async function resetUnsubscribe(page: import('@playwright/test').Page): Promise<void> {
  await page.request.post('/e2e/reset-unsubscribe');
}

test.describe.configure({ mode: 'serial' });

test.describe('following an unsubscribe link in a browser', () => {
  test.beforeEach(async ({ signedInPage: page }) => {
    await resetUnsubscribe(page);
  });

  test('the per-Topic link stops that topic and says which one', async ({ signedInPage: page }) => {
    const response = await page.goto(TOPIC_LINK);

    // The reader asked to stop one subject, so the page has to name it. A
    // confirmation that does not say which topic stopped is a page asking the
    // reader to take the word for something they only half asked for.
    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toContainText(
      'You have stopped Fusion energy briefs',
    );
    await expect(page.getByRole('status')).toContainText('No more briefs on Fusion energy');
  });

  test('the page names a real topic, never a missing one', async ({ signedInPage: page }) => {
    // The regression this file exists for. A removed Topic still resolves the
    // token — the row survives a soft delete, so the delivery is still there and
    // the unsubscribe is still real — but it no longer resolves as a Topic, so
    // the title came back `undefined` where every guard on it compared against
    // null, and the page read "You have stopped undefined briefs". Asserted on
    // the visible text, because the status code was 200 throughout.
    await page.request.post('/e2e/remove-topic', { data: { id: E2E_UNSUBSCRIBE_TOPIC_ID } });
    try {
      const response = await page.goto(TOPIC_LINK);

      expect(response?.status()).toBe(200);
      await expect(page.locator('body')).not.toContainText('undefined');
      // Falls back to the wording that is true: the mail has stopped, and there
      // is no Topic left to name.
      await expect(page.getByRole('heading', { level: 1 })).toHaveText(
        'You have stopped all Brieflyy emails',
      );
    } finally {
      await page.request.post('/e2e/restore-topic', { data: { id: E2E_UNSUBSCRIBE_TOPIC_ID } });
    }
  });

  test('the confirmation page offers a way back, and it works', async ({ signedInPage: page }) => {
    await page.goto(TOPIC_LINK);

    // A control that can only turn something off is not a control.
    await page.getByRole('link', { name: 'Manage your emails' }).click();
    await expect(page.getByRole('heading', { level: 1 })).toHaveText('Email briefs');
    await expect(page.getByText('Briefs for this topic are off')).toBeVisible();
  });

  test('the global link stops everything, and says so', async ({ signedInPage: page }) => {
    const response = await page.goto(ALL_LINK);

    expect(response?.status()).toBe(200);
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      'You have stopped all Brieflyy emails',
    );
  });

  test('a spent link says what happened rather than showing an error', async ({ signedInPage: page }) => {
    await page.goto(TOPIC_LINK);
    // A mail client that retries, or a reader who opened the link twice, has not
    // done anything wrong and should not be told they have.
    const again = await page.goto(TOPIC_LINK);

    expect(again?.status()).toBe(400);
    await expect(page.getByRole('alert')).toContainText('already been used');
  });
});

test.describe('the settings screen, after an unsubscribe', () => {
  test.beforeEach(async ({ signedInPage: page }) => {
    await resetUnsubscribe(page);
  });

  test('shows the opt-out and turns one topic back on', async ({ signedInPage: page }) => {
    await page.goto(TOPIC_LINK);
    await page.goto('/settings/briefs');

    await expect(page.getByText('Briefs for this topic are off')).toBeVisible();
    await page
      .getByRole('button', { name: 'Turn this topic back on' })
      .first()
      .click();

    await expect(page.getByRole('status')).toContainText('That topic is being emailed again');
    // Scoped to the row: once it is back on, both topics read "on", and an
    // unscoped matcher is a strict-mode violation rather than an assertion.
    await expect(topicRow(page, 'Fusion energy')).toContainText(
      'Briefs for this topic are on.',
    );
  });

  test('turning one topic back on does not touch the others', async ({ signedInPage: page }) => {
    await page.goto(TOPIC_LINK);
    await page.goto('/settings/briefs');

    // Two decisions, two rows. Restoring one has to leave the rest alone, or the
    // page is lying about what the reader asked for.
    await expect(page.getByText('Briefs for this topic are off')).toHaveCount(1);
    await expect(topicRow(page, 'Fusion energy')).toContainText(
      'Briefs for this topic are off',
    );
    await expect(topicRow(page, 'World news')).toContainText(
      'Briefs for this topic are on.',
    );
  });

  test('turning all emails back on leaves a topic that was off on its own', async ({
    signedInPage: page,
  }) => {
    await page.goto(TOPIC_LINK);
    await page.goto(ALL_LINK);
    await page.goto('/settings/briefs');

    await page.getByRole('button', { name: 'Turn all emails back on' }).click();

    // The two scopes are separate decisions. "Yes to all of them again" is not an
    // answer to "yes to that one again", and the page has to show it as still off.
    await expect(page.getByText('Briefs for this topic are off')).toBeVisible();
  });
});

/** One Topic's row on the settings screen, so a matcher is about that Topic. */
function topicRow(page: import('@playwright/test').Page, title: string) {
  return page.locator('li', { has: page.getByRole('link', { name: title, exact: true }) });
}
