# A bent DeliverySlot is claimed before the send

[ADR-0011](0011-briefs-are-answered-per-delivery-slot.md) wrote the `BriefRun`
once the transport had taken the message, and its reasoning was sound: a row
written for a send that failed would mark a period as dealt with that nobody was
ever sent anything for, and the User would never be retried. This replaces the
ordering, not the reasoning — it keeps the retry and closes the gap the reasoning
did not cover.

## The window the ordering leaves open

The three writes that make a DeliverySlot answered are the snapshot, the
transport call and the run, and in that order the run was last. Between the
transport accepting a message and the run being written, a pass can be gone: a
deploy, an OOM kill, a laptop lid. Nothing about that is exotic, and the two
builds before this one shipped it.

What the next pass then does is the damage. It reads the slot as unanswered,
because the row that would say otherwise is not there. It plans, renders and
sends the same reading again. The User gets the same brief twice, on the same
morning, for the same period — and because the second pass *does* write its run,
the duplicate is not merely unrecorded, it is recorded as though it were the
first delivery of the period.

The unique index on `(user, topic, scheduled_for)` never helped here, which is
the part worth stating plainly. It is a backstop for two passes *racing*, and it
settles the race by refusing the second write — which is the second write, after
the second email. It protects the row. It cannot protect the User's inbox, which
is what the write was going to be evidence of.

## What is written, and when

The run is the **claim on the DeliverySlot**, not the receipt for a send, and it
goes in before the transport is asked:

| Step | Written | If the process dies here |
| --- | --- | --- |
| 1 | The BriefSnapshot | A brief was rendered and nobody received it. The slot is still owed and the next pass sends it again, under a fresh snapshot. |
| 2 | The BriefRun, with no `sent_at` | The slot is claimed. The message may or may not be in an inbox; nobody can tell, so it is not offered again. |
| 3 | The transport call | Same as 2 — the claim is what survives, which is the whole point. |
| 4 | The EmailDelivery, saying its **DeliveryOutcome** | Same as 2. |
| 5 | The `sent_at` on the claim | Same as 2. The brief went out and the row says "no send time", which reads as unsettled rather than as sent. |

The move is worth nothing if the claim is written at 2 and the rest of the writes
stay where they were — the ordering only closes the window because the claim is
the *only* thing that has to survive, so it goes first and everything else is
best-effort after it.

The read before the claim stays. Every pass after the one that answered a slot
would otherwise plan and render a brief — and spend its write calls — before
finding out there was nothing to send. The claim settles the case the read cannot,
which is two processes that both read the slot as unanswered: the unique index
refuses the second claim, and the loser reports nothing rather than a send it did
not make or a failure it did not have.

## Why a refusal is different, and what it changes

A refusal Brieflyy *witnessed* is not a death. A provider that answered no means
nothing reached the User, and that is a fact the process is still here to act on —
so the claim is released and the DeliverySlot is owed again. This is the case
ADR-0011 was written about.

A refusal releases the claim. Everything else — a throw, a timeout, a 5xx, a
5xx-shaped "no data, no error", a database that would not record the attempt —
leaves it standing, because in every one of those the message may already be on
its way. The asymmetry is the point: a wrong refusal costs a duplicate email to a
User who is already holding one, and a wrongly-held claim costs one period that
Brieflyy admits nothing about.

Every other failure leaves the claim standing: a timeout after the provider
accepted, a thrown call, a 5xx, a delivery row that would not write, the process
on its way down. In each of those the message may well be in an inbox, and a
second brief is worse than a silence.

**Which means "refused" cannot mean "we did not hear back".** That is the whole
decision, and it is the part most easily got wrong: `ResendEmailTransport`
originally turned `result.error` and a thrown `client.emails.send` into the same
`Error`, and a caller told only that it threw would have to treat a socket that
died mid-request as a refusal — releasing the slot on precisely the case where the
message is most likely to have gone out.

So there are three outcomes and not two, and the transport is where the difference
is made rather than guessed at afterwards. `EmailRefusedError` is raised only where
the provider itself said no: a validation error, a suppressed address, an
unrouteable one. A thrown call is rethrown untouched, and an answer with neither
data nor error is an ordinary error, because in both cases Brieflyy asked and found
out nothing. `DeliveryOutcome` is then `sent`, `refused` or `unknown`, and the
release reads off that rather than off whether something was thrown.

The two are separated for a third reader too. A delivery that was not `sent` holds
tokens minted for a document that went nowhere, and `UnsubscribeService` refuses
them — a token that resolves to nothing is refused as an unknown token rather than
as an error of its own, because a fourth reason would tell a reader only what they
cannot act on, and honouring a guessed token would stop a User's mail over a
message that was never sent.

## What a released claim must not lose

The evidence that the attempt happened, so the `EmailDelivery` is written either
way and carries its outcome. A refusal that left no row was indistinguishable from
a brief nobody asked for.

The generation report goes on that row too, and on the pass's counters: a brief
that was rendered and then refused was written, so its calls were made and billed,
and a report that dropped it would make a spent call indistinguishable from a call
never made. That is the same reason the report exists at all.

## The trade, stated

A pass that dies between 2 and 5 costs the User that DeliverySlot. They do not get
it again, because the application cannot tell whether they got it. The alternative
is a duplicate email for a period already delivered, and the choice between "one
brief possibly lost" and "one brief certainly sent twice" is not close.

This is at-most-once for the slot and at-least-once for the refusal, which is the
honest way round to have them: both halves are states the process can actually
observe. The one that is not observable — a send whose fate is `unknown` — is
treated as the death it may be, because the only other reading is a duplicate.

## What is deliberately not here

**A delivery queue.** A send handed to a worker and retried until it lands would
give at-least-once for free, and it would need somewhere to keep the claim while
it was in flight — which is a second table, written and settled around the same
uncertainty, for a guarantee this codebase does not need from a one-minute job.

**An idempotency key on the transport.** Resend supports one and it would let a
retry be safe. It also makes the guarantee depend on a provider feature, and the
brief that goes out is the one place this application would then have a copy of a
User's mail waiting on nothing else.

**Reclaiming a stale claim.** A claim whose pass died is indistinguishable from
one whose pass is still running, so a timeout-based reclaim is a guess with a
duplicate email on one side of it. A claim nobody settled stays claimed.

**Counting a release as a second failure.** A refusal is one attempt that failed,
so it is one `failureCount` and no `sentCount`, whichever pass it happens in.

**Treating `unknown` as `refused` because the two look alike.** They do not, and
they are the whole reason there are three outcomes: one releases the slot and one
does not. A pass that dies is a death whatever it is recorded as, but a timeout is
not, and the only cost of getting that wrong is the duplicate this ADR exists to
prevent.

**Refusing an unsubscribe token out of an `unknown` delivery.** It is tempting,
and it is wrong. An `unknown` delivery's link may be in a real reader's inbox —
the send timed out, the mail arrived anyway — so refusing it concludes the message
never arrived, which is the one thing an unknown outcome says nothing about, and it
does that to exactly the reader whose send misbehaved. Only `refused` resolves to
nothing, because only `refused` means no message left.

**Repairing an abandoned claim.** A claim with no `sent_at` that a live process
did not just take is a pass that died, and nothing today reports one: the daily
job's own status view counts sends and failures per pass, and an unsettled claim
belongs to no pass. Surfacing them, and deciding what to do about them, is its own
piece of work — and the decision it needs is not available here, because whether
that message arrived is precisely what is unknown.