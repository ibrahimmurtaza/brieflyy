# A User over the cap is asked which of their Topics to keep

A paid User may hold as many Topics as they like and a free one holds three, so a
User whose Subscription ends while they hold nine has six Topics the new plan cannot
pay for. ADR-0024 made the cancellation reach the provider and left this open: it
promised that "which Topics stop and which survive is the product decision" and that
"nothing is removed in the meantime — the cap is simply the next refusal they meet".

That promise is now kept, and this records the shape that keeps it.

## The shape

One derived fact, one page, one write:

1. **`TopicCapOverflow`** — the cap, how many Topics a User holds and how many of them
   are over it, from `topicCapOverflow(tier, held)`. `null` while they are within it.
2. **`planTopicReduction`** — the Topics to keep, or `null` for the same reason.
   Everything they hold that is not in that list is what would stop, so it is one list
   rather than a pair.
3. **`TopicOverflow`** — the two of those together with every Topic the User holds,
   read by `BillingService.topicOverflowFor`. `within_cap` when there is nothing to
   decide and `over_cap` when there is.
4. **The Subscription settings page** states the overage, names all of their Topics,
   ticks the three it suggests keeping, and offers the answer as a form.
5. **`POST /settings/billing/topics`** — behind the session and behind the cross-site
   write guard (ADR-0021, ADR-0022). It removes the Topics that were not kept and
   records the answer.

`topics` gains nothing. The Topics that stop are soft-removed exactly as a User's own
"Remove" button removes one, so their brief history survives and their slugs stay
theirs. `topic_reductions` is new: one row per answer, holding both lists by id, the
cap and the held count the answer was given against, and the moment it was given.

## The parts that are load-bearing

**Nothing is removed without an answer.** Not on the event, not on the page read, not
on the next morning. The signed event moves the tier and stops there, exactly as
ADR-0024 said it would; the six over the cap are still six Topics the User has, still
briefing and still emailed, and the only thing that changes for them is that they
cannot add a tenth. This is the difference from the alternative, which is to apply the
plan when the cap moves: it would be one line of code and it would take six of
somebody's Topics without asking, which is the thing the ticket is about.

**The question is derived and the answer is stored.** The overage is two facts — the
tier and the Topics — and both can move without anything consulting a row: a User can
remove a Topic by hand, and a User who pays again is no longer over anything. So the
pending question has no row to go stale, and paying again clears it by itself rather
than by a job that has to notice. The answer is the opposite: a decision is a fact
about a moment and nothing else derives it, so it is written once and never edited.

Which is why a User who pays again before deciding gets all nine back. Nothing had
been taken, so there is nothing to restore, and the page stops asking because the cap
does. A User who then stops paying a second time is asked again, from the state, with
the same nine Topics — not from anything the first episode left behind.

**The removals, then the record.** The two are not one transaction, and the order is
the argument for that. A failure between them leaves six Topics removed and no row:
the state is then *consistent* — the User is within their cap, which is what the
answer was for, and they are asked nothing — and what is lost is the record of why,
which a removal date on six rows still carries. The other order would leave a row
claiming six Topics stopped when a failure had stopped none, which is a claim about a
User's data that nothing could later contradict.

**Three refusals before any write.** No Topic ticked, more than the cap, and a User
who is not over the cap in the first place. The first two are submissions the page's
form cannot produce and a browser can. "No Topic ticked" is the one that matters: a
submission with an empty set is not an instruction to remove everything the User has,
and "keep the first three, drop the rest" written as a truncation would be this
application making the decision the User was asked for.

**Slugs resolved against the User's own Topics.** The page renders what a User reads,
so the form submits slugs — and a slug belonging to somebody else resolves to nothing
and never reaches the removal, the same rule the Topic settings page resolves a slug
by. Ids are what the record keeps, because a slug is a Topic's address rather than its
identity: it survives a removal, so re-adding the same subject allocates
`fusion-energy-2` beside the removed row and a slug recorded as an answer would no
longer name one Topic.

**The most recently added keep working.** It is a suggestion and nothing acts on it,
but it has to be one and the same suggestion every time the page is rendered, because
a ticked box the User unticks is how they disagree. The most recent because the
Topics somebody added last are the ones they have just been reading and the oldest are
the ones most likely to have lapsed. Where two share a `createdAt` — a batch submitted
in one submission is written in one transaction against one clock — the later id wins.

**Five surfaces carry the reason, and none of them offers the upgrade page.** The
topic list, both pickers, the DiscoverTab, and the page a refused submission lands on.
Two of the five refuse the submission and three warn before one is made, and all five
read one sentence out of `layout.ts`, because a User holding nine told "you have
reached the limit of 3" has been told a number that is not their problem. The link is
to the billing page and not to the upgrade page because somebody over the cap has
already been offered the paid plan.

**The announced answers are checked against the state, and one of them against the
record.** `?topics=reduced` arrives in a query string on a User's own address, so it
can be typed. Announced over a User who is still over the cap it would claim six
Topics were removed while the page below asks them which six; announced over a User
who never had a question at all it would be a claim about an account nothing else on
the page contradicts. So `reduced` is said only for a User within their cap **who has
a recorded answer** — and the record is what distinguishes those two, because the
state cannot: a User who answered is within their cap and a User who was never asked
is too. `not-over-cap` is gated on the same state for the same reason, in reverse. The
two refusals are not gated, because each claims nothing happened and there is no state
in which that is untrue. This is the rule the cancellation announcements beside it
already follow (ADR-0024), and the answers about Topics needed it more, because two of
the four make a claim rather than admitting a failure.

## What is deliberately not here

**Turning a Topic off rather than removing it.** `unsubscribedAt` would have stopped
the mail without removing anything, and it is the reversible option. It is the wrong
one here: a removed Topic's slot goes to a Topic the User picks instead, and an
unsubscribed one still counts against the cap — so a User who answered would be left
holding nine, still unable to add a tenth, with six of them silent. They would have
answered a question that changed nothing. If a User wants a Topic quiet rather than
gone, the one-click unsubscribe in a brief is still there for that.

**A deadline.** Nothing expires the question and nothing is removed on a timer. A User
who never answers keeps all nine and is refused a new one for as long as that lasts,
which is a cost they can see and stop paying at any moment — and a plan with no cap
underneath it makes the refusal the only thing wrong with the account.

**Telling them why they are over the cap.** The page states the count and the choice,
and does not say the Subscription ended. It is the surface that knows about
Subscriptions, but the overage is derived from the tier and the Topics, and the same
state is reachable through the development-only tier switch — where "because your
Subscription ended" would be false. The Subscription's own block above says what
happened to it, and this one says what it means.

**Choosing for them from a rule.** The plan is one rule because a page has to render
*something* ticked, not because the rule is the decision. The decision is the User's,
and the three ticked boxes are the most they are told before they make it.
