import { escapeHtml } from '../domain/html.js';
import { requestTokenInput } from '../http/request-token.js';
import { formatHumanTime } from '../pages/human-time.js';
import { layout, type ShellAccount } from '../pages/layout.js';
import type { BillingState } from './billing-service.js';
import type { Subscription } from '../domain/types.js';
import {
  BILLING_CANCEL_PATH,
  BILLING_SETTINGS_PATH,
  UPGRADE_PATH,
  type BillingStoppedAnswer,
} from './paths.js';

/**
 * The one page that says what a User is on.
 *
 * Four things and no more, because they are four different questions with four
 * different answers: which plan, when it renews, whether it is stopping, and how to
 * stop it. A subscription page that also carried the price would be a second place
 * the price is written down, and the price is written down on the upgrade page
 * where it is being sold.
 */
export function subscriptionSettingsPage(input: {
  readonly account: ShellAccount;
  readonly state: BillingState;
  /** What the last cancellation submission said, when they came from one. */
  readonly stopped: BillingStoppedAnswer | null;
  /**
   * Whether this instance can talk to a provider at all. Both the checkout and the
   * cancellation need one, so the control is offered on the same condition the
   * checkout is (ADR-0019) rather than on a rule of its own.
   */
  readonly paymentsAvailable: boolean;
  /** The User's own zone, so a date here is one they would have written. */
  readonly timezone: string;
  readonly requestToken?: string | null;
}): string {
  return layout({
    title: 'Billing',
    width: 'form',
    account: input.account,
    activeHref: BILLING_SETTINGS_PATH,
    requestToken: input.requestToken ?? null,
    body: `    <h1>Billing</h1>
${stoppedBlock(input.stopped, input.state)}${planBlock({
      state: input.state,
      paymentsAvailable: input.paymentsAvailable,
      timezone: input.timezone,
      requestToken: input.requestToken ?? null,
    })}`,
  });
}

/**
 * What a cancellation submission just did, or did not do.
 *
 * Every answer is a sentence rather than a bare status, because the caller is a
 * person who pressed a button on a page they were reading. The two that matter most
 * are opposites of each other: `stopped` says the charge has stopped, and
 * `unavailable` says nothing has changed and the charge is still coming — so neither
 * can be worded in a way that could mean the other.
 *
 * `already-stopped` covers a Subscription that had already been set to stop *and* one
 * the provider had already finished. The sentence is written for both because what
 * both mean is the same: there is no charge after the period the User had already
 * paid for.
 *
 * **Announced only when the state agrees.** The answer arrives in a query string on a
 * User's own address, so it is a value they can type rather than something only a
 * submission can produce. Announced unconditionally it would put "the next charge
 * has been stopped" over a Subscription that is still paying — a claim about money,
 * on a page that also states the plan, and the two contradicting each other. So each
 * answer is checked against the Subscription the page has just read: an answer the
 * state does not support is said nothing at all, and the state is shown on its own
 * rather than the page being emptied because somebody guessed a query value.
 */
function stoppedBlock(
  stopped: BillingStoppedAnswer | null,
  state: BillingState,
): string {
  if (stopped === null) return '';
  const status = state.kind === 'known' ? state.subscription.status : 'none';
  if (stopped === 'stopped') {
    // A `stopping` answer and an `already_stopped` one are both true only of a
    // Subscription that is no longer paying on its own. `ended` is included because
    // a provider that had already finished it is how the second arises.
    if (status !== 'cancelling' && status !== 'ended') return '';
    return `    <div class="callout callout--success" role="status">
      <p><strong>The next charge has been stopped.</strong></p>
      <p>Your paid plan runs to the end of the period you have already paid for. Nothing is being taken away in the meantime, and there is no charge after that date.</p>
    </div>
`;
  }
  if (stopped === 'already-stopped') {
    if (status !== 'cancelling' && status !== 'ended') return '';
    return `    <div class="callout" role="status">
      <p><strong>It was already set to stop.</strong></p>
      <p>There is no charge after the end of the period you had already paid for, so nothing further is going to be taken.</p>
    </div>
`;
  }
  if (stopped === 'nothing-to-stop') {
    // True only of an account with nothing on it. A paid Subscription means there
    // was something to stop, and saying otherwise over one is the same fault the
    // other way round.
    if (status !== 'none' && status !== 'ended') return '';
    return `    <div class="callout" role="status">
      <p><strong>There was nothing to stop.</strong></p>
      <p>No paid subscription is set up on this account, so nothing has been charged and nothing has changed.</p>
    </div>
`;
  }
  if (stopped === 'not-configured') {
    if (status !== 'none') return '';
    return `    <div class="callout callout--paywall" role="alert">
      <p><strong>This instance has no payment provider set up.</strong></p>
      <p>There is nothing here to cancel, and nothing has been charged.</p>
    </div>
`;
  }
  // `unavailable`, and the sentence has to be the one that leaves nothing in doubt:
  // the provider will go on charging, so the User has to know it is still going to.
  // Not gated on the status, because it claims nothing happened and a Subscription
  // that is still paying is exactly what it describes.
  return `    <div class="callout callout--paywall" role="alert">
    <p><strong>We could not reach the payment provider.</strong></p>
    <p>Your subscription has not been changed and will keep charging as it is. Try again in a moment.</p>
  </div>
`;
}

