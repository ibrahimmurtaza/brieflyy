# Brieflyy — UI/UX Audit & Improvement Plan

**A snapshot, not a baseline.** Everything below describes the application at the
base commit named in the header. Where it says something is absent, check it
against the code before acting on it: the app shell, the design-token layer and the
Playwright suite this plan asked for have all landed since (issues #46 and #51), so
several findings here are closed. Nothing below was re-verified as part of the
documentation reconciliation in #52, because a dated audit is allowed to be a
dated audit.

**Date:** 2026-09-29 · **Branch:** `feature/14-archive-search` · **Base commit:** `e825016`
**Scope:** Read-only when written. Phase 1 and the Phase 2 foundation were
implemented afterwards; see §8 for the six decisions and what each one became.

---

## 1. Executive summary

Brieflyy is a Fastify + server-rendered-HTML SaaS. Every screen is a hand-written HTML
string returned from a TypeScript function; there is no frontend framework, no build
step for assets, no CSS file, and no design system. **The application has 16 separate
HTML documents containing 13 separate `<style>` blocks and 71 hardcoded hex colour
values in a single file, and zero CSS custom properties** (`src/pages/routes.ts`).

The engineering is considerably stronger than the interface. The empty-state logic
(`emptyStateBlock`, `routes.ts:1118`) correctly distinguishes four different "nothing
to show" situations; the delivery-time screen uses native `<details>` so it works
without JavaScript; the picker validates against a live cap; and the feedback-hide
model carefully separates "filterable" from "persisted". Those behaviours are the
assets this plan protects.

The interface problems fall into four groups:

1. **Dark mode is declared but not implemented.** Seven pages set
   `color-scheme: light dark` and not one declares a dark-mode style. On any device with
   the OS in dark mode, `#555` body text lands on a black canvas at **2.7:1** and three
   white-background controls inherit white text and become **completely invisible**.
2. **Accessibility foundations are absent.** No `:focus` rule exists anywhere in the
   repository. No landmark elements, no skip link, no `aria-label` on icon-only
   buttons, no `role="alert"` on errors. One of 5 topic-page action buttons is ~20×22px
   against a WCAG 2.5.8 AA floor of 24×24px.
3. **Layout is unconstrained.** 6 of 8 in-app pages have no viewport meta tag, so the
   entire onboarding funnel renders at 980px on a phone. The delivery-time form puts
   three controls in a fixed `1fr 1fr 2fr` row with no mobile fallback.
4. **A raw enum is leaking into the UI.** Free-form topics are stored with
   `category: 'unspecified'` and rendered verbatim, so the two most-used screens show
   the literal word "unspecified" next to any topic the user typed themselves.

There is also one **functional defect surfaced by the UI audit**: the BriefSnapshot
email renders unsubscribe links containing a literal `TOKEN` placeholder, and no
`/unsubscribe/*` route exists in the application.

**Recommendation:** adopt the three-phase roadmap in §6. Phase 1 (quick wins) contains
12 items that are individually small, almost entirely test-neutral, and fix every
Critical and most High finding. Phase 2 establishes the design-token and layout-shell
substrate. Phase 3 is the product-level redesign of the LivingBrief.

---

## 2. Assumptions stated explicitly

| # | Assumption | Why it matters |
|---|---|---|
| A1 | **No brand guidelines exist.** There is no `docs/brand-guidelines.md`, no `assets/design-tokens.*`, and no logo asset. `#1f6feb` is treated as the de facto brand blue. | If a real brand palette exists, Phase 2 token values change but the token *architecture* does not. |
| A2 | **Target users are knowledge workers reading news digests**, on desktop primarily, phone secondarily, and by email above all. | Drives typography, measure, and information density recommendations. |
| A3 | **English only, LTR only.** Every page declares `lang="en"`. | No RTL or i18n work is in scope; a token layer should not block adding it later. |
| A4 | **No framework migration is proposed.** The recommendation is a shared static stylesheet plus a shared layout function, both plain TypeScript + CSS. | Justified in §6 Phase 2: it removes 13 duplicated style blocks with zero new dependencies and zero route changes. |
| A5 | **`pnpm verify` (`typecheck && vitest run && secrets:check`) is the regression gate.** Playwright specs exist but are wired into **no npm script** and are excluded from `vitest.config.ts` (`include: ['src/**/*.test.ts']`). | Anything not covered by a vitest suite is unguarded; §7 accounts for this. |
| A6 | **Billing is not connected** (stated in `routes.ts:873` and asserted by `routes.test.ts:115`). | `/upgrade` is a real page by design, not a placeholder bug. |
| A7 | The four-category ordering in `pickTopicsPage` (`routes.ts:482`) intentionally matches `TOPIC_CATEGORIES` minus `'unspecified'` (`types.ts:3`). | Duplication, not a bug — but see L10. |

---

## 3. Skills found in `.agents/skills/` and how each is applied

32 skills are installed. Eight are UI/UX-relevant; I read the six directly applicable
in full and skimmed the router.

| Skill | Relevance | How it is applied in this audit |
|---|---|---|
| **`ui-ux-pro-max`** | **Primary.** Ships a searchable dataset: 119 UX guidelines, 192 palettes, 74 font pairings, 105 icons, 22 stack profiles. | I ran its `search.py` CLI (Python 3.14.5 present) for `--design-system`, and for `--domain ux` on *error summary validation*, *focus/keyboard navigation*, *empty state*, *loading/skeleton*, *touch target size*, *contrast*, *line length*, *dark mode*, and *color-only*. Its severity ratings are quoted in the findings (§4). Its design-system run for "SaaS news briefing" returned **Minimalism & Swiss Style** + a **Newsreader/Roboto editorial pairing** — both adopted; its *Hero-Centric landing pattern* and red palette were **rejected** as marketing-page output not applicable to a signed-in reading app. |
| **`ui-styling`** | Tailwind + shadcn/ui. **Its stack recommendation is not applicable** — Brieflyy has no bundler, no Tailwind, no React, and adding any of them would be a framework change. | Applied for its *principles only*: mobile-first responsive layout, design tokens over arbitrary values, semantic HTML, visible focus states, consistent icon family. All of these are achievable in a plain stylesheet. Its Radix/shadcn component recommendations are explicitly **not** carried forward. |
| **`design-system`** | Token architecture. | Its three-layer model — **primitive → semantic → component** — is adopted verbatim as the structure of the proposed `src/pages/styles.css`. Its `states-and-variants` spec table (Default/Hover/Active/Disabled per property) is the template for the button and input state matrix in §6 Phase 2. Its "never use raw hex in components" rule is Finding **H1**. |
| **`brand`** | Brand voice, palette, guidelines. | Read; found nothing to apply because **no brand artifacts exist in the repo** (recorded as A1). Its role in this audit is to establish the *absence* as a finding. |
| **`design`** | Router over brand / tokens / UI / logo / slides / banners / social photos. | Read as a router. Its sub-skills for logo, CIP, banners, slides, social photos, and icon-image generation are **out of scope** for an in-app audit. Its "New Design System" workflow (brand → tokens → implement) informed the Phase 2 ordering. |
| **`prototype`** | Throwaway prototypes to answer a design question. | Relevant to the **Larger redesigns** in §6.4: the LivingBrief redesign and the onboarding wizard should be prototyped and reviewed before implementation, per this skill's stated purpose. |
| `ask-matt` | Skill router. | Read; used to confirm the above eight are the full relevant set. The remaining 24 (triage, grilling, TDD, research, wayfinder, code-review, …) are process skills with no UI/UX content. |
| `banner-design`, `slides`, `teach` | Marketing assets and HTML presentations. | Read and **excluded** — no banner, deck, or teaching surface exists in this product. |

---

## 4. The "do not break" inventory

This is the contract. Every item below is currently asserted by a test and must keep
working. **Nothing in the roadmap may change a route path, a method, a status code, a
redirect target, a form field name, or any of the strings in §4.3** without a
deliberate, separately-approved decision.

### 4.1 Routes (all must keep their path, method, and access level)

`src/http/route-guard.test.ts` enumerates the real app and fails the build if any
route lacks an `access` declaration, if a public route is missing from
`PUBLIC_ROUTES` (`src/http/access.ts:24`), or if a non-public route answers an
anonymous request with anything other than `401` or `302 → /signup`.

Every POST in this table is also behind the cross-site guard: it declares
`stateChange: 'guarded'`, and `src/http/write-guard.ts` refuses a submission whose
form does not echo the request token the application set in an httpOnly cookie —
in a page saying so, not a bare status. So a POST here is driven by a form on a
Brieflyy page and not by a page on another site. The three exceptions are named in
`WRITE_GUARD_EXEMPTIONS` (`src/http/access.ts`) with the reason each one cannot be:
the two one-click unsubscribes (a mail client has no Brieflyy page to carry a
field) and `POST /auth/magic-link/request` (its caller is the sign-in page's own
script, and there is no signed-in User whose page could carry the field).
`src/http/write-guard.test.ts` holds the application to both lists. See ADR-0022.

| Method | Path | Access | Notes |
|---|---|---|---|
| GET | `/` | public | 302 → `/signup` |
| GET | `/signup` | public | magic-link form + Google button |
| POST | `/auth/magic-link/request` | public | 202 / 400 / 429 + `Retry-After` |
| GET | `/auth/magic-link/verify` | public | 302 → post-signin path, or 400 HTML |
| POST | `/auth/logout` | public | 302 → `/` |
| GET | `/auth/google/start` | public | 302 → accounts.google.com |
| GET | `/auth/google/callback` | public | 302 or 400 HTML |
| GET | `/api/onboarding/templates` | public | JSON |
| GET | `/onboarding/pick-topics` | auth | 302 → `/pick-topics` if onboarded |
| GET | `/pick-topics` | auth | topic management |
| GET | `/onboarding/delivery-time` | auth | 302 → `/settings/delivery` if set |
| GET | `/onboarding/welcome` | auth | 302 → `/onboarding/delivery-time` if unset |
| GET | `/settings/delivery` | auth | `?saved=1` confirmation |
| GET | `/upgrade` | auth | 200; **no `<form>` allowed** |
| GET | `/archive/search` | auth | placeholder |
| GET | `/topics` | auth | home / topic list |
| GET | `/topics/:slug` | auth | LivingBrief; `?source=`, `?hide=` |
| POST | `/topics/:slug/feedback` | auth | 5 feedback types, `scope` |
| POST | `/topics/:slug/cluster-window` | auth | 302 back, or 404 |
| POST | `/onboarding/pick-topics` | auth | 302 / 400 / 402 |
| POST | `/pick-topics` | auth | 302 → `/topics`, 400, 402 |
| POST | `/pick-topics/remove` | auth | 302 → `/pick-topics`, 404 |
| POST | `/onboarding/delivery-time` | auth | 302 → `/onboarding/welcome`, 400 |
| POST | `/settings/delivery` | auth | 302 → `/settings/delivery?saved=1`, 400 |
| POST | `/api/ingest/tick`, GET `/api/ingest/status`, GET `/admin/ingest` | auth | admin; count is asserted `toBe(3)` |
| POST | `/dev/tier` | auth | dev-tools only; absent when disabled |

### 4.2 Form fields and endpoints (name-level contract)

The URL-encoded parser in `app.ts:108` builds these; renaming any of them breaks a
route and its test.

`templateIds` · `freeformTitle` · `slug` · `hour` · `minute` · `timezone` ·
`windowDays` · `clusterId` · `type` · `scope` · `email` · `requestToken`

`requestToken` is the hidden field every form on a signed-in page carries and the
cookie the application set has to agree with; a POST that omits it is refused
before the route reads the body.

### 4.3 Assertions that constrain the markup itself

These are the fragile ones. **A redesign that changes any of them will fail a test
that is asserting behaviour, not appearance** — the test should be updated in the
same commit, deliberately.

| # | Assertion | File:line | Constraint |
|---|---|---|---|
| C1 | `/<p class="filter-bar">(.*?)<\/p>/s` | `pages/topic-page.test.ts:171` | Must remain a `<p>` with that exact class, no extra attributes, no nested `<p>` |
| C2 | `expect(resp.body).not.toMatch(/<form/)` on `/upgrade` | `pages/routes.test.ts:115` | **A shared nav containing a logout form will break this.** `/upgrade` must have no form. |
| C3 | `expect(body).not.toMatch(/<script/)` on both delivery-time pages | `onboarding/routes.test.ts:429, 469` | A shared layout that loads a JS bundle will break this. |
| C4 | `/<button type="submit" disabled>Add topics<\/button>/` | `onboarding/routes.test.ts:832` | Exact tag, exact attribute order, no added classes or `aria-*` |
| C5 | `/<details class="change" id="change-delivery">/` | `onboarding/routes.test.ts:463` | Exact tag, exact attribute order |
| C6 | `/name="templateIds"[^>]*disabled/` | `onboarding/routes.test.ts:831, 843` | `disabled` must appear **after** `name` in the same tag |
| C7 | `/name="slug" value="([^"]*)"/g` | `onboarding/routes.test.ts:93` | The only way 7 tests read a user's topics. A second `name="slug"` control anywhere inflates every count. |
| C8 | `/name="windowDays"[^>]*value="7"/` | `pages/topic-page.test.ts:449` | `value` must come after `name` |
| C9 | `/arrives daily at <strong>08:00<\/strong> \(America\/New_York\)/` | `onboarding/routes.test.ts:460, 497, 748` | Exact tag sequence and spacing |
| C10 | every `href` containing `upgrade` must be exactly `/upgrade` and return 200 | `pages/tier-pages.test.ts:82, 182` | No `?from=nav`, no relative form |
| C11 | `expect(body).not.toMatch(/new\|existing\|sentTo/i)` | `auth/routes.test.ts:104` | Magic-link response must not reveal account existence |
| C12 | `PUBLIC_ROUTES` set equality with declared public routes | `http/route-guard.test.ts:105, 110` | A new public page must be allowlisted |
| C13 | `expect(admin.length).toBe(3)` | `http/route-guard.test.ts:117` | Do not add a 4th admin route |
| C14 | `toHaveAttribute('rel', 'noopener')` — exact | `tests/e2e/brief-snapshot-llm.spec.ts:79` | Would fail on `noopener noreferrer` |
| C15 | `page.locator('li a[href="…"]')` must be visible | `tests/e2e/brief-snapshot-llm.spec.ts:76` | An LLM bullet must stay an `<li><a>` |

Plus the copy contract: `No stories yet for this topic` · `0 active clusters` ·
`No clusters match` · `Show all N active cluster(s)` · `you hid all N active cluster` ·
`Free plan` / `Paid plan` · `free-topic limit` · `Free Brieflyy includes unlimited
topics` · `$15 / month` · `Billing isn't connected yet` · `Sign in to Brieflyy` ·
`Sign in with Google` · `href="/auth/google/start"` · `id="email"` ·
`Pick your topics` · `Save topics` / `Add topics` · `Pick up to N more topic(s)` ·
`Its past briefs are kept` · `arrives daily at` · `Change delivery time` ·
`Save and continue` / `Save time` · `Time saved.` · `You're set up` ·
`first brief arrives` · `Invalid sign-in link` · `Sign-in failed` ·
`Welcome to Brieflyy` (email subject) · `Your first brief will arrive` ·
`unlimited topics` · `you are using N topics` · `up to 3 topics` · `Cluster window` ·
`valid time` · `Please pick exactly 3 topics.` · `Pick at least one topic.` ·
`more than once` · `not in the Directory` · `0 topics`.

**No test asserts on any `<style>` block, any CSS property, or the `<meta name="viewport">`
tag.** Extracting all CSS into a shared stylesheet is therefore free.

### 4.4 Feature and flow inventory

1. Magic-link sign-in (request → 202 → email → verify → session cookie → post-signin redirect)
2. Google OAuth sign-in (start → callback → session; four distinct error messages)
3. Session management and sign-out
4. Per-address and per-caller rate limiting on magic-link requests
5. Onboarding: topic selection (Directory templates + free-form, exactly 3)
6. Onboarding: delivery-time selection (hour / minute / timezone)
7. Onboarding: welcome confirmation
8. Topic management: add, remove, cap enforcement, paywall at 3 (free tier)
9. Topic list / home with tier badge and plan usage
10. LivingBrief (`/topics/:slug`): Active Cluster rendering, one-liner + bullets
11. LivingBrief: Source filter (`?source=`) with a way out
12. LivingBrief: per-request hide (`?hide=`) vs persisted hide (Feedback) — deliberately distinct
13. LivingBrief: four distinct empty states
14. LivingBrief: cluster-window tuning (1–14 days)
15. Feedback: all five `FeedbackType`s, plus `scope` for `HideSource`
16. Tier gate + `/upgrade` page
17. `/archive/search` placeholder route
18. `/api/onboarding/templates` JSON
19. Admin ingest routes (guarded)
20. Dev-only tier switch
21. Welcome email
22. BriefSnapshot rendering (LLM path + extractive fallback) and the email's "View in app" link

---

## 5. Findings

Severity is user impact against the "do not break" list, not effort.

### 5.1 CRITICAL

---

**C1 — Dark mode is declared but never implemented; three controls become invisible**

*Where:* `color-scheme: light dark` is set at `src/pages/routes.ts:379, 554, 740, 807,
854, 945, 1060` — and **nowhere else in the repository is there a
`prefers-color-scheme` media query or a dark-mode declaration.**

*What's wrong:* The declaration tells the browser "this page supports both schemes", so
the UA repaints the canvas dark and flips the default text colour to white. Every
explicitly-coloured style in the page is written for a white canvas and is not
corrected. Three results:

- `p.lede { color: #555 }` (`routes.ts:382, 557, 743, 948, 1063`) renders **#555 on
  the dark canvas ≈ 2.7:1** — fails WCAG AA (4.5:1) by a wide margin.
- `input, select { … background: white; color: inherit }` (`routes.ts:746`) — in dark
  mode `inherit` resolves to the body's white default, so the Hour, Minute and Timezone
  fields are **white text on a white background. Completely invisible.**
- `a.google { … color: inherit; background: white }` (`routes.ts:393`) — the
  "Sign in with Google" button, same failure.
- `form.remove button { … background: white; color: inherit }` (`routes.ts:574`) — the
  "Remove" button on `/pick-topics`, same failure.

*Why it hurts:* Roughly a third of users run their OS in dark mode. For them the signup
form has one invisible primary action, the delivery-time form has three invisible
fields, and body copy is unreadable at 2.7:1. This is an activation-blocking defect on
the path the README documents as the first thing to try.

*Fix:* Two options, and the decision belongs to you:
- **1a (recommended for Phase 1, ~15 min):** delete the seven `color-scheme` lines. The
  app then renders light-only, correctly, everywhere. Costs nothing, breaks no test.
- **1b (Phase 2):** build the token layer with a real dark palette. See §6.2.

*Effort:* 1a = 15 min. 1b = included in Phase 2.

---

**C2 — No visible focus indicator exists anywhere in the application**

*Where:* A repository-wide search for `:focus`, `outline`, and `focus-visible` across
`src/**/*.ts` returns **zero** CSS rules.

*What's wrong:* No page, no control, no state defines a focus style. Several controls
are explicitly styled in ways that suppress the browser default: `button { border: 0 }`
(`routes.ts:386, 567, 748, 959, 1084`), and the 5 feedback buttons
(`routes.ts:1027-1031`) which set a background, a border and a border-radius but no
`outline` policy.

*Why it hurts:* WCAG 2.4.7 Focus Visible (AA) is a hard failure. A keyboard-only or
switch-device user tabbing through `/topics/:slug` passes **6 controls per cluster**
before reaching the next one and has no way to know which is focused. On the topic page
this compounds — see C5.

*Fix:* One global rule in the new stylesheet, scoped to `:focus-visible` so pointer
users are unaffected:
```css
:where(a, button, input, select, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
```
`ui-ux-pro-max` rates "Focus States" **High** and "Focus Not Obscured (Minimum)" — the
WCAG 2.2 AA requirement that a sticky header must not cover the focused element —
**High**.

*Effort:* 30 min including verification.

---

**C3 — Mojibake in every page `<title>` and in the topic list**

*Where:* Seven lines in `src/pages/routes.ts` — **213, 552, 738, 827, 931, 943, 1189**.

*What's wrong:* The UTF-8 middle dot `·` (U+00B7) is stored in source as the two
characters `Â·` (U+00C2 U+00B7) — a double-encoding artefact. Verified by decoding the
file bytes as UTF-8 and matching the code points. The affected lines are the
`<title>` of `/archive/search`, the topic picker, the delivery-time screen, the welcome
screen, `/topics`, the not-found page, and the topic-row separator on `/topics`.

*Why it hurts:* Every browser tab, bookmark, browser history entry, and search result
for Brieflyy displays "Brieflyy" preceded by garbage characters. It is the first
credibility signal the product gives and it is broken on all 8 pages. A paying
customer's own bookmark reads `Â· Brieflyy`.

*Fix:* Replace the two-code-point sequence with U+00B7 (or, better, use the HTML
entity `&middot;` so the source is ASCII-safe and cannot re-break).

*Effort:* 15 min. **No test asserts on any `<title>`** — zero regression risk.

---

**C4 — The BriefSnapshot email is unstyled, and its unsubscribe links are placeholders pointing at routes that do not exist**

*Where:* `src/services/brief-snapshot-renderer.ts:60-87`, specifically line 86.

*What's wrong:* Three compounding problems in the product's primary delivery surface:

1. **Dead unsubscribe links.** Line 86 emits
   `<a href="${appBaseUrl}/unsubscribe/topic?t=${plan.topicId}&token=TOKEN">` and
   `…/unsubscribe/all?token=TOKEN`. The literal string `TOKEN` is a placeholder, and a
   repository-wide search confirms **no `/unsubscribe/*` route is registered anywhere**.
   A user clicking Unsubscribe in a delivered email gets a 404. Bulk commercial email
   requires a working, honoured unsubscribe mechanism; this is a compliance defect as
   well as a UX one.
2. **No styling whatsoever.** No `<!doctype html>`, no viewport meta, no CSS, no
   max-width wrapper, no table layout, no `lang` attribute, no Outlook fallbacks. Email
   clients that require inline or `<style>`-in-`<head>` CSS will render it as raw
   stacked headings.
3. **The brief's identity is `<h1>Brief</h1>`.** The emailed artifact — the thing the
   user actually subscribed for — carries no brand, no topic title as its heading (the
   title is `Brief for ${plan.topicId}`, an internal ID), and no date.

Separately, line 62 interpolates `appBaseUrl` into an `href` **without** `escapeHtml`,
while line 72 escapes the per-bullet URLs. Currently server-controlled, so not
exploitable, but it is the only place in the app where a value lands in an attribute
unescaped.

*Why it hurts:* The email is the product. CONTEXT.md defines `BriefSnapshot` as "the
form of a brief that is emailed… retained forever." An unstyled, unbranded, un-unsub-
scriable email is the largest single gap between what the app promises and what it
delivers.

*Fix:* Split by intent — this is **part design, part missing functionality**, and the
functional part needs your decision:
- *Design (in scope, Phase 2):* doctype, viewport, inline styles, 600px max-width,
  topic title as `<h1>`, brand wordmark, date, readable type scale, accessible link
  colour.
- *Functionality (needs your call, out of scope for a visual pass):* either implement
  `/unsubscribe/topic` and `/unsubscribe/all` with real RFC 8058 one-click tokens, or
  remove the footer until they exist. **Do not ship a live-looking dead unsubscribe
  link.** I will not touch this without your decision.

*Effort:* Design 3 h. Functionality: unknown — a separate ticket.

---

**C5 — The entire onboarding funnel and every error page lack a viewport meta tag**

*Where:* `<meta name="viewport" content="width=device-width, initial-scale=1">` appears
exactly twice in the application — `src/pages/routes.ts:942` (`/topics`) and
`:1057` (`/topics/:slug`). It is **absent** from `signupPage` (372), `pickTopicsPage`
(459), `deliveryTimePage` (664), `welcomePage` (790), `upgradePage` (836),
`notFoundPage` (1182), the archive-search placeholder (212), all four error pages in
`src/onboarding/routes.ts`, both error pages in `src/auth/routes.ts`, and
`signInRequiredPage` in `src/http/access.ts:87`.

*What's wrong:* Without it, mobile browsers lay out at a nominal 980px CSS width and
scale down. Every `<input>` on the page renders at roughly a third of its intended
physical size, and the two pages that *do* declare it (`/topics`, `/topics/:slug`)
already prove the app is meant to be responsive.

*Why it hurts:* A phone user reaching `/signup` — the screen the README tells you to
open first — gets a desktop form shrunk to fit, with 16px text at ~5px effective size
and a primary button far below any usable touch target. It is the single highest-value
one-line fix in the audit. WCAG 1.4.4 (Resize Text) and 1.4.10 (Reflow).

*Fix:* Add the tag to all 14 page templates. Better: emit it from one shared `<head>`
helper (§6.2) so it cannot be forgotten again.

*Effort:* 30 min. **No test asserts on the viewport tag** — zero regression risk.

---

**C6 — The user's own free-form topics display the literal string "unspecified"**

*Where:* `src/onboarding/onboarding-service.ts:306` creates free-form topics with
`category: 'unspecified'` (asserted at `onboarding-service.test.ts:178`).
`src/pages/routes.ts:931` renders `<span class="muted"> · ${escapeHtml(t.category)}</span>`
on `/topics`, and `routes.ts:1090` renders
`Signed in as ${safeEmail} · ${escapeHtml(input.topic.category)} · … active clusters`
on the topic page.

*What's wrong:* The internal sentinel is emitted straight to the user. Any topic the
user typed themselves — the "Or add your own" free-form field that both picker screens
advertise — displays as "fusion energy · unspecified", and its LivingBrief header reads
"Signed in as you@x.com · unspecified · 3 active clusters".

*Why it hurts:* It appears on the two most-used screens, it is the direct product of a
feature the app promotes, and it reads as data corruption. It is also invisible to the
test suite, because every test fixture creates its topic from a Directory template.

*Fix:* Omit the category segment when it is `'unspecified'`, in both renderers. This is
a display-layer change; the stored value stays exactly as it is, so
`onboarding-service.test.ts:178` continues to pass.

*Effort:* 20 min.

---

### 5.2 HIGH

---

**H1 — No design tokens; 71 hardcoded colour values in one file**

`:root` is used exactly seven times in `src/pages/routes.ts` and every one of them
contains only `color-scheme`. There are **zero CSS custom properties** in the
repository. The palette is hardcoded per-page: `#1f6feb` (link + primary button) at
`386, 567, 748, 758, 813, 863, 952, 977, 1074, 1077`; `#b00020` (error) at `389, 569,
754, 1072`; `#1a7f37` (ok) at `390`; `#888`/`#666`/`#555`/`#444` (greys) at 30+
sites; `#fff5d6`/`#e0c66b` (paywall), `#eef5ff`/`#c2d6f2` (info), `#e6f4ea`/`#a3d4a8`
(success), `#fff5f5`/`#f0baba`, `#fff8e6` — each pair declared **twice**, in two
different files, with the same intent and no shared definition.

`design-system` skill: "Never use raw hex in components — always reference tokens."
Beyond the maintenance cost, this is the **root cause of C1**: there is no layer at
which a dark palette could be introduced.

*Fix:* §6.2, Phase 2. *Effort:* 1 day.

---

**H2 — 16 hand-written HTML documents with 13 duplicated `<style>` blocks and no shared shell**

Page functions: `signupPage`, `pickTopicsPage`, `deliveryTimePage`, `welcomePage`,
`upgradePage`, `homePage`, `topicPage`, `notFoundPage` (`routes.ts`), plus
`deliveryTimeErrorPage`, `settingsDeliveryErrorPage`, `paywallPage`, `notFoundHtml`,
`pickTopicsErrorPage` (`onboarding/routes.ts`), `oauthFailurePage`, `invalidLinkPage`
(`auth/routes.ts`), `signInRequiredPage` (`access.ts`) — plus the inline archive-search
literal at `routes.ts:212` and the BriefSnapshot email (`brief-snapshot-renderer.ts`).

Each declares its own `<head>`, its own `body { font-family; max-width; margin; padding }`
with **six different `max-width` values** (420, 480, 520, 720, 760, 800px), **three
different `h1` sizes** (1.4, 1.5, 1.6rem), **four different border radii** (4, 6, 8px),
and **four different top margins** (2.5, 3, 4rem).

*Why it hurts:* No page can be changed without risking every other page; a bug fix to
the nav has to be applied 6 times; the visual inconsistency between `/signup` and
`/pick-topics` is not a design decision, it is an accident of authoring order.

*Fix:* §6.2, Phase 2 — one `layout()` function and one stylesheet.
*Effort:* 2 days.

---

**H3 — Navigation is inconsistent and absent from a third of the pages**

Five different navigation implementations coexist:

| Implementation | Pages |
|---|---|
| `<div class="nav">` with 2 links + logout form | `/topics` (970), `/topics/:slug` (1095) |
| Bare logout form at the bottom of `<main>` | `/pick-topics` (602), `/settings/delivery` (777), `/onboarding/welcome` (828) |
| A `<p>` of inline links | `deliveryTimePage` (783) |
| Nothing at all | **`/upgrade`** (836), **`/archive/search`** (209), all 7 error pages |
| Sign-out only | `signupPage` (none — correct, user is anonymous) |

*Why it hurts:* From `/archive/search` there is **no way out of the application except
the browser back button** — no nav, no sign-out. From `/upgrade` the only exit is a
single "Back to your topics" link. A user who lands on an error page by following a
dead link is stranded with one link to `/signup`.

*Constraint:* A shared nav with a logout form breaks `routes.test.ts:115`
(C2 in §4.3). *Fix that in the same commit by keeping the logout control out of the
shared shell and rendering it per-page where it already exists, or by using a
`<button formaction>` outside a form — the test forbids the `<form>` tag, not the
control.*

*Fix:* §6.2. *Effort:* 4 h (with the C2 workaround).

---

**H4 — The topic page's feedback controls are 20×22px, unlabelled to assistive tech, and silently reload the page**

*Where:* `src/pages/routes.ts:1025-1032`.

```html
<button type="submit" name="type" value="thumbs_up" style="font-size:0.75rem;padding:0.1rem 0.4rem;…">👍</button>
```

Five such buttons plus a `Hide` link per cluster.

*What's wrong:*
- **Size:** 0.75rem font with 0.1rem/0.4rem padding yields roughly 20×22 CSS px.
  WCAG 2.2 **2.5.8 Target Size (Minimum), AA** requires 24×24 CSS px.
  `ui-ux-pro-max` rates this **High**.
- **No accessible name:** `👍` and `👎` are emoji, not iconography. They have no
  `aria-label`, no `title`, and no text alternative. A screen reader announces
  "thumbs up emoji, button" at best.
- **No state:** none of the five exposes `aria-pressed` or any indication that the
  action was recorded. `POST /topics/:slug/feedback` redirects back to the same URL
  and the page looks identical.
- **No pending state:** a double-tap writes two `FeedbackEvent` rows.
- **Emoji as structural icons** is explicitly called out as an anti-pattern by
  `ui-ux-pro-max` ("Emoji are font-dependent, inconsistent across platforms, and
  cannot be controlled via design tokens").
- **Full page reload per action** discards scroll position. On a LivingBrief with 20
  clusters, tapping one thumbs-up at the bottom reloads the page and throws the user
  back to the top.

*Also (defect, not just design):* `POST /topics/:slug/feedback` (`routes.ts:237-257`)
never checks that `clusterId` belongs to a topic owned by `req.auth.user.id`. It
writes a `FeedbackEvent` for any cluster id in the body. That is an authorization gap
reachable by any signed-in user. **Flagging for a security ticket — out of scope for
the visual pass.**

*Fix (design):* a 32px-minimum hit area, `aria-label` on every control, `aria-pressed`
reflecting stored state, and progressive enhancement — a `fetch` + optimistic update
with the form submit retained as the no-JS fallback. *Effort:* 6 h.

---

**H5 — No error summary, no announced errors, and every form error discards all user input**

*Where:* `onboarding/routes.ts:243` (`deliveryTimeErrorPage`), `:268`
(`settingsDeliveryErrorPage`), `:315` (`paywallPage`), `:345` (`notFoundHtml`), `:369`
(`pickTopicsErrorPage`); `auth/routes.ts:293`, `:308`.

*What's wrong:* Every server-side validation failure returns a **new bare page** with a
single red sentence (`p { color: #b00020 }`) and a "Try again" link. On
`POST /settings/delivery` with an invalid timezone, the user loses the hour, the minute,
and the timezone they selected and must retype all three. There is no `role="alert"`,
no `aria-invalid`, no `aria-describedby`, no focus management, and no field-level
message.

*Why it hurts:* `ui-ux-pro-max` rates "Focusable Error Summary" **High**,
"Error Messages must be announced" **High**, "Error Placement" (inline error tied to
the field via `aria-describedby`) **High**, and "Error Recovery" **Medium**. This is
the state most validation-failing users see, and it is the worst-handled screen in the
app.

*Fix:* Re-render the originating page with the submitted values preserved, an error
summary at the top (`role="alert" tabindex="-1" aria-labelledby`), and per-field inline
errors. All the error-page *functions* keep existing — they become partials.
*Effort:* 1 day. *Regression risk:* the copy assertions in §4.3 must be preserved
verbatim inside the new summary block.

---

**H6 — Muted text fails WCAG AA contrast in light mode**

*Where:* `#888` on white = **3.54:1** (needs 4.5:1 for text under 18.66px bold /
24px regular). Used at `routes.ts:391` (`.divider`, 0.85rem), `:558` (`h2` category
labels, 1rem), `:749` (`.hint`, 0.85rem), `:949` (`p.plan`, 0.85rem), `:954`
(`.muted`), `:1069` (`.muted`, used by **three** of the four empty states),
`:1071` (`.hide-btn`, 0.8rem), `:1076` (`.filter-bar, .window-form`, 0.85rem).

Also below AA: `#1f6feb` on white = **4.63:1** (passes, but with only 0.13 of margin,
and the *same* token paints link text and button fill — it cannot be adjusted for one
without affecting the other), and the `#ccc` borders on every input, select and
secondary button (`routes.ts:385, 393, 560, 565, 574, 746`;
`onboarding/routes.ts:328, 334, 352, 378`) at **1.61:1** — below the 3:1 that WCAG 1.4.11
Non-text Contrast requires for a control boundary.

*Why it hurts:* The `.muted` class carries the empty-state messaging — the text that
tells a user their topic is empty. Low-contrast text there is low-confidence text
exactly where the user is already uncertain.

*Fix:* A muted value at ≥4.5:1 (`#5f6368`-class, 5.6:1), a border value at ≥3:1
(`#767676`-class, 4.5:1), and separate `--color-link` from `--color-primary` so they
can be tuned independently. *Effort:* 2 h once tokens exist.

---

**H7 — No responsive breakpoints; the delivery-time form has no mobile layout**

*Where:* The only two responsive-ish rules in the application are
`grid-template-columns: repeat(auto-fill, minmax(220px, 1fr))` (`routes.ts:559`) and
`grid-template-columns: 1fr 1fr 2fr` (`routes.ts:747`).

*What's wrong:* The second one is the whole of the delivery-time form — Hour, Minute,
Timezone — in a fixed three-column row with no `@media` fallback. At 320px that is
roughly 60px / 60px / 130px. A `<select>` of IANA zone names in 130px shows
`America/New…`. Everything else in the app is `max-width` + `padding: 0 1rem`, which
means: no adaptation, ever.

*Fix:* Two breakpoints (`640px`, `960px`) in the new stylesheet; stack the delivery
row on small screens. *Effort:* 3 h.

---

**H8 — The timezone picker offers 19 hardcoded zones to a global user base**

*Where:* `COMMON_TIMEZONES` (`routes.ts:32-52`), rendered as a bare `<select>` of raw
IANA slugs (`routes.ts:678-681`).

*What's wrong:* 19 zones covering roughly half the world's population. A user in
`America/Sao_Paulo` is covered; a user in `Europe/Kyiv`, `Africa/Nairobi`, `America/Bogota`,
`Asia/Karachi`, or any of ~350 other populated zones **cannot select their own timezone**
and their brief is delivered at the wrong hour. The list has no search, no grouping, and
no offset display.

*Fix:* `Intl.supportedValuesOf('timeZone')` (available in all target browsers since
2022) filtered to a curated ~100, rendered as a native `<select>` so no dependency and
no JS is added, or a `<datalist>` for search. *Effort:* 3 h.

---

**H9 — `/archive/search` is a shipped dead end**

*Where:* `routes.ts:209-215`.

*What's wrong:* An authenticated, reachable route rendering
`<h1>Archive search</h1><p>Search results will appear here.</p>` — no form, no input, no
styles, no nav, no viewport meta, and a mojibake `<title>`. Meanwhile
`src/services/archive-search-service.ts` exists, is written, and is wired to nothing.

*Why it hurts:* The information architecture promises Archive search (CONTEXT.md
`Archive`: "Searchable by the User") and delivers a stub with no exit. A user who
navigates there is stuck.

*Fix:* Either give it a real search form wired to the existing service, or — if that is
out of scope for a visual pass — render a styled "coming soon" state **with working
navigation**, so it is a dead end in feature but not in navigation. *Effort:* 1 h for
the second option, unknown for the first.

---

**H10 — `detectServerTimezone()` reports the server's timezone to the user as "Detected"**

*Where:* `routes.ts:54-62`, used at `:135, 136, 181` and rendered at `:682-684`.

*What's wrong:* The function reads `Intl.DateTimeFormat().resolvedOptions().timeZone`
— **on the server** — and the page then tells the user "Detected: Europe/London" when
the server is in London and the user is in Toronto. The hint is wrong by construction
for every user not colocated with the server.

*Fix:* Read `Intl.DateTimeFormat().resolvedOptions().timeZone` in a tiny inline script
(or a `TZ` cookie set on first visit) and render the hint client-side. Preserves the
no-JS fallback of showing no hint at all.
**Constraint:** any new `<script>` on the delivery-time pages breaks
`onboarding/routes.test.ts:429, 469` (C3 in §4.3) — so this must go on a different
page, or be reconciled with that test deliberately. *Effort:* 1 h.

---

### 5.3 MEDIUM

| # | Finding | Evidence | Why it hurts | Fix | Effort |
|---|---|---|---|---|---|
| **M1** | **Body line-height is never set** on any page except `welcomePage:810` and `upgradePage:858` (1.5). The default in most browsers is ~1.2. | `routes.ts` — `body` rules at 380, 555, 741, 808, 855, 946, 1061 | Cluster bullet lists are the product's core reading surface, rendered at 1.2× with no measure constraint. | `line-height: 1.6` on body, `1.7` on `.cluster ul`. `ui-ux-pro-max` rates Line Height **Medium**. | 15 min |
| **M2** | **Reading measure is too wide on the core screen.** `max-width: 760px` (`routes.ts:1061`) at 16px ≈ 95 characters per line. | vs. `ui-ux-pro-max` "Line Length: limit to 65–75 characters" (**Medium**) | The LivingBrief is the app's main reading surface and has the worst measure of the three content pages (760 > 720 > 520). | Constrain prose to `max-inline-size: 68ch`. | 15 min |
| **M3** | **No landmark elements.** Every page is a single `<main>`; no `<header>`, `<nav>`, `<footer>`, or `<section>`. `/archive/search` has no `<main>` at all (`routes.ts:212`). | all 8 page functions | Screen-reader users have no way to skip regions; the 7 `<h2>` cluster headings become a flat list of equal-rank items. | Landmarks in the shared shell. Pairs with H3. | 2 h |
| **M4** | **No skip link.** | all pages | Tab order begins with "Sign out" on 5 pages. `ui-ux-pro-max` rates Skip Links **Medium**; with 6 controls per cluster on the topic page it is more than medium there. | First focusable element in the shared shell. | 20 min |
| **M5** | **Empty states describe but never act.** `emptyStateBlock` (`routes.ts:1118-1138`) is the best UX in the codebase — four correctly distinguished situations. But three of the four offer no next action; "No stories yet for this topic. Check back after the next ingest." offers nothing. | `routes.ts:1137` | `ui-ux-pro-max` "Empty States: show helpful message **and action**" (**Medium**). A new user whose ingest has not run yet has no idea what to do or when to look. | Add a secondary link (Manage topics / Delivery time) and a last-ingested timestamp. Preserves the four-way distinction. | 1 h |
| **M6** | **Cluster-window form gives no feedback and silently clamps.** `min`/`max` are set in HTML (`routes.ts:1176`) but the server narrows out-of-range input without telling anyone (`routes.ts:274-281`). | `routes.ts:275-281` | A user who types `30` sees the form reset to `14` with no explanation. | Echo the clamped value plus a note. | 1 h |
| **M7** | **"Hide" (a GET link) and "Hide source" (a POST button) sit adjacent with near-identical labels and different persistence.** The server reads `req.body.scope` (`routes.ts:252`) but **no UI ever sends it**, so `global` is unreachable. | `routes.ts:1024, 1031, 252` | Two controls that look alike, one reversible and one not. Users will pick the wrong one and be unable to undo it. | Rename to "Dismiss" / "Hide this source", and add a scope control (or drop `global` from the UI until it is designed). | 2 h |
| **M8** | **Article links lose their source attribution.** `.join(', ')` into one paragraph (`routes.ts:1020-1023`) with no outlet name beside each link. | `routes.ts:1023` | A reader cannot tell which outlet an article is from; the source chips are above but not mapped. In a reading product, attribution is the point. | Render as a list with the Source name and article title. | 1 h |
| **M9** | **`.selected` has no CSS rule.** `routes.ts:1162` emits `class="selected"` on the active Source filter, but no `.selected` rule exists in the stylesheet. | `routes.ts:1162` vs. the style block at 1059-1085 | The user cannot tell which Source filter is active. | A `aria-pressed` toggle group with a real selected state. | 1 h |
| **M10** | **`.hide-row` uses a negative top margin** (`margin: -0.5rem 0 0.5rem 0`, `routes.ts:1070`) to pull the control row up under the cluster headline. | `routes.ts:1070` | On a narrow screen a wrapped 2-line headline collides with the button row. `ui-ux-pro-max` "Content Jumping" is **High**; this is a jitter pattern. | Remove the negative margin; use explicit spacing. | 15 min |
| **M11** | **No pending state on 6 of 8 forms.** Only the signup and picker pages disable their submit button (`routes.ts:424, 630`). | `POST /settings/delivery`, `/onboarding/delivery-time`, `/topics/:slug/cluster-window`, and all 5 feedback buttons per cluster do not. | Double-submit writes duplicate rows. `ui-ux-pro-max` "Loading Indicators" is **High**. | `:disabled` on submit for all forms. | 1 h |
| **M12** | **The `lede` line on the topic page crams four facts into one sentence.** `routes.ts:1090`: "Signed in as {email} · {category} · N active clusters". | `routes.ts:1090` | Wraps to 4+ lines at 320px. The email is also repeated on every single page. | Move the identity to the shell header; keep category + count in the lede. | 1 h |
| **M13** | **The email address is repeated on 7 pages** as part of the lede, and is the primary element of the `<p class="lede">` on 4 of them. | `routes.ts:584, 766, 821, 869, 965, 1090` | The account identity outranks the page's actual purpose in the visual hierarchy. | Move to the shell header, visually subordinate. | 1 h |
| **M14** | **`Not-found` reflects the raw URL slug into the page.** `routes.ts:272, 299`: `notFoundPage(email, \`Topic "${req.params.slug}" not found\`)`. | `routes.ts:272, 299` | Correctly escaped, so not a vulnerability, but echoing an arbitrary URL path segment into the page is a reflected-content pattern with no product reason. | Static copy. | 15 min |
| **M15** | **`<details>` "Change delivery time" has no affordance.** `routes.ts:727` — a blue-text summary with the UA's default marker, inside a flat, button-free design language. | `routes.ts:727` | Users do not recognise it as expandable. (The native control is correct and must be preserved per §4.3 C5 — style it, don't replace it.) | A chevron + spacing. | 30 min |
| **M16** | **No `prefers-reduced-motion` handling.** | absent | Nothing animates today, so nothing is broken. But Phase 2/3 introduce transitions; the block must land with them or the first added transition becomes a regression. | Add the media query with the first transition. | 15 min |

### 5.4 LOW

| # | Finding | Evidence |
|---|---|---|
| **L1** | `color-scheme` is declared on 7 pages and omitted from `notFoundPage`, the archive-search literal, and every error page — so even the *declaration* is inconsistent. | `routes.ts:1182, 212`; `onboarding/routes.ts` ×5; `auth/routes.ts` ×2; `access.ts:87` |
| **L2** | `<title>` suffixes are inconsistent: 4 pages carry " · Brieflyy" (mojibake), 4 do not ("Sign in to Brieflyy", "Welcome to Brieflyy", "Invalid link", "Sign-in failed"). | `routes.ts:377, 805, 852`; `auth/routes.ts:297, 309` |
| **L3** | No `<meta name="description">`, no Open Graph tags, no favicon on any page. Shared links have no preview. | all pages |
| **L4** | `escapeHtml` is implemented twice with different guarantees: `pages/html.ts:1` escapes `& < > " '`; `services/brief-snapshot-renderer.ts:92` escapes only `& < > "`. Two functions, same name, different contracts, in a codebase whose entire error layer depends on one of them. | `html.ts:1-8`; `brief-snapshot-renderer.ts:92-98` |
| **L5** | `brief-snapshot-renderer.ts:60` emits `<html>` with no `lang`, no `xmlns`, no viewport. Outlook requires table layout and inline CSS. | `brief-snapshot-renderer.ts:60` |
| **L6** | `pickTopicsPage` hardcodes a 5-element `categoryOrder` that must be kept in sync with `TOPIC_CATEGORIES` (`types.ts:3-10`). A 6th category would be **silently dropped** from the page. Not currently a bug (A7), but a latent one. | `routes.ts:482-491` |
| **L7** | `MONTH_NAMES` (`routes.ts:886-899`) is a hand-rolled month table where `Intl.DateTimeFormat` exists. | `routes.ts:886` |
| **L8** | No `Cache-Control` or compression plugin; every page re-ships its inline `<style>`. At this scale the cost is negligible, but it grows with the page count. | `app.ts` |
| **L9** | The topic page renders `c.summary || c.title` as the `<h2>` (`routes.ts:1042`). If a Cluster has no summary the user sees a raw internal title. CONTEXT.md defines the Cluster summary as quoted-from-Article, so an empty summary may indicate a real gap upstream — **a question for you, not a finding I can resolve.** | `routes.ts:1042` |
| **L10** | No automated responsive or browser-level regression net: Playwright has one project (chromium, 1280×720 desktop), no `baseURL`, no `webServer`, is wired to no npm script, and `smoke.spec.ts` only asserts `page.title()` on `about:blank`. | `playwright.config.ts`; `package.json`; `vitest.config.ts` |

---

## 6. Phased roadmap

Nothing here is approved. Each item names the files it touches and its regression risk
against §4.

### 6.1 Phase 1 — Quick wins (target: 1 day, no design decisions required)

| # | Item | Files | Risk |
|---|---|---|---|
| 1 | **Fix the mojibake** — replace the `Â·` two-code-point sequence with `&middot;` | `pages/routes.ts` (7 lines: 213, 552, 738, 827, 931, 943, 1189) | **None.** No test asserts a `<title>`. |
| 2 | **Remove `color-scheme: light dark`** until a dark palette exists (C1, option 1a) | `pages/routes.ts` (7 lines) | **None.** No test asserts it. Immediately un-breaks dark-OS users. |
| 3 | **Add `<meta name="viewport">` to all 14 page templates** (C5) | `pages/routes.ts`, `onboarding/routes.ts`, `auth/routes.ts`, `http/access.ts` | **None.** No test asserts it. |
| 4 | **Hide the `category` segment when it is `unspecified`** (C6) | `pages/routes.ts:931, 1090` | **Low.** Display only; the stored value is untouched, so `onboarding-service.test.ts:178` still passes. |
| 5 | **Add `:focus-visible` outline** (C2) | new `pages/styles.css` | **None.** No test asserts CSS. |
| 6 | **Remove the `.hide-row` negative margin** (M10) | `pages/routes.ts:1070` | **None.** `topic-page.test.ts` asserts content, not spacing. |
| 7 | **Add the missing `.selected` rule** to the Source filter (M9) | `pages/styles.css` | **None.** CSS only; the C1 `filter-bar` selector is unaffected. |
| 8 | **Set `line-height: 1.6` on body, `1.7` on cluster bullets** (M1) | `pages/styles.css` | **None.** |
| 9 | **Constrain prose to `68ch`** (M2) | `pages/styles.css` | **None.** |
| 10 | **Make the `filter-bar` source links expose state** — add `aria-current` to the selected one (M9) | `pages/routes.ts:1162` | **None.** `filterBar()` matches on the open tag only; the inner links are checked by substring (`?source=`, `href="/topics/topic-1"`), which an extra attribute does not disturb. |
| 11 | **Static copy in `notFoundPage`** instead of reflecting the slug (M14) | `pages/routes.ts:272, 299` | **None.** No test asserts that string. |
| 12 | **Add a `prefers-reduced-motion` block** to the stylesheet now, before any motion exists (M16) | new `pages/styles.css` | **None.** |

**Deliberately excluded from Phase 1, pending your decision:** C4's unsubscribe links
(functionality, not design), and H10's client-side timezone detection (it would add a
`<script>` to a page that a test forbids).

