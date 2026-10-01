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

The `<header>` also carries the three facts a User cannot work out for themselves
without leaving the page: who is signed in, which tier they are on, and when
their next brief arrives. They are read once per request by `resolveShellAccount`
in `src/pages/shell.ts` and handed to every page as one `ShellAccount`, because a
header that varies between two pages of the same visit is not a fact about the
User. The next brief has three states rather than one — scheduled, no delivery
time chosen, and emails stopped — because a header that promised a brief which
will not arrive is worse than one that says nothing, and a User who has not
chosen a time has not missed anything. Each state links to the page that changes
it, so the header is the one piece of every page a User can act on from anywhere.

An address that leads nowhere renders a page, not the framework's JSON. A
signed-in User lands inside the shell with the way back to their topics; an
anonymous one is offered sign-in rather than a navigation full of pages they
cannot reach. `/api/` is the exception and stays JSON, following the rule the
rest of the application already uses: a JSON surface answers JSON even when the
address is wrong.

The BriefSnapshot email is styled separately, with inline styles and a single
600px table, because email clients strip a `<style>` block in the head.

`GET /briefs/:id` is the one page served without `layout()`, and the exception is
the same one seen from the other side. A BriefSnapshot is by definition the
document that was emailed, so the route serves the stored bytes rather than
re-wrapping them in the application shell — a brief re-rendered through
`layout()` would be a different document from the one the User received, which is
the property the snapshot exists to keep. The consequence the shell normally
prevents is covered by a test instead: the stored document must carry its own
links back into the application, so a User who lands on it is not stranded on a
page with no navigation.

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
- A page cannot be added without saying who is signed in, because `layout()`
  requires an account and will not default one. Stating `null` is the only way to
  get a page with no navigation on it, which is what the sign-in page, the two
  sign-in failure pages and the not-found page for an anonymous visitor do — each
  of them because there is no signed-in User yet, not by omission. The list of
  signed-in pages is written out in `src/pages/shell.test.ts` so each one fails on
  its own, and reconciled against the route manifest by a second test so a route
  added later and not listed fails too.
- The observability views of the two background jobs (`/admin/ingest`,
  `/admin/briefs`) are pages of the application and get the shell like any other.
  They were the last two documents rendering through `layout()` with no account,
  which left an operator with no way out of them. They are deliberately absent
  from `PRIMARY_NAV`: they are the two background jobs' observability views, not
  a section of the product, and putting them beside "Topics" would offer every
  User a page about an operator's problem.
- Dark mode is now a `@media (prefers-color-scheme: dark)` block redefining
  roughly fifteen semantic tokens. It is not written yet: it needs its own
  contrast pass, and carrying light values into a dark palette is how the
  original defect happened.
- Two pages carry a `<script>` (sign-in, topic picker) and therefore cannot get
  the client-side enhancement layer. That constraint is asserted by a test and by
  a browser spec, so it stays a decision rather than an accident.
