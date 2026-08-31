# Brieflyy

A SaaS tool that aggregates content around user-specified topics, clusters related items, summarizes them via AI, and surfaces the most relevant ones in a personalized brief feed with insights and visual trends.

## Language

### Identity

**User**: A human who has signed up for Brieflyy. One account = one human.
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

**Topic**: A user-scoped interest that scopes all aggregation, clustering, and briefing for a single user. Created from a TopicTemplate or from a free-form phrase. Has its own source list, cadence, and feedback history.
_Avoid_: subject, interest, feed

**Source**: A news outlet or RSS feed in the curated Brieflyy registry. Each Topic has a curated default source list that the user can edit.
_Avoid_: outlet, publisher, feed (when meaning a Source, not an RSS document)

**Article**: A single ingested document from a Source. The atomic input to the pipeline.
_Avoid_: post, item, document

**Entity**: A named thing (person, organization, place, product, or concept) extracted from an Article by named-entity recognition. The key used for Cluster overlap and the unit of Trends.
_Avoid_: tag, keyword, named entity

**Story**: A deduped event — a group of near-duplicate Articles (same Entities and key phrases) within a 48–72h window. The working unit of the pipeline; the user never sees a Story directly.
_Avoid_: event, article group

**Cluster**: The unit the user sees. A grouping of related Stories by Entity overlap, within a 7d window (per-topic tunable). Receives Feedback and is the target of Summarization.
_Avoid_: story, topic, thread

**BriefPlan**: A selection and ordering of Clusters for a Topic at a moment in time. The regenerable artifact that BriefSnapshots and LivingBriefs are derived from.
_Avoid_: brief, digest

**BriefSnapshot**: An immutable, linkable rendering of a BriefPlan — the form of a brief that is emailed. Once sent, does not change. Retained forever regardless of tier, since it is what was sent.
_Avoid_: email brief, sent brief

**LivingBrief**: The in-app rendering of a Topic's current BriefPlan. Regenerates as the Topic's Clusters change.
_Avoid_: feed, topic view

**Brief**: The conceptual product artifact. A specific instance is either a BriefSnapshot (email) or a LivingBrief (in-app), both produced from a BriefPlan.
_Avoid_: digest, summary, newsletter

**EmailDelivery**: A record that a BriefSnapshot was emailed to a User. Carries per-topic unsubscribe state and an RFC 8058 one-click token. Distinct from the BriefSnapshot so a snapshot can be re-sent, re-linked, or unsubscribed from.
_Avoid_: email log, sent mail

### Engagement

**FeedbackType**: An enum of the explicit signals a User can give — `ThumbsUp`, `ThumbsDown`, `HideSource`, `MoreLikeThis`, `LessLikeThis`.
_Avoid_: reaction type, vote type

**Feedback**: An explicit signal a User gives on a Cluster, of a single FeedbackType. Recorded once per Cluster and propagated to the underlying Stories and Articles for ranking.
_Avoid_: reaction, vote, signal

**FeedbackEvent**: The persisted record of a single piece of Feedback. Carries the FeedbackType, target Cluster, target Scope (this topic only vs global, for HideSource), and timestamp.
_Avoid_: feedback log, reaction record

**Cadence**: A Topic-level schedule — daily, weekly, or never. Evaluated against the User's DeliveryTime.
_Avoid_: schedule, frequency

### Trends

**TrendWindow**: A 7d observation window compared against a prior 30d baseline, used to compute entity-level lift for a Topic.
_Avoid_: window, period

**EmergingEntity**: An Entity whose mention rate within a Topic's Articles shows significant lift in the current TrendWindow vs the prior baseline. Surfaced in the trends view and the "across your topics" rollup.
_Avoid_: trending topic, hot entity

### State

**Active (Cluster)**: A Cluster's state while its velocity (Stories per unit time) is above a threshold. Active Clusters appear in LivingBriefs and in new BriefPlans.
_Avoid_: live, current

**Retired (Story)**: A Story's state once none of its Clusters is Active. Retired Stories are retained per tier but are not surfaced in new Briefs.
_Avoid_: dead, expired

**Archive**: The persisted history of Clusters, BriefSnapshots, Stories, and FeedbackEvents beyond their active lifetime. Searchable by the User. Retention is tiered, with BriefSnapshots exempt (retained forever).
_Avoid_: history, log

### Onboarding & discovery

**Directory**: The curated set of TopicTemplates Brieflyy ships. A User selecting a Directory entry clones it into a per-user Topic.
_Avoid_: catalog, library

**DiscoverTab**: The in-app surface showing Directory entries, "topics like yours" Recommendations, and "trending this week" — used to find and add Topics.
_Avoid_: explore, browse

**Recommendation**: A suggested Topic surfaced in DiscoverTab, derived from the User's existing Topics' Entity and Source overlap.
_Avoid_: suggestion, related topic

### Monetization

**FreeTier**: 3 Topics, realtime briefs, 30-day retention on Archive (Clusters, Retired Stories, FeedbackEvents), BriefSnapshots retained forever, trends rollup visible only for the last 3 days.
_Avoid_: free plan, basic

**PaidTier**: $15/mo. Unlimited Topics, indefinite Archive retention, BriefSnapshots retained forever, full trends history. The trends layer is the paid differentiator.
_Avoid_: pro, premium
