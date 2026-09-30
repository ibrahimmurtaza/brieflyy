# The leading Clusters of a brief are written; every other Cluster is quoted

A `BriefSnapshotRenderer` is given an `LLMSummaryClient` and, for the leading Clusters of the BriefPlan, replaces the Cluster's own Cluster summary with a Written summary: a one-liner and bullets, each bullet citing one Article of that Cluster. Every other Cluster — the rest of the plan, a Cluster whose call failed, and every Cluster when the deployment has no key configured — is quoted from the Cluster summary as before.

## Why only the leading Clusters

The plan is already ordered, most active first, so "the top" is a decision it made. The renderer slices that order to N (`BRIEF_GENERATED_CLUSTERS`, default five) and iterates the slice, so the number of calls a brief can cost is a property of the plan rather than of how a counter happened to break. A brief that carries more Clusters than N is a brief whose tail is quoted and whose head is written, which is also why the plan's own size is a separate setting (`BRIEF_MAX_CLUSTERS`, default five): the reading decision and the cost decision are different decisions, and hardcoding both to the same number meant neither could be moved without moving the other.

Two bounds sit on top of the count, both a deployment's to move
(`BRIEF_GENERATION_CALL_TIMEOUT_MS`, `BRIEF_GENERATION_BUDGET_MS`): each call is abandoned at the first, and the brief as a whole stops asking once the second is spent, measured on an injected `Clock` rather than `Date.now()` so the promise a brief makes to its Users is a promise a test can check. The call bound may not exceed the budget, and boot refuses a pair that does — a call that can outlive the budget makes the budget a number that only exists on paper. Both quote the remainder rather than failing: a brief is due to a User on a schedule, and the schedule does not move for one slow call. A written top-N larger than the plan carries writes the whole plan, which is the only reading of the two numbers together that means anything.

## Why a brief reports what writing it cost

The path degrades quietly on purpose, and every way it degrades still produces a perfect brief: no credential, a failed call, a spent budget, a citation that did not hold. A brief that is entirely quoted and a brief that is entirely written are the same document to a reader, so nothing a User can see distinguishes a deployment whose credential expired from one that never asked for the feature — and a discarded citation is invisible even in the document, because a Cluster that lost two of its five bullets looks like a Cluster that had three.

So the client counts what it throws away, the renderer adds up what it spent, and the pass of the daily job records three numbers: Clusters written, write calls, and bullets discarded. They are three rather than one status because they are three different problems — no calls and nothing written is the feature switched off, calls and nothing written is the feature broken, written Clusters with discarded bullets is the feature working on an answer nobody can check. A call is counted when it is made rather than when it succeeds, because a failed call is the most expensive kind to under-report.

The report is carried out of `render()` and on `SendBriefResult` rather than logged, because the caller is the only thing that knows a brief happened at all, and it stops at the pass: nothing about it reaches the document. A BriefSnapshot is stored and served forever, so a number about how the machine built it would outlive its usefulness and belong to a page a User is not on.

## Why a bullet that cites anything else is discarded

The citation constraint is the whole reason a written line can appear in a brief at all. A Cluster summary is quotable by construction — every line is a sentence an Article in that Cluster actually contains — and a written line is not, so the only thing standing between a written brief and an invented one is that each bullet names an Article of that Cluster and a bullet naming anything else is thrown away. A Cluster whose bullets all fail the constraint gets no written summary at all rather than a heading over an empty list, so the answer is always either a complete written summary or the quoted one — and that rule is the renderer's, not any one client's, because a client that returned a heading over an empty list would otherwise be a rendering bug waiting for a second implementation.

The Articles offered are the Cluster's own, loaded by `listArticlesByClusterId` against the Topic's Sources. A client handed the whole Topic's reading could satisfy every citation it is given and the constraint would say nothing. The URL scheme is not part of the constraint: a bullet citing an Article with a `javascript:` URL is a real citation of a real Article, so the scheme is checked where the anchor is built.

## Why a LivingBrief never carries one

A LivingBrief regenerates as the Topic's Clusters change, so a written summary on it would be a different sentence each time the User looked, about the same Cluster, alongside a Cluster summary that does not change at all. It would also cost a call per page view, on a page that costs nothing to serve. So writing happens once, at send time, into a BriefSnapshot — which is stored and never regenerated, so what the User reads in the app in six months is the text that was emailed. The page and the email are then about the same Cluster in the same words, because the page is still quoted.

## Why the client is the entrypoint's to hold

`createLLMSummaryClient` returns `null` when no `OPENAI_API_KEY` is configured, and `createApp` treats a missing client as "do not spend this brief's budget finding out". A brief built entirely from the extractive summary is a complete brief, so there is nothing to fail on and nothing to report, and no key is not a degraded mode of the product. The client is built by `server.ts` and handed to `createApp` rather than constructed inside it, because a developer with a key in their environment would otherwise have every test in the suite reach for the network.

## What this supersedes

The glossary says a Cluster summary is "never written afresh". That still holds of the **Cluster summary** — it is what a Cluster is shown with everywhere, what a failed call falls back to, and what a LivingBrief shows. What is written afresh is a **Written summary**, which is a different thing with a different owner, and the distinction is now in the glossary rather than parked in a comment in `src/app.ts`.