### 6.2 Phase 2 — Design system and shared shell (target: 4 days)

**Foundation (must land first, in this order):**

1. `src/pages/styles.css` — one stylesheet, served at `/assets/app.css` via a Fastify
   static route, or inlined once by the layout helper. Per the `design-system` skill's
   three-layer model:
   - **Primitive:** `--blue-600: #1f6feb`, `--gray-100 … --gray-900`, `--red-700`, `--green-700`, `--amber-100/700`, plus the spacing scale `4/8/12/16/24/32/48/64` and type scale `12/14/16/18/24/32`.
   - **Semantic:** `--color-canvas`, `--color-surface`, `--color-text`, `--color-text-muted` (≥4.5:1), `--color-text-subtle`, `--color-border` (≥3:1), `--color-link`, `--color-primary`, `--color-primary-fg`, `--color-danger`, `--color-success`, `--color-focus-ring`, `--color-paywall-bg/-border`.
   - **Component:** `--button-*`, `--input-*`, `--card-*`, `--callout-*`, `--chip-*`, `--nav-*`.
   - Every existing hardcoded hex in all three UI files maps to one of these. **This is
     what makes a dark palette a Phase 3 option instead of a rewrite.**

2. `src/pages/layout.ts` — one `layout({ title, body, nav, user })` returning the
   complete document: charset, viewport, title, stylesheet link, skip link, `<header>`
   with the brand + primary nav, `<main id="main">`, footer.
   - **Must not** introduce a `<form>` on `/upgrade` (breaks `routes.test.ts:115`).
   - **Must not** introduce a `<script>` on `/onboarding/delivery-time` or
     `/settings/delivery` (breaks `onboarding/routes.test.ts:429, 469`).
   - The logout control is therefore **not** part of the shared shell; each page
     keeps the `<form class="logout">` it already has, or the test is updated
     deliberately in the same commit.

