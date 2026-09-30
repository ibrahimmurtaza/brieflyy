# An unsubscribe is state the send path reads, not a route that answers

A brief is the only thing Brieflyy sends, so the unsubscribe link in it is the
whole of its compliance story. Three things had to exist for that link to be
real, and only one of them was ever written.

The renderer used to emit a footer pointing at `/unsubscribe/topic` and
`/unsubscribe/all` with a literal `TOKEN` in the query string, and neither route
was registered anywhere. Those links were removed rather than left in place,
because a link that looks real and answers 404 is worse than no link: a reader
who follows it is told the product has no such thing. Removing them was correct
and it is also what left the reader with no way to stop the mail at all.

Underneath, the two tokens were already being minted, written to the
BriefSnapshot and copied onto the EmailDelivery. Nothing read them. That was the
tempting part: a route that looked a token up and set a boolean would have been
a small change. It would also have been a route that made a promise the product
did not keep, because the daily job would have gone on sending to a User who had
just asked it to stop.

So the two halves had to land together, and the shape they took follows from
which one is load-bearing.

## The opt-out is a column, and it is read on every pass

There are two scopes, and they are not two levels of the same setting:

- **One Topic.** "Stop emailing me about this" — everything else in the mailbox
  keeps arriving.
- **The whole User.** "Stop emailing me" — a decision about the mailbox rather
  than about a subject.

So they are two columns: `topics.unsubscribed_at` and `users.unsubscribed_at`.
The daily job reads them on every pass and skips a User or Topic that carries
one. This is the load-bearing part of the change. A token that was spent and
recorded but that nothing consulted would be a link that reads as working and is
not — the same defect as the 404, one layer further in and much harder to see,
because it would only ever show up as a complaint from a reader.

`ScheduledBriefService` reads the Users' opt-outs once per pass, in one query,
rather than per delivery setting. The answer is a handful of rows and the
alternative is a lookup per User for a flag that is almost always absent.

A pass that skips an unsubscribed User or Topic counts neither a send nor a
failure. The DeliverySlot is not written either, so a resubscribe does not
release a backlog of every reading since the opt-out — a User who comes back
gets tomorrow's brief, not four weeks of them.

## The `unsubscribes` row is the receipt, not the effect

The record of an unsubscribe is written when the link is used, against the
EmailDelivery the link arrived in. It is not where the state lives.

That ordering is deliberate. Both writes are idempotent given the same input, but
only one of them is what the scheduler reads, so the opt-out goes first: a crash
between them has to leave a reader who asked to stop the mail still not receiving
it. A row that is a receipt is allowed to be missing; an opt-out that is missing
is mail nobody can take back.

`unsubscribes.token` is unique, and that is the whole single-use property. It is
a constraint on the database rather than a check in the service, so two one-click
requests landing at once cannot both spend one token even though both passed the
read. The service catches the constraint violation and reports `already_used`,
having already applied the opt-out — which is idempotent, so the reader's request
still took effect.

The alternative — a `consumed_at` column on the token's own row — was rejected
because it needs a row per token, minted at send time, for every brief ever
sent. The table would be the size of the mailbox.

## Two scopes mean two tokens, and both are on the message

RFC 8058 is the reason `EmailMessage` grew a `headers` field. A client that
supports one-click unsubscribe never shows the reader the link in the body: it
reads `List-Unsubscribe` and POSTs to it itself, with the reader doing nothing. A
brief carrying a working unsubscribe link in its body is therefore still
unsubscribable in exactly the clients that offer the feature, and the header is
the only way to be told about it.

Both scopes are in both places. The headers are what an RFC 8058 client acts on;
the body is what every other client shows, and a reader who has to go hunting
through a client menu to stop the mail will not.

The `mailto:` companion the standard permits is not sent. It needs a monitored
address to point at, which this product does not have yet, and a dead unsubscribe
address is a worse version of the 404 this change exists to remove.

## A GET that unsubscribes

`/unsubscribe/topic` and `/unsubscribe/all` each answer a GET that spends the
token, and a GET is supposed to be safe. It is not, and that was accepted
deliberately.

