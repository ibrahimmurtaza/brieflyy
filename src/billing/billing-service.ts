import type { Clock } from '../domain/clock.js';
import type { RandomSource } from '../domain/crypto.js';
import type { PaymentEvent, PaymentProvider, SignedRequest } from '../domain/payment.js';
import type { Account, PaymentEventKind, Subscription, User } from '../domain/types.js';
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
  | { readonly status: 'accepted'; readonly kind: PaymentEventKind; readonly userId: User['id'] }
  | { readonly status: 'replayed'; readonly eventId: string }
  | { readonly status: 'unsigned' }
  | { readonly status: 'unrecognised' }
  | { readonly status: 'unknown_checkout'; readonly reference: string }
  | { readonly status: 'unknown_subscription'; readonly subscriptionRef: string }
  | { readonly status: 'not_configured' };

/**
 * What a User's billing state is, as the one surface that states it reads it.
 *
 * Two answers rather than a Subscription or nothing, because "no subscription" is
 * the state nearly every User is in and it is an answer rather than a failure: a
 * User who has never paid arrives at this page and is told what they have, not shown
 * an error for having no row.
 *
 * `freshness` is what lets the page be honest about where the state came from, and
 * it has three values rather than two because the third is not the same as either
 * of the others. `asked` is a fact somebody else has just confirmed; `recorded` is
 * what this application stored and has no reason to doubt; `unreachable` is a
 * provider that would not answer, which is the only one of the three a page has to
 * apologise for.
 */
export type BillingState =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'known';
      readonly subscription: Subscription;
      readonly freshness: 'asked' | 'recorded' | 'unreachable';
    };

/**
 * What asking for the next charge to stop came back with.
 *
 * `already_stopped` is a success rather than a refusal: the User asked for something
 * that is already true, and telling them so is better than asking the provider a
 * second time for an answer that cannot differ. It covers both a Subscription that
 * has already been asked to stop and one the provider has already finished — a User
 * who pressed the button late is owed the same reassurance as one who pressed it
 * early.
 *
 * `nothing_to_stop` is a User who was never paying, which is the state nearly
 * everyone without a subscription is in and the reason the control is not offered to
 * them at all.
 */
