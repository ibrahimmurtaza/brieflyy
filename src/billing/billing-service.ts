import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import type { PaymentEvent, PaymentProvider, SignedRequest } from '../domain/payment.js';
import type { Account, Subscription, User } from '../domain/types.js';
import type { BillingRepo } from '../repos/billing-repo.js';
import type { UserRepo } from '../repos/user-repo.js';
import {
  CHECKOUT_CANCELLED_QUERY,
  CHECKOUT_RETURNED_QUERY,
  UPGRADE_PATH,
} from './paths.js';

export interface BillingServiceDeps {
  readonly repo: BillingRepo;
  readonly userRepo: UserRepo;
  /**
   * Absent rather than a provider that fails, for the reason the written-summary
   * client is: whether this deployment can take money is a question about the
   * deployment, and it is answered once here rather than once per checkout.
   *
   * It is also what lets the routes exist either way — the same shape ADR-0019
   * settled for Google, where an instance with no Provider offers no button and
   * the routes behind it refuse rather than throw.
   */
  readonly provider: PaymentProvider | undefined;
  readonly appBaseUrl: string;
  readonly clock: Clock;
  readonly random: RandomSource;
}

/** Why a Checkout could not be started. Both answered with a page, not a 500. */
export type CheckoutRefusal = 'not_configured' | 'unavailable';

export type StartCheckoutOutcome =
  | { readonly status: 'started'; readonly url: string }
  | { readonly status: 'refused'; readonly reason: CheckoutRefusal };

/**
 * What happened to a signed event.
 *
 * `accepted` and `replayed` are both successes as far as the provider is
 * concerned — a replay means the first delivery did its work — so they are the two
 * answers that change nothing about what a User gets. The rest are the events this
 * application cannot act on, and every one of them leaves the User exactly where
 * they were.
 */
export type PaymentEventOutcome =
  | { readonly status: 'accepted'; readonly userId: User['id'] }
  | { readonly status: 'replayed'; readonly eventId: string }
  | { readonly status: 'unsigned' }
  | { readonly status: 'unrecognised' }
  | { readonly status: 'unknown_checkout'; readonly reference: string }
  | { readonly status: 'not_configured' };

export class BillingService {
  constructor(private readonly deps: BillingServiceDeps) {}

  /**
   * Whether this instance can take a payment at all.
   *
   * One answer, asked by the upgrade page and by the checkout route, so the button
   * and the route behind it cannot disagree — the same argument as
   * `AuthService.googleSignInAvailable()`.
   */
  checkoutAvailable(): boolean {
    return this.deps.provider !== undefined;
  }

  /**
   * Which header a signed event's signature arrives in.
   *
   * Asked of the provider rather than imported from it, so the route reads a
   * header the provider named instead of one this layer was told about.
   */
  signatureHeader(): string {
    return this.deps.provider?.signatureHeader ?? '';
  }

  /**
   * Start a Checkout for a signed-in User, and hand back the hosted page to send
   * them to.
   *
   * The reference is minted and stored *before* the provider is asked, so a
   * completed Checkout always names something Brieflyy issued. The other order
   * would leave a window where a completed event arrives for a reference that was
   * never recorded and is therefore unresolvable — the User has paid and there is
   * no way to put it in their account.
   */
  async startCheckout(user: User, account: Account): Promise<StartCheckoutOutcome> {
    const provider = this.deps.provider;
    if (provider === undefined) return { status: 'refused', reason: 'not_configured' };

    const reference = this.deps.random.uuid();
    await this.deps.repo.insertCheckoutReference({
      reference,
      userId: user.id,
      createdAt: this.deps.clock.now(),
    });

    try {
      const checkout = await provider.startCheckout({
        userId: user.id,
        email: account.email,
        reference,
        successUrl: this.returnUrl(CHECKOUT_RETURNED_QUERY),
        cancelUrl: this.returnUrl(CHECKOUT_CANCELLED_QUERY),
      });
      return { status: 'started', url: checkout.url };
    } catch {
      // Somebody else's service, so a failure here is a fact about them rather
      // than about this User, and the reference row is left behind: it says a
      // Checkout was started, which is true, and a later event naming it is still
      // honoured rather than refused as a reference Brieflyy never issued.
      return { status: 'refused', reason: 'unavailable' };
    }
  }