3. Convert the 8 page functions to use `layout()`. Delete their `<style>` blocks.

**Then, in priority order:**

| # | Item | Files | Risk |
|---|---|---|---|
| 4 | Landmarks + skip link (M3, M4) | `layout.ts`, `styles.css` | Low. Needs a `<main id="main">`; no test selects on `<main>`. |
| 5 | Shared nav, replacing the 5 ad-hoc implementations (H3) | `layout.ts` + 8 page functions | **Medium** — this is the item that collides with the `/upgrade` no-form test. Do it in its own commit with the test question settled first. |
| 6 | Contrast pass: muted text, borders, split `--color-link` from `--color-primary` (H6) | `styles.css` | None (no CSS assertions). |
| 7 | Responsive: two breakpoints; stack the delivery-time row (H7) | `styles.css` | None. |
| 8 | Button + input state matrix per `design-system` `states-and-variants` | `styles.css` | None. |
| 9 | Shared form-error pattern: re-render with values preserved, `role="alert"` summary, per-field `aria-describedby` (H5) | `onboarding/routes.ts`, `auth/routes.ts`, `pages/routes.ts` | **Medium** — the §4.3 copy assertions must survive verbatim inside the new summary. Do it one endpoint at a time. |
| 10 | Feedback controls: ≥32px targets, `aria-label`, `aria-pressed`, pending state (H4) | `pages/routes.ts:1025-1032` | Low for a11y attributes. `feedbackRepo` contract unchanged. The authorization defect (H4 note) is a **separate security ticket**, not this item. |
| 11 | Distinguish "Dismiss" from "Hide this source"; decide `scope` (M7) | `pages/routes.ts:1024, 1031` | Low. `POST /topics/:slug/feedback` still accepts the same fields. |
| 12 | Article links as a sourced list (M8) | `pages/routes.ts:1020-1023` | **Medium** — `topic-page.test.ts:270` asserts `href="https://www.reuters.com/acme-foo"`; the href must survive, the wrapping may not. |
| 13 | Timezone picker: `Intl.supportedValuesOf`, offset display, searchable (H8) | `pages/routes.ts:32-52, 678-681` | Low. `onboarding/routes.test.ts` asserts `name="timezone"` and specific values like `Europe/London` and `America/New_York` — all of which remain in the list. |
| 14 | BriefSnapshot email: doctype, viewport, inline styles, topic title as `<h1>`, brand, date, accessible links (C4, design half only) | `services/brief-snapshot-renderer.ts:60-87` | **Medium** — `tests/e2e/brief-snapshot-llm.spec.ts:79` asserts `rel` is exactly `noopener`. Keep that exact value. |
| 15 | Single `escapeHtml` with `'` escaping, used everywhere (L4) | `pages/html.ts`, `services/brief-snapshot-renderer.ts` | Low, but it is a security function — **its own commit, with a test that pins the escaping contract first.** |
| 16 | Empty states gain a secondary action (M5) | `pages/routes.ts:1118-1138` | **Medium** — all four branches are copy-asserted. The new copy must be *additive*. |
| 17 | Wire Playwright: `test:e2e` script, `baseURL`, `webServer`, chromium mobile + tablet projects (L10) | `playwright.config.ts`, `package.json`, `tests/e2e/*` | None — additive. This is the **enabler for everything after Phase 2.** |

