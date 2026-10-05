import { createHmac } from 'node:crypto';

/**
 * The secrets a Stripe provider is built with in this repository's tests.
 *
 * Written down here rather than read from anywhere, which is the whole claim the
 * billing tests make: a test holds a stand-in it made itself, so no credential a
 * deployment has is reachable from a test. They are in Stripe's own formats
 * because a fixture for a credential has to look like the credential, and neither
 * will work anywhere.
 */
export const STRIPE_API_KEY =
  'sk_test_example_only'; // secret-scan:allow a fixture: the provider sends it as a bearer token
export const STRIPE_WEBHOOK_SECRET =
  'whsec_example_only'; // secret-scan:allow a fixture: the signature path has to have a key to sign with
export const STRIPE_PAID_PRICE_ID = 'price_example_only';

/** What a signed request carries, as the two halves the application receives. */
export interface SignedWebhook {
  readonly body: string;
  readonly signature: string;
}

/**
 * The signature header a Stripe webhook arrives with.
 *
 * Written out rather than imported, because a test that built its signed request
 * with the same function the application verifies it with would agree with a
 * verifier that is wrong. This is the provider's documented format — a timestamp
 * and one or more digests of `<timestamp>.<body>` — and it is computed here so the
 * only shared code is `node:crypto`.
 */
export function stripeSignatureHeader(
  secret: string,
  timestamp: number,
  body: string,
): string {
  const digest = createHmac('sha256', secret)
    .update(`${timestamp}.${body}`, 'utf8')
    .digest('hex');
  return `t=${timestamp},v1=${digest}`;
}

/** The one event type this application acts on, in the shape the provider sends it. */
export function checkoutCompletedBody(input: {
  readonly eventId: string;
  readonly reference: string;
  readonly createdAt?: number;
  readonly subscriptionRef?: string;
  readonly customerRef?: string;
}): string {
  return JSON.stringify({
    id: input.eventId,
    type: 'checkout.session.completed',
    created: input.createdAt ?? 0,
    data: {
      object: {
        id: 'cs_test_1',
        object: 'checkout.session',
        mode: 'subscription',
        client_reference_id: input.reference,
        customer: input.customerRef ?? 'cus_test_1',
        subscription: input.subscriptionRef ?? 'sub_test_1',
      },
    },
  });
}

/** A signed `checkout.session.completed`, ready to be posted with no session at all. */
export function signedCheckoutCompleted(input: {
  readonly eventId: string;
  readonly reference: string;
  readonly timestamp: number;
  readonly secret?: string;
}): SignedWebhook {
  const body = checkoutCompletedBody(input);
  return {
    body,
    signature: stripeSignatureHeader(
      input.secret ?? STRIPE_WEBHOOK_SECRET,
      input.timestamp,
      body,
    ),
  };
}

/** Any other event the provider sends, signed the same way. */
export function signedEvent(input: {
  readonly eventId: string;
  readonly type: string;
  readonly timestamp: number;
  readonly secret?: string;
}): SignedWebhook {
  const body = JSON.stringify({
    id: input.eventId,
    type: input.type,
    created: 0,
    data: { object: { id: 'obj_1' } },
  });
  return {
    body,
    signature: stripeSignatureHeader(
      input.secret ?? STRIPE_WEBHOOK_SECRET,
      input.timestamp,
      body,
    ),
  };
}