/**
 * What the plan, the renewal, the status, and the control that stops it, all derived
 * from one input.
 *
 * Everything below the headline is derived from the page's own reading of the
 * Subscription rather than the shell's. Passed whole through the blocks that need it,
 * so the date, the zone and the token in a form are the ones the page was given.
 */
interface PlanInput {
  readonly state: BillingState;
  readonly paymentsAvailable: boolean;
  readonly timezone: string;
  readonly requestToken: string | null;
}

/**
 * The plan, its renewal, its status, and the control that stops it.
 *
 * Every sentence here is derived from the Subscription and nothing else — not from
 * `users.tier`, which is what the header beside it already says. Two sources for one
 * page's headline is how a page ends up saying "Free plan" above "Next charge on…",
 * and the Subscription is the thing this page is about.
 *
 * The first branch is the arrival most Users make, and it is a whole page rather
 * than an absence: a User with no subscription is told what they have and pointed
 * at the one page that changes it. That is the difference between a page that
 * answers and a page that failed to find something.
 */
function planBlock(input: PlanInput): string {
  if (input.state.kind === 'none') {
    return `    <p><strong>You are on the free plan.</strong></p>
    <p>There is no paid subscription on this account, so there is nothing to renew and nothing to cancel here.</p>
    ${upgradeLink()}
`;
  }

  const { subscription } = input.state;
  const since = `Subscribed ${escapeHtml(formatHumanTime(subscription.startedAt, input.timezone))} (${escapeHtml(input.timezone)})`;
  if (subscription.status === 'ended') {
    // Not an error and not a complaint: this is where a cancelled subscription
    // arrives, and saying what it means is more use than saying there is nothing.
    //
    // What this page does *not* say is which tier the account is on. It read the
    // Subscription, and the Subscription is not the tier: the tier moves on the
    // provider's signed event and this read deliberately does not move it (ADR-0024).
    // A page that asserted "you are on the free plan" while the header above it —
    // which reads `users.tier` — said "Paid plan" would be the two disagreeing inside
    // one viewport. What is true from here alone is that the Subscription is over.
    return `    <p><strong>Your paid plan has ended.</strong></p>
    <p>There is no charge, and nothing is being taken from this account.</p>
    <p class="muted">${since}.</p>
    ${upgradeLink()}
`;
  }

  // The renewal date is the one thing on this page this application cannot work
  // out for itself, so an unknown one is said as an absence rather than dressed up
  // as a date: "Next charge on the renewal date is not known" is a sentence about
  // something that has not been established. Which absence it is depends on where the
  // answer came from, because the two are opposites and only one of them is a fault
  // — see `renewalSentence`.
  const renewal =
    subscription.renewsAt === null
      ? null
      : `${escapeHtml(formatHumanTime(subscription.renewsAt, input.timezone))} (${escapeHtml(input.timezone)})`;

  if (subscription.status === 'cancelling') {
    const asked =
      subscription.cancelledAt === null
        ? ''
        : ` You asked on ${escapeHtml(formatHumanTime(subscription.cancelledAt, input.timezone))} (${escapeHtml(input.timezone)}).`;
    return `    <p><strong>Cancelled — your paid plan runs until ${renewal ?? 'the end of the period you have already paid for'}.</strong></p>
    <p>${asked} There is no charge after that date. Everything the paid plan includes keeps working until then, and none of it has been taken away.</p>
    <p class="muted">${since}.</p>
    ${upgradeLink('Go back to paid')}
`;
  }

  return `    <p><strong>You are on the paid plan.</strong></p>
${renewalSentence(subscription, input.state.freshness, input.timezone)}    <p class="muted">${since}.</p>
${cancelBlock(input)}${freshnessNote(input.state.freshness)}`;
}

