import type {
  CancellationReading,
  Checkout,
  CheckoutRequest,
  PaymentEvent,
  PaymentEventReading,
  PaymentProvider,
  ProviderSubscription,
  SignedRequest,
  SubscriptionReading,
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
 * One Subscription the double was asked about, by the name it was given.
 *
 * A type rather than a bare string because it is recorded in two lists that mean
 * different things — asked about, and told to stop — and a test that compared them
 * has to be able to say which it is looking at.
 */
export interface RecordedSubscription {
  readonly subscriptionRef: string;
}

/**
 * The renewal date a double's Subscription carries when a test says nothing about
 * it.
 *
 * Exported rather than written into the default beside it, because a test that
 * asserts on the date has to be able to name the same value the double invents.
 */
export const RECORDED_RENEWAL = new Date('2026-05-01T09:00:00Z');

/**
 * The one double for the PaymentProvider, so a test that cares what a checkout
 * cost or what the application asked for is not written twice.
 *
 * It records every Checkout it was asked to start and answers with whatever the
 * test decides, so a provider that refuses can be told to refuse. The same three
 * knobs exist for reading and for stopping a Subscription, because those are the
 * other two things this application asks a provider and they fail differently:
 * a Subscription the provider has stopped holding is not a Subscription nobody can
 * reach, and a service that cannot be reached is neither.
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

  /** Every Subscription it was asked about, in order. */
  readonly reads: RecordedSubscription[] = [];

  /** Every Subscription it was told to stop, in order. */
  readonly cancellations: RecordedSubscription[] = [];

  private readonly answerCheckout: (request: CheckoutRequest) => Checkout;
  private readonly answerEvent: (signed: SignedRequest) => PaymentEventReading;
  private readonly answerRead: (subscriptionRef: string) => Promise<SubscriptionReading>;
  private readonly answerCancel: (subscriptionRef: string) => Promise<CancellationReading>;

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
      /**
       * What a Subscription of this provider currently looks like. Absent means
       * "still paying, renewing next month", which is the state almost every one of
       * them is in.
       */
      readonly subscription?: (subscriptionRef: string) => ProviderSubscription;
      /**
       * A provider that has stopped holding the Subscription — a cancellation whose
       * period has run out. Distinct from `unreachable`, which says the provider
       * could not be asked, and the whole reason the two are not one answer.
       */
      readonly unknownSubscription?: boolean;
      /** A provider that will not answer, for a page that has to say the state it shows is as last recorded. */
      readonly unreachable?: boolean;
      /** A provider that refuses to stop a Subscription. */
      readonly refusingCancellation?: boolean;
    } = {},
  ) {
    const url = input.checkoutUrl ?? 'https://checkout.recording.test/pay/cs_recorded';
    this.answerCheckout = input.refusing
      ? () => {
          throw new Error('this PaymentProvider is not taking checkouts');
        }
      : () => ({ url });
    this.answerEvent = input.event ?? (() => ({ status: 'unsigned' }));
    const current = input.subscription ?? (() => ({
      customerRef: 'cus_recorded',
      renewsAt: RECORDED_RENEWAL,
      cancelAtPeriodEnd: false,
    }));
    this.answerRead = async (subscriptionRef) => {
      if (input.unreachable === true) return { status: 'unavailable' };
      if (input.unknownSubscription === true) return { status: 'unknown' };
      return { status: 'known', current: current(subscriptionRef) };
    };
    this.answerCancel = async (subscriptionRef) => {
      if (input.unknownSubscription === true) return { status: 'already_ended' };
      if (input.refusingCancellation === true || input.unreachable === true) {
        return { status: 'unavailable' };
      }
      return { status: 'stopping', current: { ...current(subscriptionRef), cancelAtPeriodEnd: true } };
    };
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

  async readSubscription(subscriptionRef: string): Promise<SubscriptionReading> {
    this.reads.push({ subscriptionRef });
    return this.answerRead(subscriptionRef);
  }

  async cancelSubscription(subscriptionRef: string): Promise<CancellationReading> {
    this.cancellations.push({ subscriptionRef });
    return this.answerCancel(subscriptionRef);
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