### 6.3 Phase 3 — Interdependent improvements (target: 3 days)

Sequenced after Phase 2, because each changes the shared shell.

| # | Item | Files | Risk |
|---|---|---|---|
| 18 | **Full trends / Discover surfaces.** `trends-service.ts`, `discover-service.ts`, and `discover-repo.ts` are written and unwired. CONTEXT.md names trends as the paid differentiator, and the paid tier currently buys nothing visible. | new `pages/` routes + `layout.ts` | Medium — new routes need the `PUBLIC_ROUTES` allowlist decision (`route-guard.test.ts` C12). |
| 19 | **Cluster-window feedback** (M6) | `pages/routes.ts:275-281, 1174-1179` | Low. |
| 20 | **Pending state on the remaining 6 forms** (M11) | all form-rendering pages | Low. |
| 21 | **Move identity out of the lede** into the shell header (M12, M13) | 7 page functions | Low — the `Signed in as` substring is not asserted, but the email itself is (e.g. `auth/routes.test.ts:343` expects `iris@example.com` **on the page**). Keep it rendered somewhere on every authenticated page. |
| 22 | **`/archive/search`: real form, or styled dead-end with navigation** (H9) | `pages/routes.ts:209-215` | Low for the styled option. |
| 23 | **H10 client-side timezone detection** — requires reconciling C3 (`no <script>` on delivery-time pages) | `pages/routes.ts:54-62, 682-684` | Medium. Either the test is updated deliberately, or the detection moves to a cookie set on `/topics` (which permits scripts). |