/**
 * When the next charge falls, or why this page cannot say.
 *
 * Three sentences rather than one, and the middle is the whole reason there are
 * three: `recorded` means nobody asked, because this application already knew;
 * `unreachable` means it asked and nobody answered, which is somebody else's service
 * being down; and `asked` means the provider answered and named no date at all.
 *
 * Collapsing the last two would put "we could not reach the payment provider" above
 * a read that reached it and was answered — an apology for a fault that did not
 * happen, next to a User who is owed a fact rather than an excuse.
 *
 * The Subscription, the freshness and the zone are passed as the facts themselves
 * rather than the whole `PlanInput`, so the sentence cannot be reached for a state
 * that has no Subscription to read a date from.
 */
function renewalSentence(
  subscription: Subscription,
  freshness: 'asked' | 'recorded' | 'unreachable',
  timezone: string,
): string {
  if (subscription.renewsAt !== null) {
    return `    <p>Next charge on ${escapeHtml(formatHumanTime(subscription.renewsAt, timezone))} (${escapeHtml(timezone)}).</p>\n`;
  }
  return freshness === 'recorded'
    ? `    <p>The renewal date has not been established for this subscription.</p>\n`
    : freshness === 'asked'
      ? `    <p>The payment provider has not given us a renewal date for this subscription, so when the next charge falls is not something we can tell you.</p>\n`
      : `    <p>This deployment has not been able to ask the payment provider when your next charge falls.</p>\n`;
}

/**
 * The control that stops the next charge, and what cancelling will and will not do.
 *
 * Rendered only for a Subscription that is actually paying on an instance that can
 * reach a provider: a control that could not work is worse than no control, which
 * is the rule the Google sign-in button and the checkout both follow (ADR-0019). The
 * whole input is passed rather than three of its fields so the condition cannot be
 * answered from somewhere other than the one the page already decided it.
 */
function cancelBlock(input: PlanInput): string {
  if (!input.paymentsAvailable) {
    return `    <div class="callout callout--paywall">
      <p><strong>This instance has no payment provider set up.</strong></p>
      <p>There is nothing here that could stop the next charge, so there is no button to press.</p>
    </div>
`;
  }
  // The date is in the same sentence as the promise, because a cancellation that
  // does not say when the User keeps what they have paid for is a cancellation they
  // have to take on trust.
  const kept =
    input.state.kind === 'known' && input.state.subscription.renewsAt !== null
      ? `You keep the paid plan until ${escapeHtml(formatHumanTime(input.state.subscription.renewsAt, input.timezone))} (${escapeHtml(input.timezone)}), and there is no charge after that date.`
      : 'You keep the paid plan until the end of the period you have already paid for.';
  // The request token is what makes this a Brieflyy submission rather than
  // something a page elsewhere caused (ADR-0021), so the form carries the same
  // hidden field every other form on every other page carries.
  return `    <form method="post" action="${BILLING_CANCEL_PATH}">
      ${requestTokenInput(input.requestToken ?? '')}
      <button class="button" type="submit">Cancel my subscription</button>
    </form>
    <p class="muted">${kept} Nothing is taken away before then.</p>
`;
}

/**
 * Said when the provider could not be asked, because the state on the page is then
 * what was last recorded rather than what is true now.
 *
 * Only for `unreachable`, and the distinction is the whole point of the three-way
 * freshness: a page that had no reason to ask the provider has nothing to apologise
 * for, and a page that did ask and got no answer has to say so rather than let a
 * User read a stored date as a fresh one.
 */
function freshnessNote(freshness: 'asked' | 'recorded' | 'unreachable'): string {
  if (freshness !== 'unreachable') return '';
  return `    <p class="muted">The payment provider could not be reached just now, so this is what we last recorded.</p>
`;
}

/**
 * The way to paid, from the page that is not selling it.
 *
 * A cancelled User reading "your plan has ended" needs somewhere to go next, and
 * the sentence above them is not a control.
 */
function upgradeLink(label = 'Upgrade to paid'): string {
  return `    <p class="actions"><a class="button" href="${UPGRADE_PATH}">${escapeHtml(label)}</a></p>
`;
}