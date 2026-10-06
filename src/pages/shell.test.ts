import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { signedInCookies, submitForm } from '../testing/forms.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import type { SqliteDriver } from '../db/client.js';

const NOW = new Date('2026-01-01T00:00:00Z');

interface Harness {
  readonly app: FastifyInstance;
  readonly cookie: string;
  readonly driver: SqliteDriver;
}

/**
 * Every screen a signed-in User can land on, with the status it answers and,
 * where it takes a parameter, that parameter filled in with something that does
 * not exist.
 *
 * The two probe entries are on purpose. `/topics/:slug` and `/briefs/:id` are
 * reached by naming a thing, so a User who follows a dead link to one of them
 * gets a 404 — and a 404 that arrives without the shell is exactly the dead end
 * this work exists to remove, so it is checked like any other page.
 */
const SIGNED_IN_PAGES: readonly (readonly [string, number])[] = [
  ['/topics', 200],
  ['/pick-topics', 200],
  ['/discover', 200],
  ['/trends', 200],
  ['/onboarding/welcome', 200],
  ['/settings/delivery', 200],
  ['/settings/briefs', 200],
  ['/settings/billing', 200],
  ['/upgrade', 200],
  ['/archive/search', 200],
  ['/admin/briefs', 200],
  ['/topics/probe', 404],
  ['/topics/probe/trends', 404],
  ['/topics/probe/settings', 404],
  ['/briefs/probe', 404],
];

/**
 * The onboarding steps that are no longer onboarding once they are finished.
 *
 * They redirect rather than render, so they carry no shell of their own — which
 * is correct, since the screen that took over from them carries it.
 */
const REDIRECTS_ON_ARRIVAL: readonly string[] = [
  '/onboarding/pick-topics',
  '/onboarding/delivery-time',
];

/**
 * A signed-in User, by the only route that exists for one: request a magic link,
 * read it out of the mail the transport captured, and follow it.
 *
 * Not a session row written behind the application's back. The shell is what a
 * User is given on the way *into* the product, so a test that skips the way in has
 * not tested the way in — and the browser specs inject a session for the same
 * reason (a spec process cannot read the server's memory), which is exactly why
 * the HTTP suite is the place the magic link is exercised end to end.
 */
