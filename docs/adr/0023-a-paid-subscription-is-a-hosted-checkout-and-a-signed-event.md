# A paid subscription is a hosted Checkout and a signed event

**Amended by [ADR-0024](0024-a-subscription-stops-at-the-end-of-the-period-already-paid-for.md)**: the "Cancellation" paragraph under *What is deliberately not here* no longer describes this repository. A Subscription now carries a state, a renewal date and a cancellation date, a second signed event ends one, and `GET /settings/billing` states and stops it. Everything else below — the hosted page, the public webhook, the raw bytes, the reference rather than the event naming the User, one event being one grant, the timestamp being checked as well as the signature, the two credentials — still holds unchanged. Read that one paragraph as the decision that was made once and then replaced, and ADR-0024 for why.

PaidTier was the product's differentiator and there was no way onto it. The upgrade page said billing was not connected and carried no form, and the only route that moved a User's tier was `POST /dev/tier` — development-only, off in production, and therefore not a way for a User to pay for anything. This records the step that was taken to change that, and why it is shaped this way.

## The shape

Three pieces, in this order:

1. **`POST /billing/checkout`** — behind the session and behind the cross-site write guard (ADR-0021, ADR-0022). It mints a **Checkout reference**, stores it against the signed-in User, asks the PaymentProvider for a hosted page, and answers 302 to it.
2. **`POST /billing/webhook`** — public, exempt from the cross-site guard, and the only route in the application that can put a User on a tier. It authorises by signature over the raw request body.
3. **`subscriptions`** — one row per User, holding the provider's own names for what is being charged for, written by the webhook so a later read never asks the provider again.

`users.tier` is set by (2) and is still the fact every paywall reads. The row in (3) is the record behind it, not a second source of truth about the tier.

**Why a hosted page rather than a card form.** A hosted checkout is the least payment code this project can own. No card number passes through this application, none is stored, there is no payment form to keep PCI-safe, and the only thing that comes back is a message saying a payment completed. The alternative — collecting cards — would have meant storing or forwarding numbers, which is a decision about a class of risk this application has no reason to take. The price appears on Brieflyy's own page as copy and in the provider as a configured price; those two are separate facts and the provider's is the one that is charged.

**Why the webhook is public.** For the same reason the magic link is: the provider is not signed in and cannot be. There is no session, no cookie and no request token in the exchange, so the signature is the whole authorisation. It is on `PUBLIC_ROUTES` and named in `WRITE_GUARD_EXEMPTIONS` with its reason, because a public route that moves a User onto the paid tier is the one place in the application where "reachable without a session" has to be a decision somebody wrote down rather than a default.

## The parts that are load-bearing

**The raw bytes.** The signature covers the exact body the provider sent. A parsed body can be re-serialised into something equal as JSON and different as a message, so verifying against a re-serialised form would be verifying something nobody signed. The route is registered in its own encapsulated scope with a JSON parser that yields the body as a string, so the application's own JSON surface keeps parsing into objects and this one keeps the bytes. Nothing in the body is read — let alone acted on — until the signature over those bytes has held.

**The reference, not the event, names the User.** `client_reference_id` carries a value Brieflyy minted and stored before it asked the provider for anything. A validly signed event about somebody else's Checkout therefore resolves to nothing this application holds. The other order — asking the provider first and storing afterwards — would leave a window in which a completed event arrives for a reference that was never recorded, and a User who has paid in that window has no way to be credited.

**One event is one grant, and that is the database's promise.** `payment_events.id` is the provider's own event identifier and the table's primary key, so a replayed event cannot be recorded twice. The service catches the failed insert and answers `replayed`, which changes nothing. The alternative — reading a flag and then writing — has a window between the two that two concurrent deliveries can both pass; the same argument the unsubscribe token already makes for being single-use.

**The timestamp is checked as well as the signature.** A signature says the provider sent this request; it does not say the request is recent, and a captured one would verify forever. A request whose own timestamp is more than five minutes from the clock is refused, in both directions, as a replay.

**Nothing but a refusal changes nothing.** A signature that does not hold is a 400 and no write of any kind. An event of a kind this application does not act on, an event naming a reference it never issued, and a replay of one already applied are all 200 with no write — they are not failures, and a 5xx for any of them would have the provider retrying for days something no retry can fix.

## What is deliberately not here

**Cancellation.** `subscriptions` has no state column. The row existing is what "this User is paying" means, so an end date nobody maintains would be a claim the database could not enforce, and a monthly period the application never reads would be a second answer to "what is this User on". A cancelled subscription is still a subscribed row, which is wrong the moment one exists, and `CONTEXT.md` says so on the entry rather than leaving it to be found.

**The development switch is still there.** `POST /dev/tier` moves a User between tiers in both directions and is still registered only when `DEV_TOOLS_ENABLED` is on. It is how the paywalls are exercised, and it is how a User is moved back down after a replay is shown not to re-upgrade them.

**Two credentials, not one.** `STRIPE_SECRET_KEY` is presented to the provider. `STRIPE_WEBHOOK_SECRET` never leaves the server and only answers whether a request came from the provider. They are separate variables because they are separate jobs, and conflating them would mean shipping the ability to forge an event to anyone who read the API key out of a log. `pnpm secrets:check` recognises both shapes, and the webhook secret is the one most likely to be missed, because it is never pasted anywhere a reader would look.