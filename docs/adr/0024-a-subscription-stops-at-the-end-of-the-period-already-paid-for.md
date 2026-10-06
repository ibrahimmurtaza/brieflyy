# A subscription stops at the end of the period already paid for

A Subscription could be started and nothing could stop it. `POST /billing/checkout`
took a payment and the provider said so, `users.tier` went to `paid`, and from then
on the only way back down was `POST /dev/tier` — development-only and off in
production. A User who wanted out had to find the provider's own site and cancel
there, and brieflyy's copy about it ("you can cancel there") was true only in the
sense that the hosted checkout page happened to have a button.

This records the step that changed that, and why it is shaped this way.

## The shape

One surface, one write, one more event:

1. **`GET /settings/billing`** — the **Subscription settings**. It states the plan,
   the renewal date and the status, and it offers a cancellation.
2. **`POST /settings/billing/cancel`** — behind the session and behind the
   cross-site write guard (ADR-0021, ADR-0022). It asks the PaymentProvider to stop
   the Subscription and records what the provider then held.
3. **`customer.subscription.deleted`** — the second **Payment event** the webhook
   acts on. It is what moves a User back down, once the period they paid for is up.

`subscriptions` gains `status`, `renews_at` and `cancelled_at`. A row is never
deleted: a subscription that has ended is the record of what the User was paying for
and until when, and deleting it would leave them indistinguishable from one who
never subscribed.

## The parts that are load-bearing

**A cancellation is not a flag.** The write asks the provider, and the row is
written only if the provider said yes. The other order would leave a Subscription
recorded as stopping while the provider went on charging it — which is the exact
failure this exists to remove, and it is the one a User cannot see: the application
would agree with itself and disagree with the invoice.

**It stops the next charge, not the current period.** The provider is asked to
cancel *at period end*. A cancellation that cut the period short would be a
different promise from the one the page beside it makes, and the seam's doc comment
says so where an implementation of it would be written. So the tier does not move
when the User presses the button: they have paid for the rest of the month and
everything the paid plan includes keeps working until it is up. The Subscription is
`cancelling`, and the page says so in a sentence with the date in it.

**The date is the provider's, and it is written down.** A month is not always thirty
days, so `renewsAt` is read from the provider rather than derived from `startedAt`;
a date this application worked out itself would be an invention printed as though
somebody had said it. It is null until somebody asks, which is the honest answer
for a row whose provider has never been consulted.

**The provider is asked only when this application cannot already answer.** A stored
renewal date is the end of the period paid for, so while it is still in the future it
*is* the next charge and there is nothing to ask about. Once it has passed, the
period has rolled over, the stored date cannot be the next charge, and only the
provider knows where it moved to — so that is when it is asked, and what it says is
written down in place of the one that has expired.

This is the load-bearing part of the read, because the alternative — asking on every
visit — breaks ADR-0023's promise that reading what a User is paying for is a read of
the database. With this rule the provider is reached at most once per period per User
rather than once per page view, and `renews_at` is a column rather than something
derived because the answer is held, not recomputed per request.

A Subscription that has **ended** is the one case never asked about at all, and it is
separate because its renewal date says nothing: it is either null or the date the
period ran out on, so neither rule above has anything to work with. What does answer
is the status itself — an ended Subscription has no next charge and the provider will
not hold it again, so there is nothing left to learn. A `cancelling` Subscription is
asked about, and the difference is the whole of it: `ended` is a fact and `cancelling`
is a promise about a date, and the signed event that settles a promise can be missed.
That read is the recovery.

Without the first of those two rules the promise above is false in the one case a User
is most likely to keep returning to. An ended Subscription carries a renewal date in
the past, so the "asked once per period" rule would ask again on every page view, for
as long as the User kept an account — and worse, write the row back each time. Which is
also why this is written down here rather than left to the code to imply: a rule that
holds for `active` and quietly fails for `ended` is a rule with a hole in it the shape
of the most common Subscription in a mature deployment.

This is one of the two state changes a `GET` makes in this application — the other
being the Trends rollup, which measures a Topic added since the hourly job last passed
once on its first read (CONTEXT.md, *Trends rollup*). It is written down rather than
left in memory because the alternative is a row that has drifted out of date and a
provider asked again on every visit. It is an answer to "what is this Subscription now",
moved from a page into the record every other read comes from — not a decision, which
is why it cannot touch the tier. ADR-0022's gap is the other kind of `GET` write: one
whose effect a reader could not predict. This one's is a copy of what somebody else has
already said.

A provider that cannot be reached leaves the row exactly as it was. Overwriting it
with a guess would be worse than a stale date: it would be a wrong one presented as
current. The answer carries *why* it is what it is — `asked`, `recorded` or
`unreachable` — because "we did not need to ask" and "we asked and got no answer" are
different sentences and only the second is an apology.

A provider that holds no such Subscription is a different answer again, not a
failure: it is the fact that ends a cancelled one, and collapsing it with
`unavailable` would make a failed request look like a finished subscription. That
distinction matters most in `cancelSubscription`, where the two sentences a User can
be shown are exact opposites — "the next charge has been stopped" against "nothing
has been changed and it will keep charging" — so a Subscription the provider has
already dropped is reported as already stopped, never as unreachable.

**The tier moves on the event and nowhere else.** Not on the page read, and not on
the cancellation. A page somebody is looking at must not be the thing that takes
their plan away — and what happens to a User who is over the FreeTier cap when it
does is a decision, not a side effect of opening a page. That decision is not made
yet, and nothing is removed in the meantime: the cap is simply the next refusal
they meet.

**An ending names the Subscription, not a User.** `customer.subscription.deleted`
carries no Checkout reference — the Checkout was completed months ago, and the
reference it was minted for says nothing about a later cancellation. So the User
comes from the provider's own name for the Subscription, which is stored for exactly
this. A Subscription this application does not hold is acknowledged and dropped,
which is also the answer for one a User has since replaced with a newer Checkout:
an old subscription ending must not take down somebody who has paid again.

**The two events share one door.** `BillingService.applySignedRequest` is still the
only way an event reaches anything, and both kinds are acted on by private methods
behind it, in the same order — the effect, then the Subscription, then the record
that it happened — so a crash between them leaves the event unapplied and the
provider's next delivery can still apply it.

**One control, on one condition.** The cancellation is offered for a Subscription
that is actually paying, on an instance that has a PaymentProvider. An instance with
none says so and offers nothing, the same rule the checkout and the Google button
follow (ADR-0019): a control that could not work is worse than a sentence saying why.
A stored Subscription on an instance that has since lost its Stripe configuration is
exactly that case, and the page still states the Subscription — it is still what
happened — while offering nothing on its behalf.

## What is deliberately not here

**Un-cancelling.** Nothing here puts a User back onto a Subscription they have asked
to stop. A User who changes their mind checks out again, which mints a new
Subscription and replaces the row. Both are honest, and the second is the one that
also takes a payment.

**Choosing which Topics survive a downgrade.** A User on the paid tier may hold
more Topics than the FreeTier cap allows. Cancelling does not remove any of them, and
the page says so in the sentence where the date is. Which Topics stop being emailed
and which keep working is the product decision, and it belongs where it can be
stated before anything happens.

**The provider's own dashboard.** Brieflyy states what it has been told and offers
what it can do. It does not attempt to mirror a provider's whole billing surface,
and a second place to read the same numbers is one more to disagree with this one.