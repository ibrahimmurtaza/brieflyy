import type {
  CheckoutReference,
  PaymentEventKind,
  UserId,
} from './types.js';

/**
 * Everything the application has to tell a PaymentProvider to start a Checkout.
 *
 * The reference and the two addresses are the interesting ones. The reference is
 * a value Brieflyy minted and stored, because it is the only thing a completed
 * event can be traced back through. The addresses are Brieflyy's own pages,
 * passed in rather than read from configuration here: this module has no idea
 * where the application lives, and a provider implementation that guessed would
 * be a second answer to a question the composition root already knows.
 */
export interface CheckoutRequest {
  readonly userId: UserId;
  /** The address the receipt goes to, which is the Account's. */
  readonly email: string;
  readonly reference: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

/** The hosted page the User pays on. Not Brieflyy's to render, and it does not try. */
export interface Checkout {
  readonly url: string;
}

/**
 * A request as it arrived, before anything has been read out of it.
 *
 * The body is the exact bytes the sender sent rather than a parsed object,
 * because a signature covers the bytes: a parsed body can be re-serialised into
 * something that is equal as JSON and different as a message, and a check against
 * the re-serialised form would be a check of something the sender never signed.
 */
export interface SignedRequest {
  readonly body: string;
  readonly signature: string;
}

/** The one event this application acts on. */
export interface PaymentEvent {
  /** The provider's own identifier. The replay key: one event is one grant. */
  readonly id: string;
  readonly kind: PaymentEventKind;
  /** The Checkout reference Brieflyy minted, which resolves the User. */
  readonly reference: string;
  readonly subscriptionRef: string;
  /** Nullable because a provider can complete a payment before it names the payer. */
  readonly customerRef: string | null;
}

/**
 * What a signed request carried, in three answers rather than two.
 *
 * `verified` is the only one that can change anything. `unsigned` is a request
 * whose signature did not hold: refused, and nothing written. `unrecognised` is a
 * request that verified and named something this application does not act on â€”
 * acknowledged so the sender stops retrying it, and still nothing written, because
 * a provider sends many events and this one acts on one.
 *
 * Collapsing `unsigned` and `unrecognised` would leave a reader unable to tell a
 * forgery from a routine event, which are the two answers an operator most needs
 * to tell apart.
 */
export type PaymentEventReading =
  | { readonly status: 'verified'; readonly event: PaymentEvent }
  | { readonly status: 'unsigned' }
  | { readonly status: 'unrecognised' };

/**
 * Somebody a User pays through, and the only door money comes in by.
 *
 * `readEvent` rather than a verify-then-parse pair on purpose: the signature and
 * the meaning of the payload are one decision. A seam that handed back a verified
 * boolean and the payload beside it would let a caller act on a payload the check
 * had not been run against, and the mistake that causes is silent.
 */
export interface PaymentProvider {
  /** The name stored against what this provider says, so two can never be confused. */
  readonly providerName: string;
  /**
   * The header a signed event's signature arrives in, for a route to read it from.
   *
   * Asked of the provider rather than imported by the caller, because the header is
   * the provider's own protocol: a route that hardcoded Stripe's would have to be
   * edited to add a second one, which is the seam not being a seam.
   */
  readonly signatureHeader: string;
  /** The hosted page the User pays on. */
  startCheckout(request: CheckoutRequest): Promise<Checkout>;
  /** What a signed request carried. Only a `verified` reading may change anything. */
  readEvent(signed: SignedRequest): PaymentEventReading;
}

export type { CheckoutReference };