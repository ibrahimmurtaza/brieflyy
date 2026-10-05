# Brieflyy

A SaaS tool that aggregates content around user-specified topics, clusters related items, summarizes them via AI, and surfaces the most relevant ones in a personalized brief feed with insights and visual trends.

## How to read this

This is the vocabulary of the product, so an entry describes the thing rather than
the code that implements it. Where the two differ, the difference is written down
rather than left for a reader to find:

- A claim about what a User can see or do is a promise. If the code does not do it
  yet, the entry says **Not built:** and names the entry it would live in.
- A number here is the number the code enforces. Where a number is only copy on a
  page, it says so.
- Where a term is a rendering rather than a stored artefact, it says so, because
  "regenerates" and "is regenerated" are different claims.

`README.md` lists where each piece of behaviour lives and
`src/docs-agreement.test.ts` fails the build when a document and the code stop
agreeing about a file, a command or a count.

## Language

### Identity

**User**: A human who has signed up for Brieflyy. One account = one human. A User who has asked to stop receiving every brief carries an unsubscribed-at date; it is what the daily job reads to skip them.
_Avoid_: customer, member, account holder

**Account**: The authentication record for a User. Holds email, linked OAuth providers (Google), and active sessions. One User has one Account however many doors they came through, and an Account's address is stored in one form however it was written when they arrived.
_Avoid_: profile, credentials

**Provider**: A sign-in Brieflyy offers that hands the identity check to somebody else, currently only Google. Whether one is offered is a property of the deployment, not of the User or the request: an instance with no Provider configured offers no Google button, and the routes behind one refuse rather than fail. See ADR-0019.
_Avoid_: social login, SSO (when meaning the identity check rather than the protocol)

**OnboardingState**: A User's progress through first-run topic selection and delivery-time setup. It is what decides which screen a User lands on after signing in, and nothing else: there is no activation event, no time limit and no measurement of one.
**Not built**: the activation moment — a first brief landing within 24h of signup. Nothing in the application records one or waits for one, so this is a number with no counter behind it rather than a behaviour that is merely unmeasured.
_Avoid_: signup flow, first-run

**DeliveryTime**: A per-User clock time at which that User's scheduled BriefSnapshots are generated and emailed. All of a User's Topics share one DeliveryTime.
_Avoid_: send time, schedule time

**Request token**: The value every page carries in its forms and the application echoes in a cookie, checked together before a write is allowed to change anything. It is random and names nothing — not a User, not a session, not an address — so it tells a reader of the page nothing the page does not already show. The cookie is httpOnly, so script on the page cannot read the half that is kept from it; the value in the markup is in the document, and anything in the document is readable by whatever reads the document. A submission whose cookie and form token are missing or disagree did not come from a page Brieflyy rendered, and is refused in words rather than as a bare status.
**Not built**: the check on the writes that carry the token but do not yet read it. The Feedback write is the only route that refuses on the pair; the remaining state-changing routes already render the field, so what is missing there is the same one line rather than a different mechanism. See ADR-0021.
_Avoid_: CSRF token, nonce, anti-forgery token

### Core

**TopicTemplate**: A curated, shared definition in the Directory. Selecting a TopicTemplate clones it into a per-user Topic.
_Avoid_: preset, default topic

**Topic**: A user-scoped interest that scopes all aggregation, clustering, and briefing for a single user. Created from a TopicTemplate or from a free-form phrase. Has its own source list, cadence, and feedback history. The Topics a User picks in one submission are created as one all-or-nothing write, so a User is never left holding part of what they asked for. A Topic a User has unsubscribed from keeps an unsubscribed-at date and stops being emailed; it is not removed, and clearing the date starts it again. A removed Topic is gone from the application but keeps its brief history, and its slot in the FreeTier cap goes to a Topic the User picks instead.
_Avoid_: subject, interest, feed

**Source**: A news outlet or RSS feed in the curated Brieflyy registry. Each Topic has a curated default source list that the user can edit — shortened as well as lengthened, and only with Sources the registry has, so the list is the User's without being a list of feeds Brieflyy cannot poll. An edit is read by the next ingest cycle.
_Avoid_: outlet, publisher, feed (when meaning a Source, not an RSS document)

**Article**: A single ingested document from a Source. The atomic input to the pipeline.
_Avoid_: post, item, document

**Entity**: A named thing (person, organization, place, product, or concept) extracted from an Article by named-entity recognition. The key used for Cluster overlap and the unit of Trends. One Entity however many ways outlets write its name: a spelling is not the identity.
_Avoid_: tag, keyword, named entity