  /**
   * Read a signed request and act on it. The only way in.
   *
   * Both halves in one method because they are one decision: the signature is
   * what authorises the event, and a caller that could read one without the other
   * would be a caller that could act on an event nobody signed. That is also why
   * the method the event is handed to is not public — a route that could call it
   * directly could move a User onto the paid tier without anything having verified
   * anything.
   */
  async applySignedRequest(signed: SignedRequest): Promise<PaymentEventOutcome> {
    const provider = this.deps.provider;
    if (provider === undefined) return { status: 'not_configured' };
    const reading = provider.readEvent(signed);
    return reading.status === 'verified'
      ? this.apply(reading.event)
      : { status: reading.status };
  }

  /**
   * Act on an event the provider's own check has already accepted.
   *
   * Nothing is read out of the body here — the provider has decided what it
   * carries. The User comes from the reference Brieflyy minted and never from the
   * event, so a validly signed event about somebody else's Checkout has nothing to
   * say about who that is.
   *
   * The three writes are in this order for a reason, and it is the same reason
   * `UnsubscribeService` writes the opt-out before the receipt: the effect comes
   * first and the record that it happened comes last. A failure between them then
   * leaves the payment unapplied and the event unrecorded, which the provider's
   * next delivery can still apply — the reverse order would mark a payment spent
   * for a User who never got the tier, and the retry would be answered as a
   * replay. Every write here is idempotent given the same event, which is what
   * makes being applied twice by a retry harmless.
   *
   * There is no separate answer for a User who has since been deleted, because
   * there cannot be one: `checkout_references.user_id` cascades, so a reference
   * whose User has gone is not a reference this application still holds. An
   * unresolvable event is unresolvable either way.
   */
  private async apply(event: PaymentEvent): Promise<PaymentEventOutcome> {
    const checkout = await this.deps.repo.findCheckoutReference(event.reference);
    if (checkout === null) {
      return { status: 'unknown_checkout', reference: event.reference };
    }
    const userId = checkout.userId;
    const now = this.deps.clock.now();

    // Read before writing, because the read is the only thing standing between a
    // replay and a second delivery of the same grant.
    if ((await this.deps.repo.findPaymentEvent(event.id)) !== null) {
      return { status: 'replayed', eventId: event.id };
    }

    await this.deps.userRepo.setTier(userId, 'paid');
    await this.deps.repo.saveSubscription({
      id: this.deps.random.uuid(),
      userId,
      provider: this.deps.provider?.providerName ?? 'unknown',
      subscriptionRef: event.subscriptionRef,
      customerRef: event.customerRef,
      startedAt: now,
    });
    try {
      await this.deps.repo.insertPaymentEvent({
        id: event.id,
        userId,
        kind: event.kind,
        receivedAt: now,
      });
    } catch (err) {
      // The primary key on the event id is what makes one event one grant. This
      // catches the case the read cannot: two deliveries of the same event landing
      // at once, both of which found no row. Both have by now written the same
      // tier and the same single Subscription, so nothing is left to undo.
      if ((await this.deps.repo.findPaymentEvent(event.id)) !== null) {
        return { status: 'replayed', eventId: event.id };
      }
      throw err;
    }
    return { status: 'accepted', userId };
  }

  /**
   * What a User is paying for, read from what this application stored rather than
   * by asking the provider again — which is the whole reason the row exists.
   */
  subscriptionFor(userId: User['id']): Promise<Subscription | null> {
    return this.deps.repo.findSubscriptionForUser(userId);
  }

  /**
   * Where the provider sends a User back to. Built from `appBaseUrl` rather than
   * from the request, so the address handed to a third party is the one the
   * deployment declared rather than whatever a header claimed.
   */
  private returnUrl(query: string): string {
    return `${this.deps.appBaseUrl}${UPGRADE_PATH}?${query}`;
  }
}