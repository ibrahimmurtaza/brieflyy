# Brieflyy

A SaaS tool that aggregates content around user-specified topics, clusters related items, summarizes them via AI, and surfaces the most relevant ones in a personalized brief feed with insights and visual trends.

## Language

### Identity

**User**: A human who has signed up for Brieflyy. One account = one human. A User who has asked to stop receiving every brief carries an unsubscribed-at date; it is what the daily job reads to skip them.
_Avoid_: customer, member, account holder

**Account**: The authentication record for a User. Holds email, linked OAuth providers (Google), and active sessions.
_Avoid_: profile, credentials

**OnboardingState**: A User's progress through first-run topic selection and delivery-time setup. Drives the activation moment (first brief landing within 24h of signup).
_Avoid_: signup flow, first-run

**DeliveryTime**: A per-User clock time at which that User's scheduled BriefSnapshots are generated and emailed. All of a User's Topics share one DeliveryTime.
_Avoid_: send time, schedule time

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

**Story**: A deduped event — one thing that happened, however many outlets reported it — held as a group of near-duplicate Articles published within a 48–72h window of each other. The working unit of the pipeline; the user never sees a Story directly.
_Avoid_: event, article group

**Story signature**: An Article's text-derived identity: its content words and its key phrases, stored and compared rather than hashed. Two Articles are one Story when enough of their signatures agree, and the threshold is a measured property of real wire copies rather than a constant that looks right.
_Avoid_: fingerprint, fingerprint hash, article hash

**Cluster**: The unit the user sees. A grouping of related Stories by Entity overlap, within a 7d window (per-topic tunable). Receives Feedback and is the target of Summarization. Its one-liner and bullets are its Cluster summary. A Cluster that is still picking up Stories is a new Cluster, not a new version of the old one.
_Avoid_: story, topic, thread

**Cluster window**: How far back a Topic looks when it groups Stories into Clusters. Seven days by default, and a User can change it per Topic.
_Avoid_: cluster TTL, retention window

**Cluster summary**: The one-liner and the bullet points a Cluster is shown with. Every line is quoted from an Article in that Cluster, never written afresh, so nothing reaches a User that a Source did not write. A feed's own metadata about an item — the link and score a feed with no description gives instead of text — is not a statement a Source made about the story, so it is not quoted either, and the Article's headline is used instead.
_Avoid_: abstract, digest, synopsis

**Written summary**: A one-liner and bullet points written afresh for a Cluster, and constrained to cite only Articles inside it. It exists only in a BriefSnapshot and only for the leading Clusters of the plan: the citation constraint is what makes it quotable, and a Cluster's own Cluster summary is what every other surface shows and what a failed call falls back to. A LivingBrief never carries one, so a Cluster reads the same way in the app as it did in the last email. The code names the mechanism rather than the concept — `LLMSummaryClient`, `BRIEF_GENERATED_CLUSTERS` — and not a third thing.
_Avoid_: AI summary, paraphrase

**Generation report**: What writing a brief cost — the Clusters written, the calls made, and the bullets discarded for failing the citation constraint. Held on the EmailDelivery for every brief that was sent, and added up on the BriefJobRun for every pass of the job. It exists because a written summary and a quoted one are the same document to a reader, so nothing a User can see distinguishes a feature that is working from a deployment whose credential expired; the report is the only place that can be noticed. Never part of a BriefSnapshot, which is a document and is served forever.
_Avoid_: stats, telemetry, metrics

**BriefPlan**: A selection and ordering of Clusters for a Topic at a moment in time. The regenerable artifact that BriefSnapshots and LivingBriefs are derived from.
_Avoid_: brief, digest

**BriefSnapshot**: An immutable, linkable rendering of a BriefPlan — the form of a brief that is emailed. Once sent, does not change. Retained forever regardless of tier, since it is what was sent.
_Avoid_: email brief, sent brief

**LivingBrief**: The in-app rendering of a Topic's current BriefPlan. Regenerates as the Topic's Clusters change.
_Avoid_: feed, topic view

**Brief**: The conceptual product artifact. A specific instance is either a BriefSnapshot (email) or a LivingBrief (in-app), both produced from a BriefPlan.
_Avoid_: digest, summary, newsletter

**EmailDelivery**: A record that a BriefSnapshot was emailed to a User. Carries the per-Topic and global one-click unsubscribe tokens the brief went out with, and is what those tokens are looked up on. Distinct from the BriefSnapshot so a snapshot can be re-sent, re-linked, or unsubscribed from.
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
_Avoid_: dashboard stats, summary

### State

**Active (Cluster)**: A Cluster's state while it is still picking up Stories — while its velocity (Stories per unit time) is above a threshold. Active Clusters appear in LivingBriefs and in new BriefPlans. A Cluster that stops getting covered loses Active on its own, rather than being switched off.
_Avoid_: live, current

**Retired (Story)**: A Story's state once none of its Clusters is Active. Retired Stories are retained per tier but are not surfaced in new Briefs.
_Avoid_: dead, expired

**Archive**: The persisted history of Clusters, BriefSnapshots, Articles, Stories, and FeedbackEvents beyond their active lifetime, held per Topic so it is one User's and no other's. Searchable by the User, by whole words through a full-text index. Retention is tiered, with BriefSnapshots exempt (retained forever).
_Avoid_: history, log

### Onboarding & discovery

**Directory**: The curated set of TopicTemplates Brieflyy ships. A User selecting a Directory entry clones it into a per-user Topic.
_Avoid_: catalog, library

**DiscoverTab**: The in-app surface showing Directory entries, "topics like yours" Recommendations, and "trending this week" — used to find and add Topics. One Directory entry is cloned at a time, not three. See ADR-0014.
_Avoid_: explore, browse

**Recommendation**: A suggested Topic surfaced in DiscoverTab, derived from the User's existing Topics' Entity and Source overlap. Each distinct Entity and each distinct Source shared counts once.
_Avoid_: suggestion, related topic

**Mention volume**: How many Articles a Source published inside the measured window. What "trending" is computed from; a Directory entry's mention volume is the sum over its Sources, each counted once. See ADR-0014.
_Avoid_: popularity, buzz, score

### Monetization

**FreeTier**: 3 Topics, realtime briefs, 30-day retention on Archive (Clusters, Retired Stories, FeedbackEvents), BriefSnapshots retained forever, trends rollup visible only for the last 3 days.
_Avoid_: free plan, basic

**PaidTier**: $15/mo. Unlimited Topics, indefinite Archive retention, BriefSnapshots retained forever, full trends history. The trends layer is the paid differentiator.
_Avoid_: pro, premium
