import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';

import { createApp } from '../app.js';
import { REQUEST_TOKEN_FIELD, SESSION_COOKIE_NAME } from '../config.js';
import { ConsoleEmailTransport } from '../email/console-transport.js';
import type { FeedFetcher, RawFeed } from '../ingest/feed-fetcher.js';
import { createTestDb } from '../testing/test-db.js';
import { extractMagicLinkToken } from '../testing/email.js';
import { requestTokenOf, signedInCookies, submitForm } from '../testing/forms.js';
import {
  deterministicRandom,
  makeTestClock,
  resetDeterministic,
} from '../testing/test-clocks.js';
import { WRITE_GUARD_EXEMPTIONS, type RegisteredRoute } from './access.js';

class EmptyFeedFetcher implements FeedFetcher {
  async fetch(_url: string): Promise<RawFeed> {
    return { entries: [] };
  }
}

const NOW = new Date('2026-09-02T12:00:00Z');

interface Harness {
  readonly app: FastifyInstance;
  /** The session cookie alone, which is everything a page elsewhere can cause. */
  readonly sessionCookie: string;
  /** The session and the request token: what a signed-in browser holds. */
  readonly cookies: string;
  /** Another signed-in browser, for a test that must spend a session of its own. */
  signInAs(email: string): Promise<string>;
  readonly routes: readonly RegisteredRoute[];
}

let h: Harness;

/**
 * Everything here is driven through the real application rather than through a
 * unit of the guard: the claim is about the routes `createApp` registers and the
 * answers they give, and a test that called `requestTokenMismatch` directly
 * would pass whether or not any route was behind it.
 */
beforeAll(async () => {
  resetDeterministic();
  const { db } = createTestDb();
  const transport = new ConsoleEmailTransport({ logger: () => {} });
  const app = await createApp({
    db,
    emailTransport: transport,
    appBaseUrl: 'https://app.brieflyy.test',
    cookieSecure: false,
    clock: makeTestClock(NOW).clock,
    random: deterministicRandom,
    // Both switches the routes below are registered by, so the manifest holds
    // every state-changing route the application can have.
    feedFetcher: new EmptyFeedFetcher(),
    devToolsEnabled: true,
  });

  await app.inject({
    method: 'POST',
    url: '/auth/magic-link/request',
    payload: { email: 'iris@example.com' },
  });
  const verify = await app.inject({
    method: 'GET',
    url: `/auth/magic-link/verify?token=${encodeURIComponent(
      extractMagicLinkToken(transport.snapshot()[0]!.text),
    )}`,
  });
  // The session cookie alone is everything a page on another site can cause, and
  // the pair is what a signed-in browser holds. The two are kept apart because
  // most of what follows is one half of the pair against the other.
  const signInAs = async (email: string): Promise<string> => {
    await app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      payload: { email },
    });
    const link = await app.inject({
      method: 'GET',
      url: `/auth/magic-link/verify?token=${encodeURIComponent(
        extractMagicLinkToken(transport.snapshot().at(-1)!.text),
      )}`,
    });
    return (await signedInCookies(app, cookieNamed(link.headers, SESSION_COOKIE_NAME))).cookies;
  };

  const sessionCookie = cookieNamed(verify.headers, SESSION_COOKIE_NAME);
  const { cookies } = await signedInCookies(app, sessionCookie);

  h = {
    app,
    sessionCookie,
    cookies,
    signInAs,
    routes: app.routeManifest,
  };
});

afterAll(async () => {
  await h.app.close();
});

/** One cookie off a response, by name, as the browser would send it back. */
function cookieNamed(headers: Record<string, unknown>, name: string): string {
  const list = headers['set-cookie'];
  const cookies = Array.isArray(list) ? list : [list];
  const raw = cookies
    .filter((c): c is string => typeof c === 'string')
    .find((c) => c.startsWith(`${name}=`));
  if (!raw) throw new Error(`no ${name} cookie in ${JSON.stringify(cookies)}`);
  return raw.split(';')[0]!;
}

