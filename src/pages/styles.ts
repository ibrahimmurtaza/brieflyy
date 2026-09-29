/**
 * One stylesheet for every page, inlined by `layout()` in `./layout.ts`.
 *
 * Three layers, in the order a change should be made: a primitive is a raw
 * value, a semantic token says what a value is *for*, and a component rule
 * consumes only semantic tokens. Nothing below the semantic layer is allowed to
 * name a raw colour, so a value can be retuned in one place and every screen
 * that means the same thing moves together.
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
 *   --color-text        #111827 on #ffffff   17.7:1   body copy
 *   --color-text-muted  #5b6472 on #ffffff    5.98:1  meta, hints, empty states
 *   --color-link        #1856c4 on #ffffff    6.63:1  link text
 *   --color-primary     #1b5fd0 with #ffffff  5.84:1  button fill
 *   --color-danger      #b00020 on #ffffff    7.33:1  error copy
 *   --color-success     #1a7f37 on #ffffff    5.08:1  success copy
 *   --color-border      #767676 on #ffffff    4.54:1  control boundary (needs 3:1)
 *   --color-focus-ring  #1b5fd0 on #ffffff    5.84:1  focus indicator (needs 3:1)
 */
export const STYLESHEET = `/* Brieflyy design tokens and page rules. Generated once, inlined on every page. */

/* ---------------------------------------------------------------- primitives */
:root {
  /* Colour: a single ramp, plus the two accents the product actually uses. */
  --gray-0: #ffffff;
  --gray-25: #f7f8fa;
  --gray-100: #e9ecf0;
  --gray-200: #d5dae1;
  --gray-400: #9aa3af;
  --gray-500: #6b7280;
  --gray-600: #4b5563;
  --gray-700: #374151;
  --gray-900: #111827;

  --blue-50: #eef4fd;
  --blue-100: #dbe8fb;
  --blue-600: #1b5fd0;
  --blue-700: #1856c4;

  --red-50: #fdf2f2;
  --red-200: #f0baba;
  --red-700: #b00020;

  --green-50: #e6f4ea;
  --green-200: #a3d4a8;
  --green-700: #1a7f37;

  --amber-50: #fff5d6;
  --amber-300: #e0c66b;
  --amber-800: #7a4f01;

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
  --text-xs: 0.8125rem;
  --text-sm: 0.875rem;
  --text-base: 1rem;
  --text-lg: 1.125rem;
  --text-xl: 1.375rem;
  --text-2xl: 1.75rem;

  --font-sans: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;

  /* Shape and depth. */
  --radius-sm: 4px;
  --radius-md: 8px;
  --radius-pill: 999px;
  --shadow-card: 0 1px 2px rgba(17, 24, 39, 0.06);
  --shadow-pop: 0 6px 24px rgba(17, 24, 39, 0.12);

  /* Motion. Kept short, and switched off wholesale by the media query at the
     end of this file. */
  --transition: 120ms ease-out;

  /* ---------------------------------------------------------------- semantics */
  --color-canvas: var(--gray-0);
  --color-surface: var(--gray-25);
  --color-surface-sunken: var(--gray-100);
  --color-text: var(--gray-900);
  --color-text-muted: #5b6472;
  --color-text-subtle: var(--gray-600);
  --color-link: var(--blue-700);
  --color-link-hover: var(--blue-600);
  --color-primary: var(--blue-600);
  --color-primary-hover: var(--blue-700);
  --color-primary-fg: var(--gray-0);
  --color-danger: var(--red-700);
  --color-danger-surface: var(--red-50);
  --color-success: var(--green-700);
  --color-success-surface: var(--green-50);
  --color-border: #767676;
  --color-border-subtle: var(--gray-200);
  --color-rule: var(--gray-100);
  --color-focus-ring: var(--blue-600);
  --color-chip-bg: var(--gray-100);
  --color-chip-fg: var(--gray-700);
  --color-notice-surface: var(--blue-50);
  --color-notice-border: var(--blue-100);
  --color-notice-text: #12447e;
  --color-paywall-surface: var(--amber-50);
  --color-paywall-border: var(--amber-300);
  --color-paywall-text: var(--amber-800);

  /* Measure: how wide a line of prose is allowed to be, and how wide a page of
     controls is allowed to be. Four pages used to disagree about the second. */
  --measure: 68ch;
  --page-narrow: 30rem;
  --page-form: 36rem;
  --page-default: 44rem;
  --page-reading: 48rem;
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

h1, h2, h3 { line-height: 1.25; text-wrap: balance; }
h1 { font-size: var(--text-2xl); margin: 0 0 var(--space-2); letter-spacing: -0.01em; }
h2 { font-size: var(--text-lg); margin: 0 0 var(--space-2); }
h3 { font-size: var(--text-base); margin: 0 0 var(--space-1); }

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

/* --------------------------------------------------------------------- shell */
.site-header {
  border-bottom: 1px solid var(--color-rule);
  background: var(--color-canvas);
}
.site-header__inner {
  margin: 0 auto;
  padding: var(--space-3) var(--space-4);
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3) var(--space-4);
}
/* The header shares the page's measure rather than imposing one of its own, so
   the wordmark, the navigation and the page's own content share a left edge. */
.site-header__inner--narrow { max-width: calc(var(--page-narrow) + var(--space-8)); }
.site-header__inner--form { max-width: calc(var(--page-form) + var(--space-8)); }
.site-header__inner--default { max-width: calc(var(--page-default) + var(--space-8)); }
.site-header__inner--reading { max-width: calc(var(--page-reading) + var(--space-8)); }
.wordmark {
  font-weight: 700;
  font-size: var(--text-lg);
  letter-spacing: -0.02em;
  color: var(--color-text);
  text-decoration: none;
  display: inline-flex;
  align-items: center;
  min-height: 2rem;
}
.wordmark:hover { color: var(--color-link); }
.site-nav { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); margin-right: auto; }
.site-nav a {
  display: inline-flex;
  align-items: center;
  min-height: 2rem;
  padding: 0 var(--space-2);
  border-radius: var(--radius-md);
  color: var(--color-text-subtle);
  text-decoration: none;
  font-size: var(--text-sm);
}
.site-nav a:hover { color: var(--color-link); text-decoration: underline; }
.site-nav a[aria-current="page"] { color: var(--color-text); font-weight: 600; }

.account { display: flex; align-items: center; gap: var(--space-3); }
.account__email {
  font-size: var(--text-xs);
  color: var(--color-text-muted);
  max-width: 22ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.page { flex: 1 0 auto; width: 100%; margin: 0 auto; padding: var(--space-6) var(--space-4) var(--space-8); }
.page--narrow { max-width: var(--page-narrow); }
.page--form { max-width: var(--page-form); }
.page--default { max-width: var(--page-default); }
.page--reading { max-width: var(--page-reading); }
.page--reading > p, .page--reading > .lede { max-width: var(--measure); }

.site-footer {
  flex: 0 0 auto;
  border-top: 1px solid var(--color-rule);
  color: var(--color-text-muted);
  font-size: var(--text-xs);
}
.site-footer__inner {
  max-width: calc(var(--page-reading) + var(--space-8));
  margin: 0 auto;
  padding: var(--space-4);
}
.site-footer p { margin: 0; }

/* ---------------------------------------------------------------- typography */
.lede { color: var(--color-text-subtle); font-size: var(--text-lg); margin-top: 0; margin-bottom: var(--space-5); }
.muted { color: var(--color-text-muted); }
.hint { color: var(--color-text-muted); font-size: var(--text-sm); }
.plan { color: var(--color-text-muted); font-size: var(--text-sm); }
.prose { max-width: var(--measure); }
.eyebrow {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.06em;
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
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--color-border);
  border-radius: var(--radius-md);
  background: var(--color-canvas);
  color: var(--color-text);
  min-height: 2.75rem;
  width: 100%;
}
input[type="checkbox"] { width: auto; min-height: 0; margin: 0; }
input:disabled, select:disabled { background: var(--color-surface); color: var(--color-text-muted); }
[aria-invalid="true"] { border-color: var(--color-danger); }

/* One button shape, one secondary shape, one quiet shape. */
button, .button {
  font: inherit;
  font-size: var(--text-base);
  line-height: 1.2;
  min-height: 2.75rem;
  padding: var(--space-2) var(--space-4);
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
  border-color: var(--color-border);
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
   announcing a message does not move the submit button out from under it. */
.status { min-height: 1.5rem; font-size: var(--text-sm); }
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
section > h2 { font-size: var(--text-sm); text-transform: uppercase; letter-spacing: 0.06em; color: var(--color-text-muted); }

/* A selectable Directory card. The whole card is the label, so the checkbox and
   the text are one target. */
.card {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: var(--space-1) var(--space-3);
  padding: var(--space-3) var(--space-4);
  border: 1px solid var(--color-border-subtle);
  border-radius: var(--radius-md);
  background: var(--color-canvas);
  cursor: pointer;
  box-shadow: var(--shadow-card);
  transition: border-color var(--transition), background-color var(--transition);
}
.card:hover { border-color: var(--color-border); }
.card:has(input:checked) { border-color: var(--color-primary); background: var(--color-notice-surface); }
.card:has(input:focus-visible) { outline: 2px solid var(--color-focus-ring); outline-offset: 2px; }
.card input { grid-row: 1 / span 2; align-self: start; margin-top: 0.2rem; }
.card .title { font-weight: 600; }
.card .blurb { color: var(--color-text-muted); font-size: var(--text-sm); }

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
.topics a { font-size: var(--text-lg); text-decoration: none; }
.topics a:hover { text-decoration: underline; }

/* ----------------------------------------------------------------- the brief */
.cluster { padding: var(--space-5) 0; border-top: 1px solid var(--color-rule); }
.cluster h2 { font-size: var(--text-lg); margin: 0 0 var(--space-3); max-width: var(--measure); }
.cluster ul { margin: 0 0 var(--space-3); padding-left: var(--space-5); line-height: 1.7; max-width: var(--measure); }
.cluster li + li { margin-top: var(--space-1); }
.sources { font-size: var(--text-sm); color: var(--color-text-muted); margin-bottom: var(--space-2); }
.source {
  display: inline-block;
  margin: 0 var(--space-1) var(--space-1) 0;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-pill);
  background: var(--color-chip-bg);
  color: var(--color-chip-fg);
  font-size: var(--text-xs);
  text-decoration: none;
}
.source:hover { background: var(--blue-100); color: var(--color-text); }

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
.articles .outlet { color: var(--color-text-muted); }
.articles a { display: inline-block; min-height: 1.5rem; text-decoration: none; }
.articles a:hover { text-decoration: underline; }

.filter-bar, .window-form { font-size: var(--text-sm); color: var(--color-text-muted); margin: 0 0 var(--space-5); }
.filter-bar { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--space-2); }
.filter-bar > .filter-bar__label { color: var(--color-text-muted); }
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

.empty-state { max-width: var(--measure); color: var(--color-text-muted); }
.empty-state__actions { display: flex; flex-wrap: wrap; gap: var(--space-4); margin-top: var(--space-2); }

/* ------------------------------------------------------------------ spacing */
@media (min-width: 40rem) {
  .grid { grid-template-columns: repeat(auto-fill, minmax(15rem, 1fr)); }
  /* Hour, minute and timezone only fit on one row once there is room for the
     timezone's full name; below this they stack. */
  .row { grid-template-columns: 5rem 5rem 1fr; }
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
