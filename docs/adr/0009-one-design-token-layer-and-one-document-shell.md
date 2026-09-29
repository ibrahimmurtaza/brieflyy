# ADR 0009: One design-token layer and one document shell for every page

## Decision

Every HTML page is produced by a single `layout()` in `src/pages/layout.ts`, and
every page is styled by the one stylesheet inlined by that function. The
stylesheet is three layers — primitive, semantic, component — and nothing below
the semantic layer names a raw colour.

The application is **light only**. `color-scheme: light dark` was declared on
seven pages with no dark rules anywhere, so the browser painted a dark canvas
under styles written for a white one: body text at 2.7:1, and the Google button
and the delivery-time fields rendering white on white. A dark palette is now a
change to the semantic layer rather than a rewrite of the pages.

Navigation and sign-out live in the shell's `<header>`. Page content is
everything inside `<main>`. The distinction matters because `/upgrade` is
asserted to contain no form, and a sign-out form in the header is not a checkout.

The BriefSnapshot email is styled separately, with inline styles and a single
600px table, because email clients strip a `<style>` block in the head.

## Why one shell rather than a framework

There is no bundler, no build step for assets, and no bundler to add one
without. Sixteen page functions used to carry thirteen `<style>` blocks between
them, six different `max-width` values, three `h1` sizes and four border radii,
so the visual difference between two screens was a fact about which file it was
written in. One `layout()` and one stylesheet removes that with no new
dependency and no route change.

Webfonts were rejected. The `ui-ux-pro-max` design-system run for this product
returned a Newsreader/Roboto editorial pairing, and its *intent* — a constrained
measure, generous leading, a strong heading scale — is adopted. Loading the
fonts themselves is rejected: it would add a third-party request to every page
and a preconnect, for a system stack that is already installed everywhere.

## What the tokens buy

The semantic values are chosen against their own backgrounds and the ratios are
written into the header comment of `src/pages/styles.ts`, so a later edit knows
what it has to keep:

| Token | Value | On | Ratio |
|---|---|---|---|
| `--color-text` | `#111827` | canvas | 17.7:1 |
| `--color-text-muted` | `#5b6472` | canvas | 5.98:1 |
| `--color-link` | `#1856c4` | canvas | 6.63:1 |
| `--color-primary` | `#1b5fd0` | white text | 5.84:1 |
| `--color-danger` | `#b00020` | canvas | 7.33:1 |
| `--color-border` | `#767676` | canvas | 4.54:1 (3:1 needed) |
| `--color-focus-ring` | `#1b5fd0` | canvas | 5.84:1 (3:1 needed) |

`--color-primary` is darker than the `#1f6feb` the application used. That value
passes AA as link text by 0.13 of a ratio and fails as a button fill carrying
white text at large size, because the same hex was doing both jobs; splitting
`--color-link` from `--color-primary` is what lets each be right.

`#1f6feb` is retained as the **provisional brand blue**. No brand guidelines,
palette or logo asset exists in the repository, and none was invented: the
wordmark is set in the system font rather than a generated mark.

## Consequences

- A page cannot forget the viewport tag, a skip link, landmarks, a focus ring or
  a consistent `<title>` suffix, because it does not write its own `<head>`.
- Dark mode is now a `@media (prefers-color-scheme: dark)` block redefining
  roughly fifteen semantic tokens. It is not written yet: it needs its own
  contrast pass, and carrying light values into a dark palette is how the
  original defect happened.
- Two pages carry a `<script>` (sign-in, topic picker) and therefore cannot get
  the client-side enhancement layer. That constraint is asserted by a test and by
  a browser spec, so it stays a decision rather than an accident.
