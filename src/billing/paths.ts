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

/** The two values the hosted checkout's return address can carry, as the page reads them. */
export const CHECKOUT_RETURNED_VALUE = 'complete';
export const CHECKOUT_CANCELLED_VALUE = 'cancelled';

/** The query each return address carries, so the service and the page cannot disagree. */
export const CHECKOUT_RETURNED_QUERY = `checkout=${CHECKOUT_RETURNED_VALUE}`;
export const CHECKOUT_CANCELLED_QUERY = `checkout=${CHECKOUT_CANCELLED_VALUE}`;

/** The upgrade page, which is both what a Checkout is started from and where it returns to. */
export const UPGRADE_PATH = '/upgrade';