const label = (route: RegisteredRoute): string => `${route.method} ${route.url}`;

/** The routes the application declares, without Fastify's generated HEAD twins. */
const declared = (): readonly RegisteredRoute[] => h.routes.filter((r) => !r.autoHead);

/**
 * Every route that submits something, whether or not it is behind the guard.
 *
 * Named for what it can see rather than for what it means: a GET cannot carry a
 * form field, so the two GET routes that do change something are not in here, and
 * the test below says which they are and why.
 */
const submissions = (): readonly RegisteredRoute[] =>
  declared().filter((r) => r.method !== 'GET' && r.method !== 'HEAD');

const guarded = (): readonly RegisteredRoute[] =>
  declared().filter((r) => r.stateChange === 'guarded');

/** POST a route the way a page on another site can: a session, and nothing else. */
async function forge(
  route: RegisteredRoute,
  payload: string,
  cookies: string,
): Promise<{ status: number; body: string; location: string | undefined }> {
  const url = route.url.replace(/:[A-Za-z0-9_]+/g, 'probe');
  const resp = await h.app.inject({
    method: 'POST',
    url,
    headers: {
      cookie: cookies,
      origin: 'https://elsewhere.example',
      'content-type': 'application/x-www-form-urlencoded',
    },
    payload,
  });
  return {
    status: resp.statusCode,
    body: resp.body,
    location: resp.headers.location as string | undefined,
  };
}

/**
 * The `GET`s that change state, so the guard's edge is on the record.
 *
 * Two of them write a session and are the security problem ADR-0022 is about: a link
 * followed from an inbox is not a submission, so there is no form field for a token
 * and nothing stops a stranger sending a reader to their own verify link. The third
 * is `GET /settings/billing`, which writes the renewal date it read from the payment
 * provider. That one is a copy of what somebody else has already said rather than a
 * decision, so it is named here for the same reason rather than exempted quietly.
 *
 * A `GET` cannot carry a form field, so none of the three can be behind this guard.
 * They are enumerated because a silent gap reads like a guarantee.
 */
const STATE_CHANGING_GETS = [
  '/auth/google/callback',
  '/auth/magic-link/verify',
  '/settings/billing',
] as const;

