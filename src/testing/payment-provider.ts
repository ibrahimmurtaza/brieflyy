import type {
  Checkout,
  CheckoutRequest,
  PaymentEvent,
  PaymentEventReading,
  PaymentProvider,
  SignedRequest,
} from '../domain/payment.js';
import type { UserId } from '../domain/types.js';

export interface RecordedCheckout {
  readonly userId: UserId;
  readonly email: string;
  /** The value Brieflyy minted, which a completed event would come back naming. */
  readonly reference: string;
  readonly successUrl: string;
  readonly cancelUrl: string;
}

/**
 * The one double for the PaymentProvider, so a test that cares what a checkout
 * cost or what the application asked for is not written twice.
 *
 * It records every Checkout it was asked to start and answers with whatever the
 * test decides, so a provider that refuses can be told to refuse.
 *
 * What it will not do is invent a signature. `readEvent` answers `unsigned` for
 * everything unless the test handed it a reading to answer with, because a double
 * that verified its own invented bytes would prove nothing about whether a real
 * signature is checked. The signature path is exercised where it lives — the
 * Stripe provider itself, driven with genuinely signed requests in
 * `src/billing/billing-routes.test.ts` and `stripe-payment-provider.test.ts`.
 */
export class RecordingPaymentProvider implements PaymentProvider {
  readonly providerName = 'recording';
  readonly signatureHeader = 'x-recording-signature';
  readonly checkouts: RecordedCheckout[] = [];

  /** Every signed request it was asked about, in order. */
  readonly signedRequests: SignedRequest[] = [];

  private readonly answerCheckout: (request: CheckoutRequest) => Checkout;
  private readonly answerEvent: (signed: SignedRequest) => PaymentEventReading;

  constructor(
    input: {
      /** Where a started Checkout sends the User. */
      readonly checkoutUrl?: string;
      /** A provider that refuses, for the page that has to say so. */
      readonly refusing?: boolean;
      /**
       * What to answer each signed request with. Absent means "nothing verified",
       * which is the honest answer for a double that has no secret of its own.
       */
      readonly event?: (signed: SignedRequest) => PaymentEventReading;
    } = {},
  ) {
    const url = input.checkoutUrl ?? 'https://checkout.recording.test/pay/cs_recorded';
    this.answerCheckout = input.refusing
      ? () => {
          throw new Error('this PaymentProvider is not taking checkouts');
        }
      : () => ({ url });
    this.answerEvent = input.event ?? (() => ({ status: 'unsigned' }));
  }

  async startCheckout(request: CheckoutRequest): Promise<Checkout> {
    this.checkouts.push({
      userId: request.userId,
      email: request.email,
      reference: request.reference,
      successUrl: request.successUrl,
      cancelUrl: request.cancelUrl,
    });
    return this.answerCheckout(request);
  }

  readEvent(signed: SignedRequest): PaymentEventReading {
    this.signedRequests.push(signed);
    return this.answerEvent(signed);
  }
}

/**
 * A double that answers every signed request with one event, as if it had verified
 * it. For a test about what the application does *after* a provider has spoken,
 * never for one about whether a provider would.
 */
export function answeringWith(
  event: PaymentEvent,
): (signed: SignedRequest) => PaymentEventReading {
  return () => ({ status: 'verified', event });
}