**Story**: A deduped event — one thing that happened, however many outlets reported it — held as a group of near-duplicate Articles published within a 72h window of each other. The working unit of the pipeline. A User does not meet a Story on the surfaces a brief is built from; they meet a Retired Story in the Archive, labelled as one, which is why "never sees a Story" would be the wrong claim to make absolutely.
_Avoid_: event, article group

**Story signature**: An Article's text-derived identity: its content words and its key phrases, stored and compared rather than hashed. Two Articles are one Story when enough of their signatures agree, and the threshold they have to clear is measured rather than guessed — a test holds both margins of it against a set of near-duplicate fixtures, and fails if either has moved closer than a stated distance. What it *is* measured against is a set of fixtures written in the shapes feeds actually serve: wire copies of one event, reports about other things, reports about the same company as the wire copies, items whose only text is a headline, items carrying a feed's own citation header, and the editorial standfirsts nine of the twenty registry Sources publish instead of a description. A signature measured only on clean prose is a constant that says nothing about the feeds it runs on.
_Avoid_: fingerprint, fingerprint hash, article hash

**Cluster**: The unit the user sees. A grouping of related Stories by Entity overlap, within a 7d window (per-topic tunable). Receives Feedback and is the target of Summarization. Its one-liner and bullets are its Cluster summary. A Cluster that is still picking up Stories is a new Cluster, not a new version of the old one.
_Avoid_: story, topic, thread

**Cluster window**: How far back a Topic looks when it groups Stories into Clusters. Seven days by default, and a User can change it per Topic, from the control on the Topic's own LivingBrief rather than from its settings page. One to thirty days; a stored value outside that range is clamped rather than obeyed, because a window of zero clusters nothing and a window of years puts a Topic's whole history into one Cluster.
_Avoid_: cluster TTL, retention window

**Cluster summary**: The one-liner and the bullet points a Cluster is shown with. Every line is quoted from an Article in that Cluster, never written afresh, so nothing reaches a User that a Source did not write. A feed's own metadata about an item — the link and score a feed with no description gives instead of text, and the citation header one prefixes to the standfirst it does have — is not a statement a Source made about the story, so it is not quoted either, and the Article's headline is used instead. That removal happens once, where an Article's text is taken in, so the sentence a User is shown and the words the pipeline matches on are the same words. _Avoid_: abstract, digest, synopsis

**Written summary**: A one-liner and bullet points written afresh for a Cluster, and constrained to cite only Articles inside it. It exists only in a BriefSnapshot and only for the leading Clusters of the plan: the citation constraint is what makes it quotable, and a Cluster's own Cluster summary is what every other surface shows and what a failed call falls back to. A LivingBrief never carries one, so a Cluster reads the same way in the app as it did in the last email. The code names the mechanism rather than the concept — `LLMSummaryClient`, `BRIEF_GENERATED_CLUSTERS` — and not a third thing.
_Avoid_: AI summary, paraphrase

**Generation report**: What writing a brief cost — the Clusters written, the calls made, and the bullets discarded for failing the citation constraint. Held on the EmailDelivery for every brief that was sent, and added up on the BriefJobRun for every pass of the job. It exists because a written summary and a quoted one are the same document to a reader, so nothing a User can see distinguishes a feature that is working from a deployment whose credential expired; the report is the only place that can be noticed. Never part of a BriefSnapshot, which is a document and is served forever.
_Avoid_: stats, telemetry, metrics

**BriefPlan**: A selection and ordering of Clusters for a Topic at a moment in time. The artefact a BriefSnapshot is derived from.
**Not built**: regenerating a plan, and reading one back. A plan is written in the same step that renders and sends a brief, and nothing reads a stored one back *as a plan* — the Archive index reads a snapshot's plan for the `cluster_ids` it needs to name that snapshot's Sources and Entities, in the same statement that writes the row. So "the regenerable artifact" is the intended shape rather than the current one.
_Avoid_: brief, digest

**BriefSnapshot**: An immutable, linkable rendering of a BriefPlan — the form of a brief that is emailed. Once sent, does not change. Retained forever regardless of tier, since it is what was sent.
_Avoid_: email brief, sent brief

**LivingBrief**: What a Topic looks like in the app: its Clusters, ordered by what the User's Feedback says, read fresh on each visit and so reflecting the Topic as of that moment. It is a rendering, not a stored artefact — there is no LivingBrief table, type or route, and the word names the in-app surface rather than anything the database holds.
**Not built**: deriving it from a BriefPlan. The plan an emailed brief is built from has no in-app counterpart, which is why the two halves of **Brief** below are described separately.
_Avoid_: feed, topic view

