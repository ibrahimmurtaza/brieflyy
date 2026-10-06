import { describe, expect, it } from 'vitest';

import type { Subscription } from '../domain/types.js';
import type { BillingState } from './billing-service.js';
import { BILLING_CANCEL_PATH } from './paths.js';
import { subscriptionSettingsPage } from './subscription-settings.js';

const STARTED = new Date('2026-03-01T12:00:00Z');
const ASKED = new Date('2026-03-20T08:30:00Z');
const RENEWS = new Date('2026-04-01T12:00:00Z');

const ACCOUNT = {
  email: 'iris@example.com',
  tier: 'paid',
  brief: { kind: 'unset' },
} as const;

function aSubscription(overrides: Partial<Subscription> = {}): Subscription {
  return {
    id: 'sub_row',
    userId: 'user-iris',
    provider: 'stripe',
    subscriptionRef: 'sub_test_1',
    customerRef: 'cus_test_1',
    startedAt: STARTED,
    status: 'active',
    renewsAt: RENEWS,
    cancelledAt: null,
    ...overrides,
  };
}

function thePage(input: {
  readonly state: BillingState;
  readonly stopped?: Parameters<typeof subscriptionSettingsPage>[0]['stopped'];
  readonly paymentsAvailable?: boolean;
}): string {
  return subscriptionSettingsPage({
    account: ACCOUNT,
    state: input.state,
    stopped: input.stopped ?? null,
    paymentsAvailable: input.paymentsAvailable ?? true,
    timezone: 'UTC',
    requestToken: 'tok_1',
  });
}

/** The inside of the page, so the header's sign-out form is never mistaken for one. */
function inside(page: string): string {
  return page.match(/<main[^>]*>[\s\S]*<\/main>/)?.[0] ?? page;
}

describe('a User with no subscription', () => {
  it('is answered with what they have, rather than shown an error', () => {
    const page = thePage({ state: { kind: 'none' } });

    // The commonest arrival there is, and it is a whole page rather than an absence.
    expect(inside(page)).toMatch(/You are on the free plan/);
    expect(inside(page)).toMatch(/no paid subscription on this account/i);
    expect(inside(page)).toMatch(/href="\/upgrade"/);
    expect(inside(page)).not.toMatch(/<form/);
  });
});

describe('a User who is paying', () => {
  it('states the plan, the renewal date and that nothing has been asked to stop', () => {
    const page = thePage({
      state: { kind: 'known', freshness: 'recorded', subscription: aSubscription() },
    });

    expect(inside(page)).toMatch(/You are on the paid plan/);
    // Read out of the stored row rather than worked out from `startedAt`, in the
    // User's own zone — the same reading every other dated page makes.
    expect(inside(page)).toMatch(/Next charge on Wed, 1 Apr at 12:00 \(UTC\)/);
  });

  it('offers a cancellation that carries the request token the guard needs', () => {
    const page = thePage({
      state: { kind: 'known', freshness: 'recorded', subscription: aSubscription() },
    });

    // The request token is what makes this a Brieflyy submission rather than
    // something a page elsewhere caused (ADR-0021).
    expect(inside(page)).toMatch(
      new RegExp(`<form method="post" action="${BILLING_CANCEL_PATH}"`),
    );
    expect(inside(page)).toMatch(/name="requestToken"/);
    expect(inside(page)).toMatch(/value="tok_1"/);
  });

  it('says what cancelling will not do, in the same sentence as the date', () => {
    const page = thePage({
      state: { kind: 'known', freshness: 'recorded', subscription: aSubscription() },
    });

    expect(inside(page)).toMatch(
      /keep the paid plan until Wed, 1 Apr at 12:00 \(UTC\), and there is no charge after that date/,
    );
    expect(inside(page)).toMatch(/Nothing is taken away before then/);
  });

  it('says when it asked, so a stale row is not read as a fresh one', () => {
    // Only `unreachable` gets an apology. A page that had no reason to ask the
    // provider has nothing to apologise for, and saying so on every read would make
    // the sentence meaningless on the read where it is true.
    const asked = thePage({
      state: { kind: 'known', freshness: 'asked', subscription: aSubscription() },
    });
    const recorded = thePage({
      state: { kind: 'known', freshness: 'recorded', subscription: aSubscription() },
    });
    const unreachable = thePage({
      state: { kind: 'known', freshness: 'unreachable', subscription: aSubscription() },
    });

    expect(inside(asked)).not.toMatch(/could not be reached/);
    expect(inside(recorded)).not.toMatch(/could not be reached/);
    expect(inside(unreachable)).toMatch(/could not be reached just now/);
    expect(inside(unreachable)).toMatch(/this is what we last recorded/i);
  });

  it('says the renewal date is unknown rather than inventing one', () => {
    // A date worked out from `startedAt` here would be this application's guess
    // printed as though the provider had said it — and "Next charge on <unknown>"
    // is a sentence about something that has not been established.
    const page = thePage({
      state: {
        kind: 'known',
        freshness: 'unreachable',
        subscription: aSubscription({ renewsAt: null }),
      },
    });

    expect(inside(page)).toMatch(/has not been able to ask the payment provider when your next charge falls/);
    expect(inside(page)).not.toMatch(/Next charge on/);
  });
});

