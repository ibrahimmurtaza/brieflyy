import { describe, expect, it } from 'vitest';

import { PRIMARY_NAV, layout, type ShellAccount } from './layout.js';

/** A signed-in account with the next brief scheduled, which is the usual shape. */
function signedIn(overrides: Partial<ShellAccount> = {}): ShellAccount {
  return {
    email: 'iris@example.com',
    tier: 'free',
    brief: {
      kind: 'scheduled',
      slot: new Date('2026-01-02T08:00:00Z'),
      timezone: 'UTC',
    },
    ...overrides,
  };
}

const page = (account: ShellAccount | null): string =>
  layout({ title: 'Your topics', body: '    <h1>Your topics</h1>', account });

describe('the document shell', () => {
  it('is one document, whatever the page is about', () => {
    const html = layout({
      title: 'Sign in',
      width: 'narrow',
      account: null,
      body: '    <h1>Sign in</h1>',
    });
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<html lang="en">');
    // The viewport tag and the skip link are what a page cannot forget because it
    // does not write its own `<head>`.
    expect(html).toContain('<meta name="viewport"');
    expect(html).toContain('class="skip-link" href="#main"');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('<title>Sign in &middot; Brieflyy</title>');
    // One stylesheet, inlined once.
    expect([...html.matchAll(/<style>/g)]).toHaveLength(1);
  });

  it('tells a signed-in User who they are, what they pay for, and when to expect mail', () => {
    const html = page(signedIn());
    expect(html).toContain('iris@example.com');
    expect(html).toContain('Free plan');
    // The next brief, in the User's own zone, because a clock time with no frame
    // is a claim without one.
    expect(html).toContain('Next brief');
    expect(html).toContain('08:00');
    expect(html).toContain('UTC');
  });

  it('names the paid tier when that is the tier in force', () => {
    expect(page(signedIn({ tier: 'paid' }))).toContain('Paid plan');
  });

  it('says briefs are off rather than promising one that will not arrive', () => {
    const html = page(signedIn({ brief: { kind: 'stopped' } }));
    expect(html).toContain('Briefs are off');
    expect(html).not.toContain('Next brief');
    // And it says where to change that, because an opt-out with no way back is a
    // setting the User has lost control of.
    expect(html).toContain('href="/settings/briefs"');
  });

  it('offers a delivery time to a User who has not chosen one', () => {
    const html = page(signedIn({ brief: { kind: 'unset' } }));
    expect(html).not.toContain('Next brief');
    expect(html).toContain('href="/settings/delivery"');
  });

  it('puts sign-out in the shell, as a button that posts', () => {
    const html = page(signedIn());
    expect(html).toMatch(
      /<form class="logout" method="POST" action="\/auth\/logout"><button class="quiet" type="submit">Sign out<\/button><\/form>/,
    );
    // A link, or a button wired to nothing, would leave the User unable to leave.
    expect(html).not.toMatch(/<a[^>]*>Sign out<\/a>/);
  });

  it('reaches the topic list and the delivery settings from the header', () => {
    const html = page(signedIn());
    for (const link of PRIMARY_NAV) {
      expect(html, `the header cannot reach ${link.href}`).toContain(`href="${link.href}"`);
    }
    expect(html).toContain('aria-label="Primary"');
  });

  it('marks the current page in the navigation, and only that one', () => {
    const html = layout({
      title: 'Your topics',
      body: '    <h1>Your topics</h1>',
      account: signedIn(),
      activeHref: '/topics',
    });
    // Counted on the links rather than on the attribute, because the stylesheet
    // carries the selector that gives a marked link its appearance.
    const marked = [...html.matchAll(/<a href="[^"]+" aria-current="page">/g)];
    expect(marked.map((m) => m[0])).toEqual(['<a href="/topics" aria-current="page">']);
  });

  it('gives an anonymous visitor the wordmark and nothing to sign out of', () => {
    const html = page(null);
    expect(html).toContain('class="wordmark"');
    expect(html).not.toContain('aria-label="Primary"');
    expect(html).not.toContain('Sign out');
    expect(html).not.toContain('class="account"');
  });

  it('is the landmarks a keyboard and a screen reader can be moved through', () => {
    const html = page(signedIn());
    expect(html).toContain('<header class="site-header">');
    expect(html).toContain('<nav class="site-nav" aria-label="Primary">');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('<footer class="site-footer">');
    // The wordmark comes before the navigation, so tabbing from the top of a page
    // reaches the header before the content rather than after it.
    expect(html.indexOf('class="wordmark"')).toBeLessThan(html.indexOf('<nav'));
    expect(html.indexOf('</header>')).toBeLessThan(html.indexOf('<main'));
    // And the focus ring is a rule in the one stylesheet, not left to the browser
    // default that a future reset would remove.
    expect(html).toContain(':focus-visible');
  });

  it('escapes everything it renders about the account', () => {
    const html = page(
      signedIn({
        email: '"><script>alert(1)</script>@example.com',
        brief: {
          kind: 'scheduled',
          slot: new Date('2026-01-02T08:00:00Z'),
          timezone: 'UTC',
        },
      }),
    );
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});