**Brief**: The conceptual product artifact. A specific instance is either a BriefSnapshot (email) or a LivingBrief (in-app). Only the first is produced from a BriefPlan today; the second is read from the Topic's Clusters directly.
_Avoid_: digest, summary, newsletter

**EmailDelivery**: A record that a BriefSnapshot was emailed to a User. Carries the per-Topic and global one-click unsubscribe tokens the brief went out with, and is what those tokens are looked up on. Distinct from the BriefSnapshot so a snapshot can be re-linked or unsubscribed from independently of the mail that carried it.
**Not built**: re-sending one. Every send plans, renders and stores a fresh BriefSnapshot and a fresh EmailDelivery, so the two rows being separate is what makes the tokens and the document addressable rather than what makes a resend possible.
_Avoid_: email log, sent mail
**Unsubscribe**: One use of an unsubscribe link from a sent brief, recorded. Carries the UnsubscribeScope, the EmailDelivery the link arrived in, and the token that was spent. Single-use — the token is unique — and time-limited, so a link in a brief stays usable for as long as a reader would expect and no longer. The state the daily job honours is the unsubscribed-at date on the Topic or the User; the Unsubscribe is the record of the ask, and survives a resubscribe.
_Avoid_: opt-out event, suppression record, bounce

**UnsubscribeScope**: What an unsubscribe stops — one Topic or the whole User. The same two answers a FeedbackScope gives and spelled the same way, because they are the same question asked of different things, and two vocabularies for one distinction is one more thing a reader of the schema has to reconcile. The per-Topic one is `this_topic`, the whole-User one `global`.
_Avoid_: level, breadth, kind

**DeliverySlot**: The single instant a User's DeliveryTime falls on, for one local day in the User's own timezone. What the daily job compares the clock against, and what a BriefRun is keyed on. A reading that does not exist on a spring-forward day lands on the same half hour of the morning just after the change; a reading that happens twice on a fall-back day is the first of the two.
_Avoid_: due time, cron time, send window

**BriefRun**: The record that the daily job produced a BriefSnapshot for one of a User's Topics at one DeliverySlot. Written only once the brief has gone out, so a User the job failed to send to is still owed that DeliverySlot. Its existence is also what stops two passes answering the same DeliverySlot twice.
_Avoid_: brief job log, delivery log

**BriefJobRun**: One pass of the daily job: when it started and finished, how many briefs it sent, how many it failed to send, and the Generation report for everything it wrote. A pass that finds nobody due reports zero of each rather than nothing at all, because a job that ran and sent nothing is a different thing from a job that is not running.
_Avoid_: run log, job log

### Engagement

**FeedbackType**: An enum of the explicit signals a User can give — `ThumbsUp`, `ThumbsDown`, `HideSource`, `MoreLikeThis`, `LessLikeThis`.
_Avoid_: reaction type, vote type

**Feedback**: An explicit signal a User gives on a Cluster, of a single FeedbackType. Read back as the latest signal per Cluster: pressing a button that is already the one in force changes nothing, and pressing its opposite supersedes it. A verdict and a preference are separate — "was this worth reading" and "what should I see next" — so a User can carry both on one Cluster. Propagated to the underlying Stories and Articles, which is what it ranks by; see ADR-0004.
_Avoid_: reaction, vote. "Signal" is kept for one Feedback, which is how ADR-0004 and the FeedbackType entries already use it.

**FeedbackEvent**: The persisted record of a single piece of Feedback. Carries the FeedbackType, target Cluster, target Scope (this topic only vs global, for HideSource), the Source a HideSource is about, and timestamp. Its Cluster is where the User pressed the button, not what they were saying about; a Cluster can carry several Sources, and HideSource is a statement about one of them.
_Avoid_: feedback log, reaction record

**Cadence**: A Topic-level schedule — daily, weekly, or never. Evaluated against the User's DeliveryTime, so the decision is when a brief goes out rather than how often one is written. A weekly Cadence carries the day of the week it falls on, because "every week" on its own has no answer; a daily or never Cadence carries none. Set on the Topic's own settings page, which is where a User changes what a Topic reads from and what it is called as well.
_Avoid_: schedule, frequency

**Topic settings**: The one surface per Topic where a User controls its Cadence, its Source list, its name, and whether it exists at all. Four answers about one Topic, on one page reached from its LivingBrief, rather than four places a User has to know about. A Topic's settings are its own: they are resolved by slug against the signed-in User, so a slug that is not theirs is a Topic that does not exist on this account rather than a write against somebody else's row.
_Avoid_: preferences, topic config

