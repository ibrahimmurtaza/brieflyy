/**
 * One stylesheet for every page, inlined by `layout()` in `./layout.ts`.
 *
 * Three layers, in the order a change should be made: a primitive is a raw
 * value, a semantic token says what a value is *for*, and a component rule
 * consumes only semantic tokens. Nothing below the semantic layer is allowed to
 * name a raw colour, so a value can be retuned in one place and every screen
 * that means the same thing moves together.
 *
 * The look is the one the product's mockups set: warm paper rather than white, a
 * deep teal for everything the User acts on, serif for the prose they read and a
 * monospaced face for the machine's own voice — counts, timestamps, dates,
 * labels. Three faces rather than one is the whole of it, and each is doing a job
 * a single sans cannot: prose set in a serif at reading size is measurably easier
 * to read for long than the same words set in a UI face, and a meta line set in a
 * monospaced face reads as data rather than as another sentence. The paper canvas
 * is what makes a long reading surface feel like a page rather than a form.
 *
 * The application is light-only on purpose. `color-scheme: light dark` used to
 * be declared on seven pages with no dark rules anywhere, which left the UA
 * painting a dark canvas under styles written for a white one: body text at
 * 2.7:1 and three controls rendering white-on-white. A dark palette is a change
 * to the semantic layer below, not a rewrite of the pages, so it belongs here
 * rather than in a media query nobody can test.
 *
 * Contrast of the semantic values against their own backgrounds, so a future
 * edit knows what it has to keep:
 *
 *   --color-text        #1a1915 on #f4efe3  15.33:1   body copy
 *   --color-text-muted  #6d6656 on #f4efe3   4.97:1   meta, hints, empty states
 *   --color-link        #0b4c43 on #f4efe3   8.60:1   link text
 *   --color-primary     #0f5f54 with #fbf8f1  7.11:1  button fill
 *   --color-danger      #a52f22 on #f4efe3   6.04:1   error copy
 *   --color-success     #2c6b39 on #f4efe3   5.60:1   success copy
 *   --color-border      #6d6656 on #f4efe3   4.97:1   control boundary (needs 3:1)
 *   --color-focus-ring  #0f5f54 on #f4efe3   6.57:1   focus indicator (needs 3:1)
 */