describe('a Subscription that is stopping', () => {
  const cancelling = aSubscription({ status: 'cancelling', cancelledAt: ASKED });

  it('says when it runs out and that nothing is being taken away before then', () => {
    const page = thePage({ state: { kind: 'known', freshness: 'recorded', subscription: cancelling } });

    expect(inside(page)).toMatch(/runs until Wed, 1 Apr at 12:00 \(UTC\)/);
    expect(inside(page)).toMatch(/You asked on \w+, 20 Mar at 08:30 \(UTC\)/);
    expect(inside(page)).toMatch(/none of it has been taken away/i);
  });

  it('offers no second cancellation, because asking again could not differ', () => {
    const page = thePage({ state: { kind: 'known', freshness: 'recorded', subscription: cancelling } });

    expect(inside(page)).not.toMatch(/<form/);
  });

  it('offers the way back to paying, which is the only thing left to decide', () => {
    const page = thePage({ state: { kind: 'known', freshness: 'recorded', subscription: cancelling } });

    expect(inside(page)).toMatch(/Go back to paid/);
  });
});

describe('a Subscription that has ended', () => {
  it('says what it means rather than reporting nothing to show', () => {
    const page = thePage({
      state: {
        kind: 'known',
        freshness: 'asked',
        subscription: aSubscription({ status: 'ended', cancelledAt: ASKED }),
      },
    });

    expect(inside(page)).toMatch(/Your paid plan has ended/);
    expect(inside(page)).toMatch(/on the free plan now/);
    expect(inside(page)).toMatch(/href="\/upgrade"/);
  });
});

describe('an instance with no payment provider', () => {
  const paying = {
    kind: 'known',
    freshness: 'recorded',
    subscription: aSubscription(),
  } as const;

  it('states the Subscription and offers nothing on its behalf', () => {
    const page = thePage({ state: paying, paymentsAvailable: false });

    // A deployment that has lost its Stripe configuration is the only state in which
    // this application holds a Subscription it cannot act on, and the Subscription
    // is still what happened. What is withheld is the control — a button that could
    // not work is worse than a sentence saying why (ADR-0019).
    expect(inside(page)).toMatch(/You are on the paid plan/);
    expect(inside(page)).toMatch(/no payment provider set up/i);
    expect(inside(page)).toMatch(/no button to press/i);
    expect(inside(page)).not.toMatch(/<form/);
  });
});

describe('what the last cancellation submission said', () => {
  const state = { kind: 'known', freshness: 'recorded', subscription: aSubscription() } as const;

  const ANSWERS: readonly {
    readonly answer: NonNullable<Parameters<typeof subscriptionSettingsPage>[0]['stopped']>;
    readonly said: RegExp;
  }[] = [
    { answer: 'stopped', said: /The next charge has been stopped/ },
    { answer: 'already-stopped', said: /It was already set to stop/ },
    { answer: 'nothing-to-stop', said: /There was nothing to stop/ },
    { answer: 'not-configured', said: /no payment provider set up/i },
  ];

  for (const { answer, said } of ANSWERS) {
    it(`announces ${answer}`, () => {
      expect(inside(thePage({ state, stopped: answer }))).toMatch(said);
    });
  }

  it('says exactly what did not happen when the provider could not be reached', () => {
    // The opposite claim to the success one, so the sentence has to carry the
    // consequence in it: a User who leaves this page believing the charge had
    // stopped would not know to come back.
    const page = thePage({ state, stopped: 'unavailable' });

    expect(inside(page)).toMatch(/could not reach the payment provider/i);
    expect(inside(page)).toMatch(/has not been changed and will keep charging as it is/);
  });

  it('says nothing when nobody has submitted anything', () => {
    expect(inside(thePage({ state }))).not.toMatch(/callout/);
  });
});