/**
 * Where the billing routes live, as names rather than as strings.
 *
 * The same two paths appear in three places — the routes, the public allowlist
 * and the cross-site guard's exemptions — and a path spelled out twice is a
 * public surface that can drift from the one that exists. This is the same
 * arrangement `src/services/unsubscribe-links.ts` exists for, and it is here
 * rather than in `config.ts` because these are the billing layer's own addresses
 * rather than settings a deployment can change.
 */
export const CHECKOUT_PATH = '/billing/checkout';
export const BILLING_WEBHOOK_PATH = '/billing/webhook';

/**
 * Where a User reads what they are paying for, and where they stop it.
 *
 * Two addresses rather than one because they are two different things: a page a
 * User reads and a write they submit. They live under `/settings` beside the
 * delivery time because that is where the shell already sends somebody who wants to
 * change something about their account, and a billing page under `/billing` would
 * be the one settings screen the navigation had to special-case.
 */
export const BILLING_SETTINGS_PATH = '/settings/billing';
export const BILLING_CANCEL_PATH = '/settings/billing/cancel';

/**
 * The one query the billing page reads after a cancellation submission, and the
 * five answers it can carry.
 *
 * As a value rather than five constants because the route builds the address and
 * the page reads it, and two spellings of the same answer is one more thing for a
 * reader to reconcile: the route cannot redirect to something the page would not
 * recognise, and the page cannot announce something the route never sends.
 */
export const BILLING_STOPPED_QUERY = 'stopped';

export const BILLING_STOPPED_ANSWERS = [
  'stopped',
  'already-stopped',
  'nothing-to-stop',
  'unavailable',
  'not-configured',
] as const;
export type BillingStoppedAnswer = (typeof BILLING_STOPPED_ANSWERS)[number];

/** The values the hosted checkout's return address can carry, as the page reads them. */
export const CHECKOUT_RETURNED_VALUE = 'complete';
export const CHECKOUT_CANCELLED_VALUE = 'cancelled';

/** The query each return address carries, so the service and the page cannot disagree. */
export const CHECKOUT_RETURNED_QUERY = `checkout=${CHECKOUT_RETURNED_VALUE}`;
export const CHECKOUT_CANCELLED_QUERY = `checkout=${CHECKOUT_CANCELLED_VALUE}`;

/** The upgrade page, which is both what a Checkout is started from and where it returns to. */
export const UPGRADE_PATH = '/upgrade';