### 6.4 Larger redesigns (Phase 4 — prototype first, per the `prototype` skill)

| # | Item | Rationale | Notes |
|---|---|---|---|
| 24 | **LivingBrief redesign.** Today: a flat `<article>` list; DOM order is h2 → 6 controls → bullets → source chips → article links. Keyboard users tab through 60 controls to reach the 11th headline. No timestamps, no "new since you last looked", no velocity/recency signal, no persistent filter bar (the Source filter is a `<p>` of links at `routes.ts:1164` that scrolls away). | This is the product's core screen and the one with the worst information architecture. A reading-first layout with a sticky filter bar, per-Cluster recency, progressive disclosure of bullets, and a control cluster that does **not** precede the content is the single largest UX win available. | Prototype 2–3 variants, review, then implement. Test risk: the copy contract in §4.3 and the `filter-bar` `<p>` selector (C1) constrain the markup; the topic-page tests need updating deliberately. |
| 25 | **Onboarding as a guided 3-step flow** with progress, rather than three disconnected pages that each re-render the whole document and each have their own ad-hoc nav. | The activation moment is the first brief within 24h (`CONTEXT.md`); onboarding is the only flow every user traverses, and C5 means it is currently broken on every phone. | Higher risk: it touches the post-signin redirect logic in `auth/post-signin.ts` and the exact-3 validation asserted at `onboarding/routes.test.ts:297-310`. |
| 26 | **Client-side enhancement layer** — progressive enhancement of feedback and filters so a thumbs-up does not reload the page. | Perceived speed on the main screen. | **Recommend against a framework.** A ~2KB inline module in the existing no-`<script>` constraint's terms, or a separate opt-in bundle. Introduces C3 risk on two pages; those pages simply do not get the enhancement. |
| 27 | **Dark mode, properly.** C1's option 1b. | Once Phase 2's token layer exists this is a `@media (prefers-color-scheme: dark)` block redefining ~15 semantic tokens. | Verify contrast independently in both themes — do not assume light values carry over. `ui-ux-pro-max` rates dark-mode contrast **High**. |

