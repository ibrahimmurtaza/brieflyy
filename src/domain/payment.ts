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

/**
 * The events this application acts on, as two shapes rather than one with blanks.
 *
 * A `subscription_ended` names a Subscription and nothing else: there is no
 * Checkout behind it, because the Checkout happened months ago and the reference
 * it carried was minted for the moment the payment completed. Modelling it as one
 * interface with an optional reference would mean writing an empty string for a
 * value that is genuinely absent, and an empty string reads back like an id
 * somebody gave us — which is the mistake the `customerRef` half of this same
 * interface was already written to avoid.
 *
 * Both carry the provider's own name for the Subscription, which is what resolves
 * the User for the second and is recorded alongside the first.
 */
export type PaymentEvent =
  | {
      readonly kind: 'checkout_completed';
      /** The provider's own identifier. The replay key: one event is one grant. */
      readonly id: string;
      /** The Checkout reference Brieflyy minted, which resolves the User. */
      readonly reference: string;
      readonly subscriptionRef: string;
      /** Nullable because a provider can complete a payment before it names the payer. */
      readonly customerRef: string | null;
    }
  | {
      readonly kind: 'subscription_ended';
      /** The provider's own identifier, and the replay key as it is for the other. */
      readonly id: string;
      readonly subscriptionRef: string;
      readonly customerRef: string | null;
    };

/**
 * What the provider currently says about one Subscription.
 *
 * Three facts, and the third is the one that decides whether a cancellation has
 * happened. `renewsAt` is the end of the period already paid for: while it is in
 * the future the User is still paying, and a cancellation asked for today stops
 * the charge *after* it rather than immediately, so this date is what the
 * Subscription settings page has to name rather than a day computed from
 * `startedAt`.
 */
export interface ProviderSubscription {
  /** The provider's own name for the payer, or null where it has named none. */
  readonly customerRef: string | null;
  /** When the period already paid for ends, or null where the provider named none. */
  readonly renewsAt: Date | null;
  /** Whether the provider has been told to stop, taking effect at that date. */
  readonly cancelAtPeriodEnd: boolean;
}

/**
 * What asking the provider about a Subscription came back with.
 *
 * `known` and `unknown` are both answers, and they are different ones: a provider
 * holding no such Subscription is telling this application something real, and it
 * is the answer that ends a cancelled Subscription rather than leaving it as one
 * the User is still paying for. `unavailable` is somebody else's service not
 * answering, which is not a fact about the Subscription at all — it is why the
 * stored row is left standing rather than overwritten with a guess.
 */
export type SubscriptionReading =
  | { readonly status: 'known'; readonly current: ProviderSubscription }
  | { readonly status: 'unknown' }
  | { readonly status: 'unavailable' };

/**
 * What asking the provider to stop a Subscription came back with.
 *
 * `already_ended` is a separate answer from `unavailable` for a reason a User feels:
 * a provider holding no such Subscription is not unreachable, and the sentence the
 * page writes for the second one — "it has not been changed and will keep charging
 * as it is" — is the exact opposite of the truth for the first. A User who pressed
 * the button after the provider had already finished must be told it is stopped.
 */
export type CancellationReading =
  | { readonly status: 'stopping'; readonly current: ProviderSubscription }
  | { readonly status: 'already_ended' }
  | { readonly status: 'unavailable' };

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
  /** What the provider currently says about a Subscription. */
  readSubscription(subscriptionRef: string): Promise<SubscriptionReading>;
  /**
   * Ask the provider to stop charging for a Subscription.
   *
   * It must take effect at the end of the period the User has already paid for,
   * not immediately: "stop the next charge" is what a cancellation means, and an
   * implementation that cut the period short would be a different promise from the
   * one the page beside it makes. The answer carries the state the provider then
   * holds, so the date the Subscription stops is the provider's rather than one
   * derived here.
   */
  cancelSubscription(subscriptionRef: string): Promise<CancellationReading>;
  /** What a signed request carried. Only a `verified` reading may change anything. */
  readEvent(signed: SignedRequest): PaymentEventReading;
}

export type { CheckoutReference };