### Trends

**TrendWindow**: A 7d observation window compared against a prior 30d baseline, used to compute entity-level lift for a Topic. Half-open at both ends, and they meet: an Article published exactly where the baseline ends is observed, not baselined, so nothing is counted twice.
_Avoid_: window, period

**EmergingEntity**: An Entity whose mention rate within a Topic's Articles shows significant lift in the current TrendWindow vs the prior baseline. Surfaced in the trends view and the "across your topics" rollup, carrying its own daily mention-rate series — a ratio with nothing drawn under it is a claim a User cannot check.
_Avoid_: trending topic, hot entity

**TopicTrend**: One Topic's measured trends, materialised and stored rather than computed per request. Recomputed on an hourly cadence, so the chart, the annotations and the Entity list all describe the same measurement taken at the same instant; a page that measured on every read would answer three different questions.
_Avoid_: trend report, analytics snapshot

**Trends spike**: A day whose mention volume stands well above the average, together with the Clusters that arrived on it. The Clusters are carried with it rather than looked up afterwards, because a jump with nothing behind it cannot be acted on.
_Avoid_: anomaly, outlier, event

**Trends rollup**: Every Topic a User holds, added together, from the stored TopicTrends rather than from a fresh measurement. One Entity however many of their Topics it rose in.
The exception is a Topic added since the hourly job last passed, which has no stored trend to read: it is measured once, on the first read, and read from the row after that. Every other read is a read, so a page measuring on every request is the thing being avoided rather than the thing that happens.
_Avoid_: dashboard stats, summary

### State

**Active (Cluster)**: A Cluster's state while it is still picking up Stories — while its velocity (Stories per unit time) is above a threshold. Active Clusters appear in LivingBriefs and in new BriefPlans. A Cluster that stops getting covered loses Active on its own, rather than being switched off.
_Avoid_: live, current

**Retired (Story)**: A Story's state once none of its Clusters is Active. Retired Stories are retained per tier but are not surfaced in new Briefs, which plan from Active Clusters and never consult a Story.
**Not built**: retirement as a stored fact. `stories` has no state column; "Retired" is derived where it is needed — the Archive's index asks whether any of a Story's Clusters is Active — so a Story is Retired by the absence of evidence rather than by a row of its own.
_Avoid_: dead, expired

**Archive**: The persisted history of Clusters, BriefSnapshots, Articles, Stories, and FeedbackEvents beyond their active lifetime, held per Topic so it is one User's and no other's. Searchable by the User, by whole words through a full-text index. Retention is tiered, with BriefSnapshots exempt (retained forever).
_Avoid_: history, log

### Onboarding & discovery

**Directory**: The curated set of TopicTemplates Brieflyy ships. A User selecting a Directory entry clones it into a per-user Topic.
_Avoid_: catalog, library

**DiscoverTab**: The in-app surface showing Directory entries, "Topics like yours" Recommendations, and what is trending over a stated window — used to find and add Topics. One Directory entry is cloned at a time, not three. See ADR-0014.
_Avoid_: explore, browse

**Recommendation**: A suggested Topic surfaced in DiscoverTab, derived from the User's existing Topics' Entity and Source overlap. Each distinct Entity and each distinct Source shared counts once.
_Avoid_: suggestion, related topic

**Mention volume**: How many Articles a Source published inside the measured window. What "trending" is computed from; a Directory entry's mention volume is the sum over its Sources, each counted once. See ADR-0014.
_Avoid_: popularity, buzz, score

### Monetization

**FreeTier**: 3 Topics, 30-day retention on Archive, BriefSnapshots retained forever, trends history visible only for the last 3 days. The 30 days reaches Articles as well as Clusters, Retired Stories and FeedbackEvents — the Archive's predicate is one window over every kind except a snapshot, not three windows.
**Not built**: realtime briefs. There is no realtime anything: a brief goes out when the User's DeliveryTime arrives and is answered for, and no tier changes that.
_Avoid_: free plan, basic

**PaidTier**: Unlimited Topics, indefinite Archive retention, BriefSnapshots retained forever, full trends history. The trends layer is the paid differentiator.
**Not built**: billing, and so the price. $15/mo is what the upgrade page says; there is no provider behind it, and the only way onto this tier is the development-only `POST /dev/tier`, which is registered only when `DEV_TOOLS_ENABLED` is set — off by default, and a production instance is expected to leave it off.
_Avoid_: pro, premium