---

## 7. Testing checklist

### 7.1 Per-change, every time

- [ ] `pnpm typecheck` — clean
- [ ] `pnpm test` — clean (this is `vitest run`; covers `src/**/*.test.ts`)
- [ ] `pnpm secrets:check` — clean
- [ ] `pnpm verify` — all three, in order
- [ ] `git diff` reviewed for: any route path, method, or access level; any form `name`; any string from §4.3; any `<style>` assertion (there are none, so a diff that touches `<style>` is expected and safe)

### 7.2 Manual smoke — the eight authenticated flows

Run with the dev server (`pnpm dev`, see README for the magic-link console flow).

- [ ] `/` → 302 → `/signup` renders; magic link request → "Check your inbox"; **and the Google button is visible in dark mode**
- [ ] Magic link → land on `/onboarding/pick-topics`; select exactly 3 → continue; fewer/more → inline error, **and the picker still works with JS disabled**
- [ ] `/onboarding/delivery-time` → set → welcome page shows "Your first brief arrives …"
- [ ] `/onboarding/welcome` → "Change delivery time" → `/settings/delivery`; change → "Time saved."
- [ ] `/settings/delivery` → **the Change control must be a native `<details>` and the page must contain no `<script>`** (enforced by C3/C5 — verify before assuming the layout helper is safe)
- [ ] `/topics` → empty state, then with topics; **a free-form topic must not display "unspecified"**
- [ ] `/topics/:slug` → clusters render; Source filter applies and clears; Hide via link; Hide source persists across reload; all four empty states still distinguishable
- [ ] `/topics/:slug` → cluster window 1–14 saves and re-renders; out-of-range clamps **and says so**
- [ ] `/upgrade` → **must contain no `<form>` tag** (C2) and must contain `href="/upgrade"` reachable paths
- [ ] Sign out → 302 → `/` → back to `/signup`
- [ ] Anonymous: `/topics`, `/pick-topics`, `/upgrade`, `/topics/anything` → 302 `/signup`
- [ ] Bad magic-link token → 400 page with "Invalid sign-in link"; reused token → "already been used"
- [ ] Google callback with missing state cookie → 400 with "Sign-in failed"