export type CancellationOutcome =
  | { readonly status: 'stopping'; readonly endsAt: Date | null }
  | { readonly status: 'already_stopped'; readonly endsAt: Date | null }
  | { readonly status: 'nothing_to_stop' }
  | { readonly status: 'not_configured' }
  | { readonly status: 'unavailable' };

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
   * Two kinds of event and two sets of writes, behind one door. Neither is acted on
   * outside this method, because there is nothing about either that a signed event
   * is not the prerequisite for.
   */
  private async apply(event: PaymentEvent): Promise<PaymentEventOutcome> {
    return event.kind === 'subscription_ended'
      ? this.endSubscription(event)
      : this.grantPaidTier(event);
  }

  /**
   * Move a User onto the paid tier because a Checkout they started completed.
   *
   * Nothing is read out of the body here — the provider has decided what it
   * carries. The User comes from the reference Brieflyy minted and never from the
   * event, so a validly signed event about somebody else's Checkout has nothing to
   * say about who that is.
   *
   * There is no separate answer for a User who has since been deleted, because
   * there cannot be one: `checkout_references.user_id` cascades, so a reference
   * whose User has gone is not a reference this application still holds. An
   * unresolvable event is unresolvable either way.
   */
  private async grantPaidTier(
    event: Extract<PaymentEvent, { kind: 'checkout_completed' }>,
  ): Promise<PaymentEventOutcome> {
    const checkout = await this.deps.repo.findCheckoutReference(event.reference);
    if (checkout === null) {
      return { status: 'unknown_checkout', reference: event.reference };
    }

    const providerName = this.deps.provider?.providerName ?? 'unknown';
    const subscription: Subscription = {
      // Minted before the row is written, and reused whether the write lands or the
      // event turns out to be a replay's twin: a User has one Subscription and the
      // unique index on them is what says so.
      id: this.deps.random.uuid(),
      userId: checkout.userId,
      provider: providerName,
      subscriptionRef: event.subscriptionRef,
      customerRef: event.customerRef,
      startedAt: this.deps.clock.now(),
      // A Checkout that has just completed is paying and has been asked for
      // nothing. Whatever period it replaces — a cancellation included — belongs to
      // a subscription this User no longer has, and carrying it forward would tell
      // the page they had asked to stop the one they just paid for.
      status: 'active',
      // Left null until somebody asks the provider: a month worked out from
      // `startedAt` here would be this application's guess printed as the
      // provider's date (ADR-0024).
      renewsAt: null,
      cancelledAt: null,
    };

    return this.applyOnce(event, checkout.userId, async () => {
      await this.deps.userRepo.setTier(checkout.userId, 'paid');
      await this.deps.repo.saveSubscription(subscription);
    });
  }

  /**
   * Move a User back down because the provider says their Subscription has stopped.
   *
   * Resolved by the provider's own name for the Subscription rather than by the
   * User, because such an event carries no Checkout reference: the Checkout that
   * started it was completed months ago, and the reference it was minted for says
   * nothing about a later cancellation.
   *
   * A Subscription this application does not hold is refused rather than applied to
   * whoever it does name, and that is also the answer for one a User has replaced
   * with a newer Checkout: an old subscription ending must not take a User down who
   * has paid again since.
   */
  private async endSubscription(
    event: Extract<PaymentEvent, { kind: 'subscription_ended' }>,
  ): Promise<PaymentEventOutcome> {
    const subscription = await this.deps.repo.findSubscriptionByProviderRef(
      event.subscriptionRef,
    );
    if (subscription === null) {
      return { status: 'unknown_subscription', subscriptionRef: event.subscriptionRef };
    }

    const userId = subscription.userId;
    return this.applyOnce(event, userId, async () => {
      await this.deps.userRepo.setTier(userId, 'free');
      // `cancelledAt` is left as it was: it records when the User asked, which is a
      // different moment from when the provider says the asking is finished, and
      // the page shows both.
      await this.deps.repo.saveSubscription({ ...subscription, status: 'ended' });
    });
  }

  /**
   * Read the event, refuse a delivery that has been acted on, then run the effect
   * and record the event that asked for it.
   *
   * In that order, and for the same reason `UnsubscribeService` writes the opt-out
   * before the receipt: the effect comes first and the record that it happened comes
   * last. A failure between them then leaves the change unapplied and the event
   * unrecorded, which the provider's next delivery can still apply — the reverse
   * order would mark an event spent for a change that never happened, and the retry
   * would be answered as a replay.
   *
   * The read before the write is what stands between a replay and a second
   * delivery of the same grant, and the catch after it is what handles the case the
   * read cannot: two deliveries landing at once, both of which found no row. Both
   * have by then written the same thing, so nothing is left to undo.
   */
  private async applyOnce(
    event: PaymentEvent,
    userId: User['id'],
    effect: () => Promise<void>,
  ): Promise<PaymentEventOutcome> {
    if ((await this.deps.repo.findPaymentEvent(event.id)) !== null) {
      return { status: 'replayed', eventId: event.id };
    }
    const now = this.deps.clock.now();
    await effect();
    try {
      await this.deps.repo.insertPaymentEvent({
        id: event.id,
        userId,
        kind: event.kind,
        receivedAt: now,
      });
    } catch (err) {
      if ((await this.deps.repo.findPaymentEvent(event.id)) !== null) {
        return { status: 'replayed', eventId: event.id };
      }
      throw err;
    }
    return { status: 'accepted', kind: event.kind, userId };
  }

  /**
   * What a User is paying for, read from what this application stored rather than
   * by asking the provider again — which is the whole reason the row exists.
   */
  subscriptionFor(userId: User['id']): Promise<Subscription | null> {
    return this.deps.repo.findSubscriptionForUser(userId);
  }

  /**
   * What the one billing surface states: the Subscription a User holds and where it
   * is in its life, or the honest answer that they hold none.
   *
   * **The provider is asked only when this application cannot already answer.** A
   * stored renewal date is the end of the period paid for, so while it is still in
   * the future it *is* the next charge and there is nothing to ask about. Once it
   * has passed the period has rolled over, the stored date cannot be the next
   * charge, and only the provider knows where it moved to — so that is when it is
   * asked, and what it says is written down.
   *
   * That rule is what keeps ADR-0023's promise intact: a read of this page is a
   * read of the database, and it reaches a third party at most once per period per
   * User rather than once per visit. It is also why `renewsAt` is a column rather
   * than something derived — the answer is held, not recomputed on every request.
   *
   * A provider that cannot be reached leaves the stored row exactly as it was and
   * says so in the answer. Overwriting it with a guess would be worse than a stale
   * date: it would be a wrong one presented as current.
   *
   * The write below is the only state change a `GET` in this application makes, and
   * it is written down rather than left to memory because the alternative is a row
   * that has drifted out of date and a provider asked again on every visit. It is
   * the answer to "what is this Subscription now", moved from a page into the record
   * every other read comes from — not a decision, which is why it cannot touch the
   * tier (ADR-0024).
   *
   * The tier is never written here. A User's plan moves on the provider's signed
   * event and nowhere else, because a page somebody is looking at must not be the
   * thing that takes their plan away — what happens to a User over the FreeTier cap
   * when it does is a decision, not a side effect of looking at a page (ADR-0024).
   */
  async subscriptionStateFor(user: User): Promise<BillingState> {
    const stored = await this.deps.repo.findSubscriptionForUser(user.id);
    if (stored === null) return { kind: 'none' };

    const provider = this.deps.provider;
    if (provider === undefined) {
      return { kind: 'known', subscription: stored, freshness: 'recorded' };
    }
    // The stored date answers the question while it is still ahead of the clock.
    // `startedAt` is deliberately not consulted: a month worked out from it here
    // would be this application's guess at the very number the provider owns.
    if (stored.renewsAt !== null && stored.renewsAt.getTime() > this.deps.clock.now().getTime()) {
      return { kind: 'known', subscription: stored, freshness: 'recorded' };
    }

    const reading = await provider.readSubscription(stored.subscriptionRef);
    if (reading.status === 'unavailable') {
      return { kind: 'known', subscription: stored, freshness: 'unreachable' };
    }
    const refreshed: Subscription =
      reading.status === 'unknown'
        ? // The provider holds no such Subscription, so it is over. The one case a
          // read changes the stored state, and it changes it to a fact the provider
          // reported rather than to an inference.
          { ...stored, status: 'ended' }
        : {
            ...stored,
            // Read both ways from the provider rather than only forwards: a User who
            // un-cancels at the provider has told it to charge again, and a page
            // still saying "no charge after that date" would be understating what is
            // about to leave the User's account.
            status: reading.current.cancelAtPeriodEnd ? 'cancelling' : 'active',
            renewsAt: reading.current.renewsAt ?? stored.renewsAt,
            customerRef: reading.current.customerRef ?? stored.customerRef,
          };
    await this.deps.repo.saveSubscription(refreshed);
    return { kind: 'known', subscription: refreshed, freshness: 'asked' };
  }

  /**
   * Ask the provider to stop the next charge, and record that it was asked.
   *
   * The provider is asked first and the row is written only if it said yes. The
   * other order would leave a Subscription recorded as stopping while the provider
   * went on charging — which is the exact failure this exists to remove: a
   * cancellation that records an intention somewhere and stops nothing.
   *
   * Nothing about the tier changes. The User has paid for the rest of the period,
   * so their plan runs to the end of it, and the provider's event saying the
   * Subscription has ended is what moves them down afterwards.
   */
  async cancelSubscription(user: User): Promise<CancellationOutcome> {
    const stored = await this.deps.repo.findSubscriptionForUser(user.id);
    if (stored === null || stored.status === 'ended') return { status: 'nothing_to_stop' };

    const provider = this.deps.provider;
    if (provider === undefined) return { status: 'not_configured' };

    if (stored.status === 'cancelling') {
      return { status: 'already_stopped', endsAt: stored.renewsAt };
    }

    const reading = await provider.cancelSubscription(stored.subscriptionRef);
    if (reading.status === 'unavailable') return { status: 'unavailable' };
    // What the provider reported about the Subscription itself, where it reported
    // one. A provider that says it no longer holds it reported nothing about the
    // period, so the stored dates stand rather than being replaced by blanks.
    const current = reading.status === 'stopping' ? reading.current : null;

    await this.deps.repo.saveSubscription({
      ...stored,
      status: current === null ? 'ended' : 'cancelling',
      cancelledAt: this.deps.clock.now(),
      renewsAt: current?.renewsAt ?? stored.renewsAt,
      customerRef: current?.customerRef ?? stored.customerRef,
    });
    // The provider saying it is not charging any more is exactly what the User
    // pressed the button for, so it is reported as the answer they asked for rather
    // than as a failure — even though the period behind it is already over.
    return {
      status: current === null ? 'already_stopped' : 'stopping',
      endsAt: current?.renewsAt ?? stored.renewsAt,
    };
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