describe('the cross-site write guard', () => {
  it('covers the submitting routes there are, rather than a chosen few', () => {
    // The enumeration is the claim: it comes from the manifest the application
    // built, so a route added tomorrow is in this list before it is in any of
    // these expectations.
    expect(submissions().length).toBeGreaterThan(10);
    expect(guarded().length).toBeGreaterThan(10);
  });

  it('puts every route that submits something behind the guard or writes down why not', () => {
    const undeclared = submissions()
      .filter((r) => r.stateChange !== 'guarded' && !WRITE_GUARD_EXEMPTIONS.has(label(r)))
      .map(label);

    expect(undeclared, 'declare stateChange: guarded, or name the exemption and why').toEqual([]);
  });

  it('names the routes that change state without submitting, so the gap is on the record', () => {
    // A GET has no body to echo the token in, so the guard cannot reach any of these.
    // They are here because a silent gap reads like a guarantee: following a magic
    // link a stranger chose signs the reader into the account that link belongs to,
    // and nothing in this application stops that (CONTEXT.md, Request token).
    //
    // The enumeration is the claim, and it is walked against the real manifest rather
    // than a list somebody kept — a fourth state-changing `GET` would fail this, which
    // is the point of naming them here rather than describing them in prose.
    const stateChangingGets = declared()
      .filter((r) => r.method === 'GET' && (STATE_CHANGING_GETS as readonly string[]).includes(r.url))
      .map(label)
      .sort();

    expect(stateChangingGets).toEqual(
      [...STATE_CHANGING_GETS].sort().map((url) => `GET ${url}`),
    );
  });

  it('names every exemption against a route that exists and is not guarded', () => {
    const labels = new Set(declared().map(label));
    const broken = [...WRITE_GUARD_EXEMPTIONS.keys()].filter(
      (name) => !labels.has(name) || guarded().some((r) => label(r) === name),
    );
    expect(broken, 'an exemption that names no route, or one that is guarded anyway').toEqual(
      [],
    );
  });

  it('says why each route is exempt rather than only that it is', () => {
    const unexplained = [...WRITE_GUARD_EXEMPTIONS.values()]
      .filter((reason) => reason.trim().length < 20)
      .map((reason) => reason);
    expect(unexplained, 'an exemption with no reason is a decision nobody made').toEqual([]);
  });

  it('refuses a submission that carries the session and no token, on every guarded route', async () => {
    const accepted: string[] = [];
    for (const route of guarded()) {
      const resp = await forge(route, 'clusterId=probe', h.cookies);
      if (resp.status !== 403) accepted.push(`${label(route)} answered ${resp.status}`);
    }
    expect(accepted).toEqual([]);
  });

  it('refuses a submission naming a token the cookie does not, on every guarded route', async () => {
    const accepted: string[] = [];
    for (const route of guarded()) {
      const resp = await forge(route, `${REQUEST_TOKEN_FIELD}=a-token-this-user-never-had`, h.cookies);
      if (resp.status !== 403) accepted.push(`${label(route)} answered ${resp.status}`);
    }
    expect(accepted).toEqual([]);
  });

  it('answers a refused submission in words, with the shell on it', async () => {
    const feedback = declared().find((r) => r.url === '/topics/:slug/feedback');
    if (!feedback) throw new Error('the Feedback write is not registered');

    const resp = await forge(feedback, 'clusterId=probe', h.cookies);

    expect(resp.status).toBe(403);
    expect(resp.body).toContain('did not come from a Brieflyy page');
    // The shell, because a User whose tab went stale is on their way back to a
    // page and a document with no way out of the product is not the answer.
    expect(resp.body).toContain('href="/topics"');
  });

  it('can still be signed out from the page it refused', async () => {
    // The sign-out form is in the shell, so a refusal page that carried no token
    // would have been a page a User could not sign out from — which is the one
    // thing somebody told a submission was refused might want to do next. A second
    // User signs in, so spending that session leaves the rest of this suite's
    // browser alone.
    const cookies = await h.signInAs('jules@example.com');
    const feedback = declared().find((r) => r.url === '/topics/:slug/feedback');
    if (!feedback) throw new Error('the Feedback write is not registered');
    const refused = await forge(feedback, 'clusterId=probe', cookies);
    const token = /name="requestToken" value="([^"]+)"/.exec(refused.body)?.[1];

    expect(token, 'the refusal page carries no token for the shell to echo').toBe(
      requestTokenOf(cookies),
    );

    const out = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: cookies,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `${REQUEST_TOKEN_FIELD}=${token}`,
    });
    expect(out.statusCode).toBe(302);

    const after = await h.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: cookies },
    });
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toBe('/signup');
  });

  it('turns a sessionless caller away the way the route does, rather than calling it a forgery', async () => {
    // With no session there is nothing to spend, so the route's own access answer
    // is the true one, and `route-guard.test.ts` holds every route to it. The guard
    // must not take that answer away.
    const delivery = declared().find((r) => r.url === '/settings/delivery');
    if (!delivery) throw new Error('the delivery-time write is not registered');

    const resp = await forge(delivery, 'hour=8&minute=0&timezone=UTC', '');

    expect(resp.status).toBe(302);
    expect(resp.location).toBe('/signup');
  });

  it('still signs a User out when there is no session to end', async () => {
    // The other side of the same rule: nothing to spend is nothing to guard, so a
    // sign-out button on a tab that has already been signed out still works rather
    // than answering a refusal for a request that could never have done anything.
    const out = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });

    expect(out.statusCode).toBe(302);
    expect(out.headers.location).toBe('/');
  });

  it('answers a submission a Brieflyy page made rather than refusing it', async () => {
    const delivery = declared().find((r) => r.url === '/settings/delivery');
    if (!delivery) throw new Error('the delivery-time write is not registered');

    const resp = await h.app.inject({
      method: 'POST',
      url: '/settings/delivery',
      headers: {
        cookie: h.cookies,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `hour=9&minute=30&timezone=UTC&${REQUEST_TOKEN_FIELD}=${requestTokenOf(h.cookies)}`,
    });

    expect(resp.statusCode).toBe(302);
    expect(resp.headers.location).toBe('/settings/delivery?saved=1');
  });

  it('cannot end a User\'s session from another site', async () => {
    // The one state change that costs an attacker nothing and costs the User
    // everything: no data is touched, the session simply stops.
    const forged = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: h.sessionCookie,
        origin: 'https://elsewhere.example',
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: '',
    });
    expect(forged.statusCode).toBe(403);

    const stillSignedIn = await h.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: h.sessionCookie },
    });
    expect(stillSignedIn.statusCode).toBe(200);
  });

  it('lets the shell\'s own sign-out through', async () => {
    const out = await h.app.inject({
      method: 'POST',
      url: '/auth/logout',
      headers: {
        cookie: h.cookies,
        'content-type': 'application/x-www-form-urlencoded',
      },
      payload: `${REQUEST_TOKEN_FIELD}=${requestTokenOf(h.cookies)}`,
    });
    expect(out.statusCode).toBe(302);

    const after = await h.app.inject({
      method: 'GET',
      url: '/topics',
      headers: { cookie: h.sessionCookie },
    });
    expect(after.statusCode).toBe(302);
    expect(after.headers.location).toBe('/signup');
  });

  it('answers a machine on a JSON surface in JSON, and only after the guard', async () => {
    // The one write behind the guard that no page submits: an operator's script
    // asking for a cycle. It is still a write against a User's session, so a
    // cross-site POST to it is refused — in JSON, because a machine is what called
    // it, and with a body it can branch on rather than a document.
    const forged = await h.app.inject({
      method: 'POST',
      url: '/api/ingest/tick',
      headers: {
        cookie: await h.signInAs('imani@example.com'),
        origin: 'https://elsewhere.example',
        'content-type': 'application/json',
      },
      payload: {},
    });
    expect(forged.statusCode).toBe(403);
    expect(forged.headers['content-type']).toContain('application/json');
    expect(forged.json()).toEqual({ error: 'forbidden' });

    // The same call with the pair a page would have echoed still runs the cycle.
    const run = await submitForm(h.app, await h.signInAs('kwame@example.com'), '/api/ingest/tick');
    expect(run.statusCode).toBe(200);
    expect(run.json()).toMatchObject({ cycleId: expect.any(String) });
  });

  it('leaves a machine alone where there is nothing to guard', async () => {
    // The two exempt writes: neither has a Brieflyy page behind it, so the guard
    // must not turn either into a 403, which would mean the application refused a
    // caller that has every right to ask.
    const anonymous = await h.app.inject({
      method: 'POST',
      url: '/api/ingest/tick',
      headers: { 'content-type': 'application/json' },
      payload: {},
    });
    expect(anonymous.statusCode).toBe(401);

    const magicLink = await h.app.inject({
      method: 'POST',
      url: '/auth/magic-link/request',
      headers: { 'content-type': 'application/json' },
      payload: { email: 'nia@example.com' },
    });
    expect(magicLink.statusCode, magicLink.body).toBe(202);
  });

  it('keeps answering a one-click unsubscribe, which has neither a session nor a form', async () => {
    // A mail client acting on `List-Unsubscribe` sends neither, and the token in
    // the URL is the whole authorisation. A 403 here would mean the guard broke
    // the only stop control a brief offers; 400 is the answer for a token no
    // brief was ever sent with, which is this one.
    const oneClick = await h.app.inject({
      method: 'POST',
      url: '/unsubscribe/topic?token=no-brief-ever-carried-this',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });

    expect(oneClick.statusCode).toBe(400);
    expect(oneClick.body).toContain('This unsubscribe link is not valid.');
  });
});