### 7.3 Accessibility gate (per WCAG 2.2 AA)

- [ ] **Tab the entire app.** Every focusable control shows a visible indicator. Nothing is skipped; order follows visual order.
- [ ] **Skip link is the first Tab stop** on every page and moves focus to `<main>`.
- [ ] **OS dark mode ON:** every page is legible; no white-on-white; no `2.7:1` body text. (Until Phase 2, verify the `color-scheme` lines are gone.)
- [ ] **OS dark mode OFF:** muted text ≥ 4.5:1, borders ≥ 3:1, link text ≥ 4.5:1.
- [ ] **Screen reader (NVDA/VoiceOver):** landmarks are announced; every icon-only button has a name; errors are announced via a live region; `#status` regions on signup and picker announce.
- [ ] **375px wide:** no horizontal scroll on any page; no element under 24×24px; the delivery-time form stacks; body text is readable without pinch-zoom.
- [ ] **200% zoom** and **320px reflow** (WCAG 1.4.10): all content reachable, no loss.
- [ ] **JS disabled:** signup shows the form (submit will not work — note this), the picker still validates server-side, the delivery-time Change control still expands.
- [ ] `prefers-reduced-motion: reduce` honoured once motion exists.

### 7.4 Once Phase 2 item 17 lands

- [ ] `pnpm test:e2e` runs and passes; `playwright.config.ts` has `baseURL`, a `webServer`, and chromium at desktop / mobile / tablet.
- [ ] A smoke spec visits all 8 authenticated routes and asserts a 200 and a heading on each.
- [ ] A visual-regression baseline is captured for the 6 main screens at 3 viewports, and reviewed by a human — **not** auto-accepted.
- [ ] The `/upgrade` no-form invariant and the delivery-time no-script invariant have their own named spec, so a future layout change cannot silently break them.