The alternative is a confirmation page whose button posts, which is what most
newsletter products do. It is also what a reader with one-click support never
sees, because the client has already done the POST itself and lands them nowhere.
So the two products are:

- a client that supports one-click, where the reader clicks nothing and the GET
  form is never used;
- every other client, where the reader follows a link in the body, and a
  confirmation page puts a second click between them and the thing they just
  asked for.

The second group is the group the brief's own footer exists for. Making them
click twice to act on the only stop control the email offers is how a reader
ends up marking the sender as spam instead, which is a worse outcome than a GET
that does what the link says.

The real hazard is a mail client or a link scanner that fetches a URL nobody
clicked — Outlook Safe Links and several enterprise scanners do exactly this.
A prefetched unsubscribe link would silently opt somebody out. That risk is real
and it is not mitigated here; it is bounded instead, by the token being
single-use and by the fact that a wrong opt-out is undone from
`/settings/briefs` in one click. A product that could not undo it would have to
choose the confirmation page.

## The token is the only authorisation

`/unsubscribe/topic` and `/unsubscribe/all` are public, and have to be: a reader
following a link in their inbox is by definition not signed in. That makes the
token the entire authorisation, and it is the reason the routes take nothing but
a token.

The User and Topic an unsubscribe applies to are the ones the token resolves to.
Nothing in the URL is believed about that. A brief is forwardable, and a URL that
carried its own idea of whose subscription to change would be a URL a forwarded
brief could aim anywhere. The same rule is why `resubscribeTopic` looks the Topic
up and compares its owner rather than trusting the caller.

The token is measured for expiry from when its brief was **sent**, not from now.
The window is how long the link in that particular email has been live, which is
the only reading that means anything to a reader looking at an old message. It is
thirty days, which is a month of inboxes rather than a session lifetime — a link
that dies in fifteen minutes is no use at all in the place links are actually
followed from.

## The manual send path honours it too

`POST /topics/:slug/send-brief` is the one path that gets around the daily job's
filter: a User presses a button on their own Topic and a brief goes out. It
refuses while the User or the Topic has opted out, and the LivingBrief replaces
the button with a sentence saying so and a link to `/settings/briefs`.

The acceptance criterion only mentions the scheduler, and a reading that stops
there would have left the confirmation page promising "no Brieflyy email will be
sent to you again" to a page that would have sent one. A control that always ends
in a refusal is worse than one that explains itself, so the button is not
offered either.

## Resubscribing is a separate decision

Clearing a User's global opt-out does not clear any Topic's own. They were two
decisions, and "yes to all of them again" is not an answer to the first one.

`/settings/briefs` shows both, separately, with a control for each — because an
opt-out with no way to undo it and no page that says which Topics it covers is a
setting the User has lost control of. The confirmation page an unsubscribe link
lands on points straight at it, so the two are named in one module: a settings
page unreachable from the link a brief carries is a dead end at the exact moment
somebody has decided they want fewer emails.

## What this does not do

- **No digest frequency or preference.** The global opt-out is all-or-nothing.
- **No `cadence: 'never'` on unsubscribe.** A Cadence is what the User asked for;
  an unsubscribe is a later, separate decision, and folding one into the other
  would make resubscribing a guess about what to put back.
- **No suppression list for hard bounces or complaints.** An Unsubscribe is
  something somebody asked for. Provider-side suppression is a different fact
  about a different thing, and borrowing this table for it would make "did they
  ask?" unanswerable.
- **No hashed tokens.** The tokens are stored as they are, because they already
  were on `brief_snapshots` and `email_deliveries` and changing what those
  columns mean is a separate piece of work. Single-use and the expiry window are
  what bound a leaked token here; a database leak is a different threat with a
  different answer.
- **No repair for a database that already holds a duplicate token.** The two new
  `email_deliveries` unique indexes are created at boot, so an existing database
  carrying the same token twice would fail to open. Tokens have been minted with
  `randomUUID()` per send since they were added, so this has never been possible
  in practice — but it is a one-way door, and a deployment that somehow has one
  needs the duplicates removed by hand before it will start.