async function signIn(email = 'iris@example.com'): Promise<Harness> {
  resetDeterministic();
  const { db, driver } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(NOW).clock,
    random: deterministicRandom,
  });
  const requested = await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email },
  });
  if (requested.statusCode !== 202) {
    throw new Error(`magic-link request answered ${requested.statusCode}`);
  }
  const token = extractMagicLinkToken(transport.snapshot()[0]!.text);
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(token)}`,
  });
  const raw = verify.headers['set-cookie'];
  const sessionCookie = (Array.isArray(raw) ? raw[0]! : raw!).split(';')[0]!;
  // The session and the request token: a browser is handed a page before it
  // can submit a form, and every write checks the pair (ADR-0021).
  const { cookies: cookie } = await signedInCookies(app, sessionCookie);
  return { app, cookie, driver };
}

/** The same User, carried through onboarding so every page renders. */
async function signInAndOnboard(email = 'iris@example.com'): Promise<Harness> {
  const harness = await signIn(email);
  const { app, cookie } = harness;
  const templates = (
    (await app.inject({ method: 'GET', url: '/api/onboarding/templates' })).json() as {
      templates: { id: string }[];
    }
  ).templates;
  await submitForm(
    app,
    cookie,
    '/onboarding/pick-topics',
    { templateIds: templates.slice(0, 3).map((t) => t.id) },
  );
  await submitForm(app, cookie, '/onboarding/delivery-time', 'hour=8&minute=0&timezone=UTC');
  return harness;
}

/** The `<header>` of a rendered document, which is where the shell lives. */
function header(html: string): string {
  return html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? '';
}

function hrefs(html: string): readonly string[] {
  return [...html.matchAll(/href="([^"]+)"/g)].map((m) => m[1]!);
}

describe('the shell on every signed-in page', () => {
  let harness: Harness;
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    harness = await signInAndOnboard();
    app = harness.app;
    cookie = harness.cookie;
  });

  afterEach(async () => {
    await app.close();
  });

  for (const [url, status] of SIGNED_IN_PAGES) {
    it(`${url} renders through the shell`, async () => {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, `${url} answered ${res.statusCode}`).toBe(status);
      expect(res.headers['content-type']).toContain('text/html');

      const head = header(res.body);
      expect(head, `${url} has no header`).not.toBe('');
      expect(head, `${url} does not say who is signed in`).toContain('iris@example.com');
      expect(head, `${url} does not say which tier`).toMatch(/Free plan|Paid plan/);
      expect(head, `${url} does not say when the next brief arrives`).toContain('Next brief');
      expect(head, `${url} cannot sign out`).toContain('action="/auth/logout"');
      expect(head, `${url} has no navigation`).toContain('aria-label="Primary"');

      // A whole document rather than a fragment of one: the stylesheet, the
      // viewport and the landmarks come from the shell, not from the page.
      expect(res.body).toContain('<!doctype html>');
      expect(res.body).toContain('<main id="main"');
      expect(res.body).toContain('class="skip-link"');
    });
  }

  it('leaves no authenticated page outside the shell', async () => {
    // The list above is written out so each page gets its own failure, which a
    // loop over the manifest cannot give. This is what keeps the two in
    // agreement: a route added later and not listed here fails.
    const declared = app.routeManifest.filter(
      (r) =>
        !r.autoHead &&
        r.method === 'GET' &&
        r.access === 'authenticated' &&
        // The JSON surfaces are not pages and carry no shell; they answer a
        // machine.
        !r.url.startsWith('/api/'),
    );
    const listed = new Set(SIGNED_IN_PAGES.map(([url]) => url));
    const unlisted: string[] = [];
    for (const route of declared) {
      const url = route.url.replace(/:[A-Za-z0-9_]+/g, 'probe');
      if (listed.has(url) || REDIRECTS_ON_ARRIVAL.includes(url)) continue;
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      // A page that answers anything other than a redirect is a page a User can
      // be left on, so it has to be on the list.
      if (res.statusCode !== 302) unlisted.push(`${route.method} ${route.url} → ${res.statusCode}`);
    }
    expect(unlisted).toEqual([]);
  });

  it('offers a way back and a way out from the delivery settings page', async () => {
    // Named on its own because this is the page that used to have neither.
    const res = await app.inject({
      method: 'GET',
      url: '/settings/delivery',
      headers: { cookie },
    });
    expect(hrefs(header(res.body))).toContain('/topics');
    expect(header(res.body)).toContain('action="/auth/logout"');
  });

  it('says the next brief is not coming once a User has stopped their emails', async () => {
    const userId = (
      harness.driver.prepare(`SELECT id FROM users LIMIT 1`).get() as { id: string }
    ).id;
    harness.driver
      .prepare(`UPDATE users SET unsubscribed_at = ? WHERE id = ?`)
      .run(NOW.getTime(), userId);

    const res = await app.inject({ method: 'GET', url: '/topics', headers: { cookie } });
    const head = header(res.body);
    expect(head).not.toContain('Next brief');
    // And it says where to change that, because an opt-out with no way back is a
    // setting the User has lost control of.
    expect(hrefs(head)).toContain('/settings/briefs');
  });

  it('offers a delivery time to a User who has not chosen one', async () => {
    // Signed in but not onboarded: the magic link, and nothing else.
    const fresh = await signIn();
    const res = await fresh.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: fresh.cookie },
    });
    const head = header(res.body);
    expect(head).not.toContain('Next brief');
    expect(hrefs(head)).toContain('/settings/delivery');
    await fresh.app.close();
  });
});

describe('an address that does not exist', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    ({ app, cookie } = await signInAndOnboard());
  });

  afterEach(async () => {
    await app.close();
  });

  it('is a real page rather than the framework saying so', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/there-is-no-such-page',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<!doctype html>');
    expect(res.body).toContain('<main id="main"');
    expect(res.body).toContain('<h1>');
    // What Fastify answers with when nobody has said otherwise.
    expect(res.body).not.toContain('Route GET:');
    expect(res.body).not.toContain('"statusCode":404');
  });

  it('lands a signed-in User inside the shell, with a way out of it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/nope/deeper/still',
      headers: { cookie },
    });
    const head = header(res.body);
    expect(head).toContain('aria-label="Primary"');
    expect(head).toContain('iris@example.com');
    expect(head).toContain('action="/auth/logout"');
    expect(hrefs(res.body)).toContain('/topics');
  });

  it('offers an anonymous visitor a way in rather than a dead end', async () => {
    const res = await app.inject({ method: 'GET', url: '/nope/deeper/still' });
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('<!doctype html>');
    expect(hrefs(res.body)).toContain('/signup');
    // And no navigation to pages the visitor cannot reach.
    expect(header(res.body)).not.toContain('aria-label="Primary"');
  });

  it('answers a verb the route does not take the same way', async () => {
    // `POST /topics` is not a route, and a dead end is a dead end whichever verb
    // it arrives on.
    const res = await submitForm(app, cookie, '/topics', '');
    expect(res.statusCode).toBe(404);
    expect(res.body).toContain('<!doctype html>');
  });

  it('answers a JSON surface in JSON, since that is what it is for', async () => {
    // The rest of the application already splits on this: `requireAuth` takes a
    // `json` flag and the `/api` routes answer with a body. Handing a machine an
    // HTML document is the same mistake as handing a page a JSON error.
    const res = await app.inject({ method: 'GET', url: '/api/nothing-here' });
    expect(res.statusCode).toBe(404);
    expect(res.headers['content-type']).toContain('application/json');
    expect(res.json()).toEqual({ error: 'not_found' });
  });
});

describe('signing in and out through the shell', () => {
  let app: FastifyInstance;
  let cookie: string;

  beforeEach(async () => {
    ({ app, cookie } = await signInAndOnboard());
  });

  afterEach(async () => {
    await app.close();
  });

  it('signs out with the session the shell handed the browser', async () => {
    // The control is a form in the header, so what has to work is a POST of
    // nothing but the token that form carries, from any page.
    const before = await app.inject({ method: 'GET', url: '/topics', headers: { cookie } });
    expect(header(before.body)).toContain('action="/auth/logout"');

    const out = await submitForm(app, cookie, '/auth/logout', '');
    expect(out.statusCode).toBe(302);
    expect(out.headers.location).toBe('/');
    expect(out.headers['set-cookie']).toBeDefined();

    const after = await app.inject({ method: 'GET', url: '/topics', headers: { cookie } });
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toBe('/signup');
  });

  it('lands a User who signs in inside the shell, at the step they still owe', async () => {
    // The other half of "sign-out and sign-in still work end to end through the
    // shell". The browser specs cannot cover it: they present a session row the
    // fixture server wrote, because a spec process cannot read that server's
    // memory. So the magic link is followed here, over HTTP, and the document it
    // lands on is asserted rather than assumed.
    const fresh = await signIn('nadia@example.com');

    const res = await fresh.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: fresh.cookie },
    });
    expect(res.statusCode).toBe(200);

    // The shell, with this User's own account in it.
    const head = header(res.body);
    expect(head).toContain('nadia@example.com');
    expect(head).toContain('action="/auth/logout"');
    expect(head).toContain('aria-label="Primary"');
    // A User with no topics and no delivery time is told both, rather than being
    // shown a plan and a time that were never chosen.
    expect(res.body).toMatch(/You haven't picked any topics yet/);
    expect(hrefs(head)).toContain('/settings/delivery');

    await fresh.app.close();
  });

  it('reaches the topic list and topic management from the last onboarding step', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/onboarding/welcome',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(200);
    const page = hrefs(res.body);
    // The list itself, and the screen that adds to it — both named in the
    // acceptance criteria, and two different pages.
    expect(page, 'the welcome step cannot reach the topic list').toContain('/topics');
    expect(page, 'the welcome step cannot reach topic management').toContain('/pick-topics');
    // Through the shell as well as through the page's own copy: the navigation is
    // the one that is on every page.
    const head = hrefs(header(res.body));
    expect(head).toContain('/topics');
    expect(head).toContain('/pick-topics');
  });

  it('sends an onboarded User off the steps that have been completed', async () => {
    for (const url of REDIRECTS_ON_ARRIVAL) {
      const res = await app.inject({ method: 'GET', url, headers: { cookie } });
      expect(res.statusCode, `${url} still offers onboarding`).toBe(302);
      expect(['/pick-topics', '/settings/delivery']).toContain(res.headers.location);
    }
  });
});