### 7.5 Before declaring the project "verified"

- [ ] Consider adding a `contrast` script (a ~50-line Node script using the existing `node:crypto`-free WCAG formula, no new dependency) to `pnpm verify`, so H6 cannot regress.
- [ ] Consider extending the route-guard test to assert every registered HTML page emits a viewport meta tag — that turns C5 into a permanently-enforced invariant rather than a one-time fix.

---

## 8. What I need from you before implementing

> **Answered 2026-09-29.** The plan was approved and each of the six questions
> was decided rather than deferred. What was chosen, and what it cost, is below.

1. **C1 direction** — remove `color-scheme` now (recommended), or build the dark
   palette in Phase 2? **Remove it now, and build the real palette in Phase 3
   once tokens exist.** Both. A dark palette with no token layer is a rewrite of
   sixteen pages; a token layer makes it fifteen lines in one file. Leaving the
   declaration in place for a release would have left three controls invisible.
   *Done:* the seven declarations are gone and `styles.ts` documents why.
2. **C4 unsubscribe links** — implement `/unsubscribe/*` (needs a real token
   design, so a separate ticket), or remove the footer from the email until they
   exist? **Remove the footer links, and file the real thing as its own ticket.**
   Implementing them is not a UI change: `email_deliveries.unsubscribe_token`
   and `global_unsubscribe_token` exist and are never written,
   `ScheduledBriefService.run()` is still a stub that sends nothing, and nothing
   in the schema records a per-Topic or per-User opt-out for the send path to
   honour. Shipping a live-looking 404 either way was the one option ruled out.
   *Done:* the footer now offers `/settings/delivery`, `/pick-topics` and
   `/topics`, and a test asserts the string `unsubscribe` never appears in a
   brief. Follow-up filed.
3. **H3 nav** — accept a shared shell without a logout `<form>`, or authorise
   updating `routes.test.ts:115` in the same commit? **Authorise the test
   update.** The assertion's intent is "nothing on `/upgrade` can be submitted,
   because there is no checkout", and sign-out is not a checkout. The
   alternative — a special-cased shell that omits sign-out on one page — would
   have kept the test and lost the reason it existed. *Done:* the assertion is
   scoped to `<main>`, and a browser spec covers the same ground.
4. **Brand** — is there a real palette/wordmark outside this repo? **No, and
   none was invented.** `#1f6feb` is retained as a *provisional* brand token,
   split from a new darker `--color-primary` that can carry white text at AA. The
   wordmark is set in the system font; no logo was generated, because designing a
   mark is a separate decision and a generated placeholder would be mistaken for
   one. Recorded in ADR 0009.
5. **H9 `/archive/search`** — styled dead-end now, or wire the existing service?
   **Styled dead-end now, with working navigation; wire it properly as a
   feature.** `ArchiveSearchService` is written and pure, but it takes its items
   by constructor and `ArchiveRepo` is an interface with no implementation, so
   there is no data behind it. Choosing an `ArchiveItemInput` projection is a
   data-model decision, not a visual one. The page now says search is not
   switched on, and the shared shell means it is no longer a place with no way
   out. Follow-up filed.
6. **Devices** — I have assumed desktop-first, phone-secondary, email-primary.
   Confirm or correct, since it changes the Phase 4 sequencing. **Corrected to
   email-first, phone-second, desktop-third.** The email is the product — it is
   the delivery surface, it is retained forever, and people read digests on
   phones. The app was also unusable on a phone: 6 of 8 pages and the whole
   onboarding funnel had no viewport tag. So the stylesheet is mobile-first, the
   BriefSnapshot got the design pass rather than the app pages, and the browser
   suite runs at three widths so this stays honest.

### What the decisions did not settle, and is filed

- `POST /topics/:slug/feedback` never checks the cluster belongs to the caller.
  Any signed-in User can write a `FeedbackEvent` for any cluster id. Security,
  not design; it is the finding on this list I would fix first.
- Real `/unsubscribe/*` with honoured one-click tokens (decision 2).
- A real `ArchiveRepo` behind `/archive/search` (decision 5).
- Dark mode, now that the token layer can carry it (decision 1).
- The LivingBrief redesign and the onboarding wizard: prototype first.
- The picker error path, which still answers with a bare page and discards the
  eight checkboxes. The two delivery-time endpoints were converted; this one was
  left rather than half-done.
- Client-side timezone detection. It needs a `<script>` on a page two tests
  forbid one on, so it waits for a decision about that invariant.