export const STYLESHEET = `/* Brieflyy design tokens and page rules. Generated once, inlined on every page. */

/* ---------------------------------------------------------------- primitives */
:root {
  /* Colour: one warm paper ramp for the page and everything raised off it, a deep
     teal for every control the User acts on, and one clay accent for the marks
     that annotate rather than act. */
  --paper-0: #fbf8f1;
  --paper-25: #f4efe3;
  --paper-50: #ece5d6;
  --paper-100: #e3dac8;
  --paper-200: #d5cab3;
  --paper-400: #a1977f;
  --paper-600: #6d6656;
  --paper-800: #3c382e;
  --ink-900: #1a1915;

  --teal-50: #e7efec;
  --teal-100: #cfe0da;
  --teal-600: #0f5f54;
  --teal-700: #0b4c43;
  --teal-900: #0a3d36;

  --clay-50: #fbeed6;
  --clay-100: #f6e2be;
  --clay-300: #e2ad55;
  --clay-500: #c8862a;
  --clay-800: #6f4a12;
  --coral-500: #c9583f;

  --red-50: #fbeeec;
  --red-200: #edbdb4;
  --red-700: #a52f22;

  --green-50: #e9f1e8;
  --green-200: #b4cfb0;
  --green-700: #2c6b39;

  /* Space: a 4px scale. Only these steps are used below. */
  --space-1: 0.25rem;
  --space-2: 0.5rem;
  --space-3: 0.75rem;
  --space-4: 1rem;
  --space-5: 1.5rem;
  --space-6: 2rem;
  --space-7: 3rem;
  --space-8: 4rem;

  /* Type: two sizes for prose, three for headings. */
  --text-xs: 0.75rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.375rem;
  --text-2xl: 1.75rem;

  /* Three faces, each with one job. The serif is the prose a User reads; the
     monospaced face is the machine's own voice, so a count, a date or a Source
     name is never mistakable for a sentence; the sans is everything the User
     operates. Each stack leads with a face the platform already has, so nothing
     here is a download. */
  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  --font-serif: "Iowan Old Style", "Palatino Linotype", Palatino, "Source Serif 4", "Source Serif Pro", Georgia, "Times New Roman", serif;
  --font-mono: ui-monospace, "SFMono-Regular", "JetBrains Mono", "Cascadia Mono", Menlo, Consolas, "Liberation Mono", monospace;

  /* Shape and depth. The paper ramp already separates a card from the page, so
     the shadows below are a suggestion rather than a lift. */
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 18px;
  --radius-pill: 999px;
  --shadow-card: 0 1px 2px rgba(58, 50, 32, 0.05);
  --shadow-pop: 0 8px 28px rgba(58, 50, 32, 0.14);

  /* Motion. Kept short, and switched off wholesale by the media query at the
     end of this file. */
  --transition: 120ms ease-out;

  /* ---------------------------------------------------------------- semantics */
  --color-canvas: var(--paper-25);
  --color-surface: var(--paper-0);
  --color-surface-sunken: var(--paper-50);
  /* The recessed surface a rail is drawn on. Distinct from --color-surface,
     which is the raised one: the brief is the page and the rail is beside it,
     and they have to read that way without either of them carrying a shadow. */
  --color-panel: var(--paper-50);
  --color-text: var(--ink-900);
  --color-text-muted: var(--paper-600);
  --color-text-subtle: #4d4738;
  --color-link: var(--teal-700);
  --color-link-hover: var(--teal-600);
  --color-primary: var(--teal-600);
  --color-primary-hover: var(--teal-700);
  --color-primary-fg: var(--paper-0);
  --color-danger: var(--red-700);
  --color-danger-surface: var(--red-50);
  --color-success: var(--green-700);
  --color-success-surface: var(--green-50);
  --color-border: var(--paper-600);
  --color-border-subtle: var(--paper-200);
  --color-rule: var(--paper-100);
  --color-focus-ring: var(--teal-600);
  --color-chip-bg: var(--paper-0);
  --color-chip-fg: var(--paper-800);
  --color-notice-surface: var(--teal-50);
  --color-notice-border: var(--teal-100);
  --color-notice-text: var(--teal-900);
  --color-paywall-surface: var(--clay-50);
  --color-paywall-border: var(--clay-300);
  --color-paywall-text: var(--clay-800);
  /* The rule drawn through a day whose mention volume stands out, and the mark on
     the line above it. Clay for attention, and its own name rather than the
     paywall's: a spike is not something a User is being held back from. */
  --color-spike: var(--coral-500);
  /* The annotation that has no warning in it: one leaf of a Cluster's node graph,
     and one segment of the stacked bar on the trends page. */
  --color-accent: var(--clay-500);

  /* Measure: how wide a line of prose is allowed to be, and how wide a page of
     controls is allowed to be. Five pages used to disagree about the second. */
  --measure: 66ch;
  --page-narrow: 30rem;
  --page-form: 36rem;
  --page-default: 44rem;
  --page-reading: 48rem;
  --page-feed: 72rem;
  /* How wide the rail beside a feed is, and how wide the reading column goes when
     the brief is on its own rather than beside something. */
  --rail: 17rem;
}

/* ------------------------------------------------------------------ elements */
* { box-sizing: border-box; }

html { -webkit-text-size-adjust: 100%; }

body {
  margin: 0;
  background: var(--color-canvas);
  color: var(--color-text);
  font-family: var(--font-sans);
  font-size: var(--text-base);
  line-height: 1.6;
  display: flex;
  min-height: 100vh;
  flex-direction: column;
}

h1, h2, h3 { line-height: 1.2; text-wrap: balance; letter-spacing: -0.02em; font-weight: 700; }
/* The page's own name is the one piece of type on the page allowed to be large,
   and it grows with the viewport rather than snapping between two sizes. */
h1 { font-size: clamp(1.75rem, 1.35rem + 1.6vw, 2.375rem); margin: 0 0 var(--space-3); }
h2 { font-size: var(--text-xl); margin: 0 0 var(--space-2); }
h3 { font-size: var(--text-lg); margin: 0 0 var(--space-1); }

p { margin: 0 0 var(--space-4); }

a { color: var(--color-link); text-decoration: underline; text-underline-offset: 2px; }
a:hover { color: var(--color-link-hover); }

ul { padding-left: var(--space-5); }

hr { border: 0; border-top: 1px solid var(--color-rule); margin: var(--space-6) 0; }

small { font-size: var(--text-sm); }

/* Every focusable control gets one indicator, and it is never removed. Scoped
   to :focus-visible so a pointer user does not see a ring on click. */
:where(a, button, input, select, textarea, summary, [tabindex]):focus-visible {
  outline: 2px solid var(--color-focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}

.skip-link {
  position: absolute;
  left: var(--space-4);
  top: var(--space-4);
  z-index: 10;
  padding: var(--space-2) var(--space-3);
  background: var(--color-canvas);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-pop);
  transform: translateY(-200%);
  transition: transform var(--transition);
}
.skip-link:focus { transform: translateY(0); }

/* A label no sighted reader needs but every control needs. Kept in the document
   rather than replaced by aria-label so the select it labels is still named when
   it is read out of context, which an aria-label on the control alone is not. */
.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  margin: -1px;
  padding: 0;
  overflow: hidden;
  clip-path: inset(50%);
  white-space: nowrap;
  border: 0;
}

/* --------------------------------------------------------------------- shell */
.site-header {
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-canvas);
}
.site-header__inner {
  margin: 0 auto;
  max-width: calc(var(--page-feed) + var(--space-8));
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2) var(--space-4);
}
/* One measure for the header on every page, rather than one per page width.
   Eight navigation links, a search box and the account summary do not fit on one
   row inside the narrowest content measure, and sizing the header per page meant
   it folded onto three rows on the reading pages while running the full width on
   the brief — so the same header was two different shapes depending on which page
   it was on. The header is the one element that is on every page, which is the
   argument for it being the one element that is always the same shape. */
.wordmark {
  font-weight: 800;
  font-size: var(--text-xl);
  letter-spacing: -0.04em;
  color: var(--color-text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  min-height: 2rem;
}
.wordmark:hover { color: var(--color-link); }
.site-nav { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-2); margin-right: auto; }
.site-nav a {
  display: inline-flex;
  align-items: center;
  min-height: 2rem;
  padding: 0 var(--space-3);
  border-radius: var(--radius-pill);
  color: var(--color-text-subtle);
  text-decoration: none;
  font-size: var(--text-sm);
}
.site-nav a:hover { color: var(--color-link); background: var(--color-surface); }
.site-nav a[aria-current="page"] { color: var(--color-primary); background: var(--color-notice-surface); font-weight: 600; }

/* The search box in the header. One row, and the placeholder rather than a visible
   label, because the box is recognisable by its shape and the label would only cost
   the width the navigation needs. The label stays in the document for anyone reading
   the page aloud. */
.shell-search {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0;
}
.shell-search input {
  min-height: 2.25rem;
  width: 11rem;
}
.shell-search button { min-height: 2.25rem; }

/* The account summary. Three facts — who is signed in, what they pay for, and
   when mail next arrives — in the one place that is on every page, so none of
   them has to be restated by a screen that would otherwise get one of them
   wrong. Laid out as named areas rather than by source order so the two lines
   stay two lines at any width, and set in the monospaced face because all three
   are facts rather than sentences. */
.account {
  display: grid;
  grid-template-columns: auto auto;
  grid-template-areas:
    "who   logout"
    "brief logout";
  align-items: center;
  justify-content: end;
  gap: var(--space-1) var(--space-4);
  font-family: var(--font-mono);
}
.account__who {
  grid-area: who;
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-width: 0;
}
.account__email {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.account__tier {
  font-size: var(--text-xs);
  color: var(--color-chip-fg);
  background: var(--color-chip-bg);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  padding: 0 var(--space-2);
  white-space: nowrap;
}
/* The next brief names the User's own timezone, and an IANA name can be long
   enough to be wider than a phone, so it wraps rather than pushing the header
   into a horizontal scroll. */
.account__brief {
  grid-area: brief;
  margin: 0;
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  text-align: right;
  overflow-wrap: anywhere;
}
.account .logout { grid-area: logout; }

.page { flex: 1 0 auto; width: 100%; margin: 0 auto; padding: var(--space-6) var(--space-4) var(--space-8); }
.page--narrow { max-width: var(--page-narrow); }
.page--form { max-width: var(--page-form); }
.page--default { max-width: var(--page-default); }
.page--reading { max-width: var(--page-reading); }
.page--feed { max-width: var(--page-feed); }
.page--reading > p, .page--reading > .lede { max-width: var(--measure); }

.site-footer {
  flex: 0 0 auto;
  border-top: 1px solid var(--color-rule);
  color: var(--color-text-muted);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
}
.site-footer__inner {
  max-width: calc(var(--page-feed) + var(--space-8));
  margin: 0 auto;
  padding: var(--space-4);
}
.site-footer p { margin: 0; }

/* ------------------------------------------------------------------ the feed */
/* One column of reading and one rail of everything that is not the reading: the
   Sources a brief can be narrowed to, what to do with the brief, what caused the
   days it jumped. Below the breakpoint the two stack and the rail reads as the
   summary of the page rather than as a column beside it, so nothing is lost on a
   phone — the rail is a second column, never a second half of the content. */
.feed { display: grid; gap: var(--space-5); align-items: start; }
.feed__main { min-width: 0; }
.feed__main > p { max-width: var(--measure); }

/* The rail is recessed rather than raised: it is the page's furniture, and the
   brief is the page. */
.rail {
  background: var(--color-panel);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
}
.rail > :first-child { margin-top: 0; }
.rail > :last-child { margin-bottom: 0; }
/* Inside the rail the blocks are a stack of short actions rather than the
   paragraphs of a page, so the page's own spacing would leave a gap the height of
   a line between two things a User reads as one list. */
.rail form, .rail .actions { margin-bottom: var(--space-4); }
.rail .actions { margin-top: var(--space-1); }
.rail h2 {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-text-muted);
}

/* ---------------------------------------------------------------- typography */
/* The lede is the one paragraph on a page that is written rather than generated,
   so it is set in the reading face and at the reading size rather than as a
   caption under the heading. */
.lede {
  font-family: var(--font-serif);
  font-size: var(--text-lg);
  color: var(--color-text-subtle);
  margin-top: 0;
  margin-bottom: var(--space-5);
  max-width: var(--measure);
}
.muted { color: var(--color-text-muted); }
.hint { color: var(--color-text-muted); font-size: var(--text-sm); }
.plan { color: var(--color-text-muted); font-size: var(--text-sm); font-family: var(--font-mono); }
.prose { max-width: var(--measure); font-family: var(--font-serif); }

/* The machine's own voice: counts, dates, Source names, the words on a button
   that report a number. Set apart from the prose by the face rather than by
   weight or size alone, so it is legible as a different kind of text rather
   than merely as smaller text. */
.meta {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-text-muted);
  margin: 0 0 var(--space-2);
}
.eyebrow {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.1em;
  color: var(--color-text-muted);
  font-weight: 600;
}

/* ------------------------------------------------------------------- notices */
.callout {
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-notice-border);
  border-radius: var(--radius-md);
  background: var(--color-notice-surface);
  color: var(--color-notice-text);
  margin: 0 0 var(--space-5);
}
.callout p:last-child { margin-bottom: 0; }
/* A link that is a callout's whole action — alone in its own paragraph — is a
   control rather than a word in a sentence, so it gets the same target size
   every other control on a page gets and a finger can find it. Scoped to the
   alone case on purpose: a link inside a sentence keeps its line box. */
.callout p > a:only-child {
  display: inline-block;
  min-height: 2.25rem;
  line-height: 2.25rem;
}
.callout--paywall {
  background: var(--color-paywall-surface);
  border-color: var(--color-paywall-border);
  color: var(--color-paywall-text);
}
.callout--error { background: var(--color-danger-surface); border-color: var(--red-200); color: var(--color-danger); }
.callout--success { background: var(--color-success-surface); border-color: var(--green-200); color: var(--color-success); }
.error { color: var(--color-danger); }
.ok { color: var(--color-success); }

/* An error the User has to act on is announced, and is the first thing on the
   page so it is not below the fold on a phone. */
.error-summary {
  border: 1px solid var(--red-200);
  border-left: 4px solid var(--color-danger);
  border-radius: var(--radius-md);
  background: var(--color-danger-surface);
  color: var(--color-danger);
  padding: var(--space-3) var(--space-4);
  margin: 0 0 var(--space-5);
}
.error-summary p { margin: 0; }
.error-summary a { color: var(--color-danger); }

/* -------------------------------------------------------------------- forms */
form { display: grid; gap: var(--space-3); margin: 0 0 var(--space-5); }
label { display: grid; gap: var(--space-1); font-size: var(--text-sm); color: var(--color-text-subtle); }

input, select, textarea {
  font: inherit;
  font-size: var(--text-base);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-canvas);
  color: var(--color-text);
  min-height: 2.75rem;
  width: 100%;
}
/* A field the User types a phrase into is a pill rather than a box, because that
   is the shape a phrase is read as. A select and a number stepper keep the box:
   the control's own arrow and spinner sit inside them. */
input[type="text"], input[type="search"], input[type="email"], input[type="url"] {
  border-radius: var(--radius-pill);
}
/* The placeholder is an example rather than a label, so it is set in the same
   machine voice as the meta lines: a reader can tell it apart from a value they
   typed without it having to be grey enough to be mistaken for one. */
::placeholder { color: var(--color-text-muted); opacity: 1; font-family: var(--font-mono); font-size: var(--text-sm); }
input[type="checkbox"], input[type="radio"] { width: auto; min-height: 0; margin: 0; }
input:disabled, select:disabled { background: var(--color-surface); color: var(--color-text-muted); }
[aria-invalid="true"] { border-color: var(--color-danger); }

/* A group of controls that belong to one question — the brief schedule is three
   radios that are one setting. The border and the padding are the browser's
   default for a fieldset and say nothing about the group; the legend is the only
   part of it that carries meaning, so it is styled like the rest of the small
   headings rather than left to the user agent. */
fieldset { border: 0; padding: 0; margin: 0 0 var(--space-3); }
legend { padding: 0; font-size: var(--text-sm); color: var(--color-text-subtle); }

/* One button shape, one secondary shape, one quiet shape. */
button, .button {
  font: inherit;
  font-size: var(--text-base);
  font-weight: 600;
  line-height: 1.2;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-5);
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: var(--color-primary);
  color: var(--color-primary-fg);
  cursor: pointer;
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  transition: background-color var(--transition), border-color var(--transition);
}
button:hover:not(:disabled) { background: var(--color-primary-hover); }
button:disabled { opacity: 0.55; cursor: not-allowed; }

.secondary, button.secondary {
  background: var(--color-canvas);
  color: var(--color-text);
  border-color: var(--color-border-subtle);
}
.secondary:hover:not(:disabled), button.secondary:hover:not(:disabled) { background: var(--color-surface); }

.quiet, button.quiet {
  background: none;
  color: var(--color-link);
  border-color: transparent;
  padding: var(--space-1) var(--space-2);
  min-height: 2.25rem;
  text-decoration: underline;
}
.quiet:hover:not(:disabled), button.quiet:hover:not(:disabled) { background: var(--color-surface); color: var(--color-link-hover); }

.actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-3); margin-top: var(--space-5); }
.row { display: grid; grid-template-columns: 1fr; gap: var(--space-3); }

/* The live region a page's client-side script writes into. Reserved space so
   announcing a message does not move the submit button out from under it. The
   picker and the sign-in page both write a count or a confirmation here, which is
   data rather than a sentence. */
.status { min-height: 1.5rem; font-size: var(--text-sm); font-family: var(--font-mono); }
.status.error { color: var(--color-danger); }
.status.ok { color: var(--color-success); }

/* Native disclosure, styled so it reads as expandable rather than as a link
   that happens to have a triangle next to it. */
details.change { margin: 0 0 var(--space-5); }
details.change > summary {
  cursor: pointer;
  color: var(--color-link);
  font-weight: 600;
  padding: var(--space-2) 0;
  list-style-position: outside;
}
details.change > summary:hover { color: var(--color-link-hover); }
details.change[open] > summary { margin-bottom: var(--space-4); }

/* ------------------------------------------------------------------- layouts */
.divider { display: flex; align-items: center; gap: var(--space-3); margin: var(--space-5) 0; color: var(--color-text-muted); font-size: var(--text-sm); }
.divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: var(--color-rule); }
.divider a { padding: var(--space-2) 0; }

.grid { display: grid; grid-template-columns: 1fr; gap: var(--space-3); }
section + section { margin-top: var(--space-6); }
/* The heading over a block of the page rather than a heading inside it, so it is
   labelled rather than read as a title: the machine's voice, small and spaced. */
section > h2 { font-family: var(--font-mono); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.1em; color: var(--color-text-muted); font-weight: 600; }

/* A list a User answers by ticking: the checkbox and the name on one row, with the
   whole row as the target. The label rule above stacks a control above its text,
   which is right for a text field and wrong for a checkbox beside a name, so this
   is the one place a label is laid out beside its control rather than above it.
   The picker's Directory chips do the same thing with the .card class; this is the
   same idea without the chip around it, for a list that is nine names rather than a
   grid of blurbs. */
.choices { list-style: none; padding: 0; margin: 0 0 var(--space-4); }
.choices label {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: var(--space-2) 0;
  color: var(--color-text);
  cursor: pointer;
}
.choices > li + li { border-top: 1px solid var(--color-border-subtle); }

/* A selectable Directory chip. The whole chip is the label, so the checkbox and
   the text are one target. */
.card {
  position: relative;
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-canvas);
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: border-color var(--transition), background-color var(--transition);
}
.card:hover { border-color: var(--color-border); }
.card:has(input:checked) { border-color: var(--color-primary); background: var(--color-notice-surface); }
.card:has(input:focus-visible) { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
/* The tick a selected chip carries. Drawn rather than written, so it is empty
   content and nothing reads it aloud: the checkbox beside the name already says
   the entry is chosen, and a second spoken version of it would say it twice. */
.card:has(input:checked)::after {
  content: "";
  position: absolute;
  top: var(--space-4);
  right: var(--space-4);
  width: 0.3rem;
  height: 0.65rem;
  border: solid var(--color-primary);
  border-width: 0 2px 2px 0;
  transform: rotate(45deg);
}
.card input { grid-row: 1 / span 2; align-self: start; margin-top: 0.2rem; }
.card .title { font-weight: 600; padding-right: var(--space-5); }
.card .blurb { color: var(--color-text-muted); font-size: var(--text-sm); font-family: var(--font-serif); }
/* An entry the User already holds: still shown, because the Directory is a
   catalogue, but visibly not available and saying why. */
.card--held {
  cursor: default;
  background: var(--color-surface);
  box-shadow: none;
  border-style: dashed;
}
.card--held .title { color: var(--color-text-subtle); }
.card__note {
  grid-column: 2;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  font-weight: 600;
  letter-spacing: 0.02em;
  color: var(--color-text-muted);
}
/* A Directory card the User acts on, rather than one whole card is. The picker's
   card is a <label>, so the card itself is the target and the text sits beside a
   checkbox in the first column; here the control is a button and the text owns
   the card, so the second column has nothing to hold and is removed rather than
   left for the title to squeeze into. */
.card--entry { grid-template-columns: 1fr; cursor: default; }
.card--entry .card__note { grid-column: 1; }

.freeform { margin-top: var(--space-5); }
.existing { list-style: none; padding: 0; margin: 0 0 var(--space-4); }
.existing li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px solid var(--color-rule);
}
.existing li span { flex: 1; }
form.remove, form.logout { display: inline; margin: 0; }

.topics { list-style: none; padding: 0; margin: 0 0 var(--space-5); }
.topics li { padding: var(--space-3) 0; border-bottom: 1px solid var(--color-rule); }
.topics a { font-size: var(--text-lg); font-weight: 600; text-decoration: none; }
.topics a:hover { text-decoration: underline; }
/*
 * The sent-brief list is one link per row and nothing else, so the link itself is
 * the target and has to clear 24px. Left inline it is measured by the font's
 * ascent and descent rather than by the line box, which is 21px on Linux and
 * passes on Windows — the target size depended on the runner's fonts.
 */
.topics--sent a { display: inline-block; }

/* A named Topic on the topic list, with the one fact about it that is not its
   name set beside it rather than after it, so a list of them reads as a column
   of names and a column of facts. */
.topic-row { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2) var(--space-4); }
.topic-row__meta { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); text-transform: uppercase; letter-spacing: 0.08em; }

/* ----------------------------------------------------------------- the brief */
/* The id is what the trends page's spike annotations link to, so following one
   scrolls a Cluster into view rather than to the top of the brief. The scroll
   margin leaves a little room above it so a Cluster's headline is not flush
   against the edge of the viewport on a phone. */
.cluster { padding-top: var(--space-5); scroll-margin-top: var(--space-5); }
.cluster + .cluster { margin-top: var(--space-4); }

/* A Cluster on the LivingBrief: a card of raised paper, one node graph beside the
   headline, and the prose under it in the reading face. The cluster rows on the
   DiscoverTab share the class for their id and their spacing and are not cards,
   which is why the card itself is the modifier rather than the base. */
.cluster--card {
  display: grid;
  grid-template-columns: 2.75rem minmax(0, 1fr);
  column-gap: var(--space-4);
  padding: var(--space-5);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  box-shadow: var(--shadow-card);
}
.cluster__body { min-width: 0; }
.cluster h2 { font-size: var(--text-lg); margin: 0 0 var(--space-3); max-width: var(--measure); }
/* What a Cluster is made of, above its headline: how many outlets reported it and
   which Topic it belongs to. Machine voice, because it is two counts. */
.cluster ul { font-family: var(--font-serif); font-size: 1.0625rem; margin: 0 0 var(--space-3); padding-left: var(--space-5); line-height: 1.6; max-width: var(--measure); }
.cluster li + li { margin-top: var(--space-1); }
.sources { font-size: var(--text-sm); color: var(--color-text-muted); margin-bottom: var(--space-2); }
.source {
  display: inline-block;
  margin: 0 var(--space-1) var(--space-1) 0;
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  background: var(--color-chip-bg);
  color: var(--color-chip-fg);
  font-size: var(--text-xs);
  text-decoration: none;
}
.source:hover { background: var(--teal-100); color: var(--color-text); }

/* The node graph. A Cluster is a group of Stories, which is what the drawing is:
   one hub with one leaf per outlet that reported it. Drawn in strokes and fills
   rather than as an image so it scales with the reader's text size, and hidden
   from assistive technology because the count it is drawn from is written out
   beside it in the Cluster's own meta line.
   The spokes are the muted ink rather than the hairline: a hairline on the card
   is a rule between things, and these are the lines that make the drawing a
   drawing — at hairline weight they vanished and left four loose dots. */
.cluster__glyph { display: block; align-self: start; overflow: visible; }
.cluster__glyph line { stroke: var(--color-text-muted); stroke-width: 1.6; }
.cluster__glyph circle { fill: var(--color-primary); }
.cluster__glyph .glyph__hub { fill: var(--color-primary); }
.cluster__glyph .glyph__leaf--accent { fill: var(--color-accent); }

/* Cluster actions sit after the headline and before the bullets, and every one
   of them is at least 32px on its shortest side. */
.hide-row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0 0 var(--space-3); }
form.feedback { display: inline-flex; flex-wrap: wrap; gap: var(--space-1); margin: 0; }
form.feedback button {
  min-height: 2rem;
  min-width: 2rem;
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-sm);
  line-height: 1;
  border: 1px solid var(--color-border-subtle);
  background: var(--color-canvas);
  color: var(--color-text);
  border-radius: var(--radius-sm);
}
form.feedback button:hover { background: var(--color-surface); }
form.feedback button[aria-pressed="true"] { border-color: var(--color-primary); background: var(--color-notice-surface); color: var(--color-notice-text); }
/* The Hide-source control is a second form rather than a fifth button, because it
   has to say *which* Source and *how far* the ask reaches — and a button that
   cannot say either of those is what made the global scope unreachable in the first
   place.
   Its selects are sized by the control rather than by the longest Source name, so
   a long name cannot push the button off the row. */
form.hide-source { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); margin: 0 0 var(--space-3); }
form.hide-source button[aria-pressed="true"] { border-color: var(--color-primary); background: var(--color-notice-surface); color: var(--color-notice-text); }
form.hide-source select {
  min-height: 2rem;
  max-width: 12rem;
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text);
  background: var(--color-canvas);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
}
.hide-source__state { flex-basis: 100%; margin: 0; font-size: var(--text-sm); }
.hide-btn {
  display: inline-flex;
  align-items: center;
  min-height: 2rem;
  padding: var(--space-1) var(--space-2);
  font-size: var(--text-sm);
  color: var(--color-text-muted);
  text-decoration: none;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-sm);
}
.hide-btn:hover { color: var(--color-danger); border-color: var(--color-danger); background: var(--color-danger-surface); }

/* Articles carry the outlet they came from, because attribution is the point of
   a reading product and a comma-joined list of titles cannot say it. */
.articles { list-style: none; padding: 0; margin: 0; font-size: var(--text-sm); }
.articles li { padding: var(--space-1) 0; }
.articles .outlet { color: var(--color-text-muted); font-family: var(--font-mono); font-size: var(--text-xs); }
.articles a { display: inline-block; min-height: 1.5rem; text-decoration: none; }
.articles a:hover { text-decoration: underline; }

.filter-bar, .window-form { font-size: var(--text-sm); color: var(--color-text-muted); margin: 0 0 var(--space-5); }
.filter-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.filter-bar > .filter-bar__label { font-family: var(--font-mono); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.1em; }
.filter-bar a {
  display: inline-block;
  padding: var(--space-1) var(--space-3);
  min-height: 2rem;
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  color: var(--color-link);
  text-decoration: none;
}
.filter-bar a:hover { border-color: var(--color-border); background: var(--color-surface); }
/* The Source being filtered to. It was emitted with this class and had no rule
   anywhere, so the page could not say which filter was live. */
.filter-bar a.selected {
  background: var(--color-primary);
  border-color: var(--color-primary);
  color: var(--color-primary-fg);
  font-weight: 600;
}

.window-form { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
.window-form label { display: inline; }
.window-form input { width: 5rem; min-height: 2.5rem; }
/* In the rail there is no room for a label, a field, a hint and a button on one
   row, and a row that wraps at an arbitrary point is four things a User has to
   re-read. Stacked, each of them is a line of its own and the order is the order
   they are read in. */
.rail .window-form { flex-direction: column; align-items: stretch; }
.rail .window-form input { width: 100%; }
.rail .window-form button { width: 100%; }

.empty-state { max-width: var(--measure); color: var(--color-text-muted); }
.empty-state__actions { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-top: var(--space-2); }

/* A bordered panel for one drawing, so the page's figures are set off from its
   prose rather than floating between it. */
.panel {
  padding: var(--space-4) var(--space-5) var(--space-5);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
}
.panel > :first-child { margin-top: 0; }
.panel > :last-child { margin-bottom: 0; }
.panel > h2 { font-family: var(--font-sans); font-size: var(--text-lg); text-transform: none; letter-spacing: -0.01em; color: var(--color-text); margin-bottom: var(--space-2); }

/* The Archive search form and its results. The filters come before the box, which
   reads backwards from what a User does: they usually type first and narrow second,
   and the controls they have not touched yet should not be the loudest thing on the
   page. Two columns of filters rather than six, so the box does not end up below
   the fold on a phone. */
.archive-search {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr));
  align-items: end;
  gap: var(--space-3);
  padding: var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-lg);
  background: var(--color-surface);
  margin-bottom: var(--space-5);
}
/* The label wraps its control, so one field is one grid cell at every width. */
.archive-search > label { gap: var(--space-1); }
.archive-search > .actions { grid-column: 1 / -1; margin-top: 0; }
.results { list-style: none; margin: 0; padding: 0; display: grid; gap: var(--space-5); }
.results li { padding-bottom: var(--space-4); border-bottom: 1px solid var(--color-rule); }
.results li:last-child { border-bottom: 0; padding-bottom: 0; }
.results__kind { margin: 0 0 var(--space-1); font-family: var(--font-mono); font-size: var(--text-xs); text-transform: uppercase; letter-spacing: 0.08em; color: var(--color-text-muted); }
.results__title { margin: 0 0 var(--space-2); font-family: var(--font-serif); font-size: var(--text-lg); font-weight: 600; }
.results__title a { color: var(--color-link); }

/* ---------------------------------------------------------------- the trends */
/* The chart is a drawing, so it needs no colours a User has to read a label to
   interpret: the two lines are told apart by weight and dash, which survives a
   monochrome print and is the one distinction a colour-blind reader does not need
   the legend for. The legend carries the names, and the table under the chart
   carries the numbers. */
.trend-chart { display: block; width: 100%; height: auto; margin: var(--space-4) 0 var(--space-2); overflow: visible; }
.trend-chart__axis { stroke: var(--color-border-subtle); stroke-width: 1; }
/* The scale the shape is read against. The gridline is a rule rather than a line:
   it is behind the data and says nothing about it, so it is the lightest rule on
   the page and not the second line. */
.trend-chart__grid { stroke: var(--color-rule); stroke-width: 1; }
.trend-chart__tick { fill: var(--color-text-muted); font-family: var(--font-mono); font-size: 10px; }
.trend-chart__articles { fill: none; stroke: var(--color-primary); stroke-width: 2; stroke-linejoin: round; }
.trend-chart__stories { fill: none; stroke: var(--color-text-muted); stroke-width: 2; stroke-dasharray: 4 3; stroke-linejoin: round; }
/* The spike rules sit under the lines so a mark never hides the data it marks. */
.spike-marker { stroke: var(--color-spike); stroke-width: 1; stroke-dasharray: 2 3; }

.legend { display: flex; flex-wrap: wrap; gap: var(--space-4); list-style: none; padding: 0; margin: 0 0 var(--space-4); font-size: var(--text-sm); color: var(--color-text-muted); }
.legend li { display: flex; align-items: center; gap: var(--space-2); }
.legend__swatch { display: inline-block; width: 1.5rem; height: 0; border-top: 2px solid var(--color-primary); }
.legend__swatch--stories { border-top-style: dashed; border-top-color: var(--color-text-muted); }

.trend-table { width: 100%; border-collapse: collapse; font-size: var(--text-sm); margin: 0 0 var(--space-5); }
.trend-table caption { text-align: left; color: var(--color-text-muted); padding-bottom: var(--space-2); }
.trend-table th, .trend-table td { text-align: left; padding: var(--space-1) var(--space-2); border-bottom: 1px solid var(--color-rule); }
.trend-table td { text-align: right; font-variant-numeric: tabular-nums; }

/* The terms that are getting louder, as chips rather than as rows. A list of rows
   asks a reader to scan a column; a list of chips can be read as one field of
   words, which is what a set of emerging terms is. Each chip still carries its own
   series, because a ratio with nothing drawn under it is a claim nobody can check,
   so the chip is a shape with a name in it rather than a name with a number beside
   it. The sparkline is placed after the name so it is read second. */
.entities { list-style: none; padding: 0; margin: 0 0 var(--space-5); display: flex; flex-wrap: wrap; gap: var(--space-3); }
.entity {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
  max-width: 100%;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-pill);
  background: var(--color-surface);
}
.entity__name { font-weight: 600; }
.entity__mentions { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-text-muted); }
.entity__lift { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--color-success); }
.sparkline { display: block; flex: none; }
.sparkline polyline { fill: none; stroke: var(--color-primary); stroke-width: 1.5; stroke-linejoin: round; }

/* What caused each jump. The date is fixed-width because the dates are the thing a
   reader scans this list for. */
.spikes { list-style: none; padding: 0; margin: 0 0 var(--space-5); }
.spikes li { padding: var(--space-2) 0; border-bottom: 1px solid var(--color-rule); font-size: var(--text-sm); display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: baseline; }
.spike__date { font-family: var(--font-mono); font-variant-numeric: tabular-nums; color: var(--color-text-muted); min-width: 6rem; }
.spike__size { color: var(--color-text-muted); }
.spike__clusters { flex: 1 1 16rem; }

/* ------------------------------------------------------------------ spacing */
@media (min-width: 40rem) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }
  /* Hour, minute and timezone only fit on one row once there is room for the
     timezone's full name; below this they stack. */
  .row { grid-template-columns: 5rem 5rem 1fr; }
}

@media (min-width: 62rem) {
  /* The point the rail has room for itself. Below it the feed is one column and
     the rail is simply the next block down, which is the order a phone reads in
     anyway: what the page is about, then what to do about it. */
  .feed { grid-template-columns: minmax(0, 1fr) var(--rail); gap: var(--space-6); }
  .feed__rail { position: sticky; top: var(--space-4); }
}

@media (max-width: 39.99rem) {
  /* The account summary drops below the navigation and each of its parts takes a
     line of its own. Beside the navigation it competes for width with five links
     the User has to read, and the email in particular ends up ellipsised to
     nothing. */
  .account {
    grid-template-columns: minmax(0, 1fr);
    grid-template-areas:
      "who"
      "brief"
      "logout";
    justify-items: start;
  }
  .account__brief { text-align: left; }
  .account__email { max-width: 100%; }
}

@media (min-width: 64rem) {
  body { font-size: 1.0625rem; }
  .page { padding: var(--space-7) var(--space-5) var(--space-8); }
}

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}

@media print {
  .site-header, .site-footer, .hide-row, .window-form, .skip-link { display: none; }
  body { color: #000; }
}
`;