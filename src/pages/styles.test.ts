import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { STYLESHEET } from './styles.js';

/**
 * The claim the Tests section's bullet for this file makes, and the claim this
 * file holds the build over: `docs-agreement.test.ts` requires the bullet to carry
 * this sentence, so the README cannot promise a check that is not here.
 */
export const GUARD =
  "the contrast ratios the stylesheet's header comment documents are the ratios";

// Normalised, because a Windows checkout hands this file over with carriage
// returns and every pattern below is anchored to a line ending.
const STYLES_TS = readFileSync(
  join(resolve(dirname(fileURLToPath(import.meta.url))), 'styles.ts'),
  'utf8',
).replace(/\r\n/g, '\n');

/**
 * The contrast ratios `src/pages/styles.ts` documents are checked here rather than
 * believed.
 *
 * The header comment lists eight pairs with the ratio each one holds, which is
 * what a later edit needs to know — but a number written in a comment is a number
 * nobody recomputes. It was true when it was written, it was copied out of a
 * contrast checker by hand, and a retune of `--blue-600` would have left it
 * asserting a ratio the stylesheet no longer has while the comment stayed
 * confident. A comment that has to be kept true by the same person who edits the
 * value is a comment that will eventually not be.
 *
 * So the pairs are read out of the comment, the colours are resolved out of the
 * `:root` block the same way a browser resolves them, and the ratio is computed
 * from the resolved values. Three things are then true that a comment alone
 * cannot be:
 *
 * - the hex in the comment is the value the token actually has,
 * - the ratio in the comment is the ratio those two values actually hold,
 * - and the pair holds the minimum its own note claims it needs.
 */

/** `--token: #aabbcc` or `--token: var(--other)` declarations in `:root`. */
const ROOT_BLOCK = /:root\s*\{([\s\S]*?)\n\}/;

/** Every `--name: value` declaration in the `:root` block. */
function tokenValues(stylesheet: string): Map<string, string> {
  const block = ROOT_BLOCK.exec(stylesheet)?.[1];
  if (block === undefined) throw new Error('the stylesheet has no :root block in it');
  const values = new Map<string, string>();
  for (const match of block.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) {
    values.set(match[1] as string, (match[2] as string).trim());
  }
  return values;
}

/** A token's colour, following `var()` references until there is a hex. */
function resolveToken(name: string, values: ReadonlyMap<string, string>): string {
  const seen: string[] = [];
  let value = values.get(name);
  while (value !== undefined && value.startsWith('var(')) {
    if (seen.includes(name)) throw new Error(`${name} refers to itself`);
    seen.push(name);
    const referenced = /var\(--([\w-]+)\)/.exec(value)?.[1];
    if (referenced === undefined) throw new Error(`${name} has a value this cannot follow: ${value}`);
    value = values.get(referenced);
    name = referenced;
  }
  if (value === undefined) throw new Error(`the stylesheet declares no --${name}`);
  return value;
}

/** One row of the documented table. */
interface DocumentedPair {
  readonly token: string;
  readonly foreground: string;
  readonly background: string;
  readonly ratio: number;
  readonly decimals: number;
  readonly note: string;
}

/** The minimum a pair has to hold, read from the note rather than assumed. */
function minimumFor(note: string): number {
  const stated = /needs\s+([\d.]+):1/.exec(note)?.[1];
  if (stated !== undefined) return Number(stated);
  // Nothing stated means the default for text, which is AA. A control boundary or
  // a focus indicator is allowed 3:1 and the note says so.
  return 4.5;
}

/**
 * The header comment's table.
 *
 * `--token   #foreground on #background   ratio:1   note`, which is the shape the
 * comment already uses. Only rows that name two colours are read: the prose
 * paragraphs around the table mention tokens without pairing them, and a parser
 * that swallowed those would report a pair nobody wrote.
 */
function documentedPairs(stylesheet: string): DocumentedPair[] {
  // The table lives in the module's own header comment, above the template
  // literal the stylesheet is written in — it documents the module rather than
  // being part of what a page is served. Read from the source rather than from
  // `STYLESHEET`, so the numbers a reader finds by opening `styles.ts` are the
  // ones checked here.
  const header = /^\/\*\*\n([\s\S]*?)\*\//.exec(stylesheet)?.[1] ?? '';
  const pairs: DocumentedPair[] = [];
  for (const line of header.split('\n')) {
    const match =
      /^\s*\*\s+(--[\w-]+)\s+(#[0-9a-f]{6})\s+(?:on|with)\s+(#[0-9a-f]{6})\s+(\d+(?:\.\d+)?):1\s*(.*)$/.exec(
        line,
      );
    if (match === null) continue;
    const ratio = match[4] as string;
    pairs.push({
      token: (match[1] as string).slice(2),
      foreground: match[2] as string,
      background: match[3] as string,
      ratio: Number(ratio),
      decimals: ratio.includes('.') ? (ratio.split('.')[1] as string).length : 0,
      note: (match[5] ?? '').trim(),
    });
  }
  return pairs;
}

/** The WCAG relative luminance of a `#rrggbb` colour. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((offset) => {
    const raw = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return raw <= 0.03928 ? raw / 12.92 : ((raw + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** The WCAG contrast ratio between two `#rrggbb` colours. */
function contrastRatio(a: string, b: string): number {
  const first = luminance(a);
  const second = luminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

const VALUES = tokenValues(STYLESHEET);
const DOCUMENTED = documentedPairs(STYLES_TS);

describe('the contrast ratios the stylesheet documents', () => {
  it('documents the pairs it can check', () => {
    // The table is what this file reads, so a parser that matched nothing would
    // leave every other assertion here passing over an empty list — the same
    // failure the wiring guard had. Held to the pairs the comment is known to
    // carry, so a rename or a reformat fails here rather than silently emptying.
    expect(DOCUMENTED.length).toBeGreaterThanOrEqual(8);
    expect(DOCUMENTED.map((pair) => pair.token)).toEqual(
      expect.arrayContaining([
        'color-text',
        'color-text-muted',
        'color-link',
        'color-primary',
        'color-danger',
        'color-success',
        'color-border',
        'color-focus-ring',
      ]),
    );
  });

  for (const pair of DOCUMENTED) {
    it(`--${pair.token} on ${pair.background} holds ${pair.ratio}:1`, () => {
      const foreground = resolveToken(pair.token, VALUES);

      expect(
        foreground,
        `--${pair.token} is ${foreground}, not the ${pair.foreground} the header comment documents`,
      ).toBe(pair.foreground);

      const computed = contrastRatio(foreground, pair.background);
      expect(
        Number(computed.toFixed(pair.decimals)),
        `--${pair.token} on ${pair.background} is ${computed.toFixed(2)}:1, not the ${pair.ratio}:1 the header comment documents`,
      ).toBe(pair.ratio);

      expect(
        computed,
        `--${pair.token} on ${pair.background} holds ${computed.toFixed(2)}:1 and needs ${minimumFor(pair.note)}:1 (${pair.note})`,
      ).toBeGreaterThanOrEqual(minimumFor(pair.note));
    });
  }
});

describe('the token pairs a component rule draws', () => {
  /**
   * The pairings a component rule makes by naming two semantic tokens, which the
   * header comment does not list because a pair belongs to a rule rather than to a
   * token.
   *
   * A contrast ratio belongs to a pair, and the pairs that matter are the ones the
   * stylesheet actually draws. `.callout--success` is the one that found the real
   * defect: success green was 5.08:1 on the canvas and 4.47:1 on its own surface,
   * so a callout that tinted its background lost a step while both tokens still
   * looked right on their own.
   *
   * Listed rather than derived, and that is a decision rather than a shortcut: which
   * rule draws which pair is a judgement about the design, and a check that read the
   * pairings back out of the stylesheet would only re-derive the rules it already
   * has. So the list is the claim, and a rule added without a pair here is a pair
   * nobody checked — which the last assertion in this block makes visible rather
   * than pretending to have caught.
   *
   * The hover pairs are here because a hover is a background too, and a colour that
   * clears AA at rest and loses it under a pointer is the same defect one state
   * later. Rules that pair text on a surface rather than on the canvas are covered
   * as well, which is where `--color-surface` earns its keep.
   */
  const COMPONENT_PAIRS: readonly {
    readonly rule: string;
    readonly foreground: string;
    readonly background: string;
    readonly minimum: number;
  }[] = [
    { rule: 'body', foreground: 'color-text', background: 'color-canvas', minimum: 4.5 },
    { rule: 'a', foreground: 'color-link', background: 'color-canvas', minimum: 4.5 },
    { rule: 'a:hover', foreground: 'color-link-hover', background: 'color-canvas', minimum: 4.5 },
    { rule: '.lede', foreground: 'color-text-subtle', background: 'color-canvas', minimum: 4.5 },
    { rule: '.muted', foreground: 'color-text-muted', background: 'color-canvas', minimum: 4.5 },
    { rule: 'button', foreground: 'color-primary-fg', background: 'color-primary', minimum: 4.5 },
    { rule: '.filter-bar a.selected', foreground: 'color-primary-fg', background: 'color-primary', minimum: 4.5 },
    { rule: '.secondary', foreground: 'color-text', background: 'color-canvas', minimum: 4.5 },
    { rule: '.secondary:hover', foreground: 'color-text', background: 'color-surface', minimum: 4.5 },
    { rule: '.quiet:hover', foreground: 'color-link-hover', background: 'color-surface', minimum: 4.5 },
    { rule: '.callout', foreground: 'color-notice-text', background: 'color-notice-surface', minimum: 4.5 },
    { rule: '.callout--paywall', foreground: 'color-paywall-text', background: 'color-paywall-surface', minimum: 4.5 },
    { rule: '.callout--error', foreground: 'color-danger', background: 'color-danger-surface', minimum: 4.5 },
    { rule: '.callout--success', foreground: 'color-success', background: 'color-success-surface', minimum: 4.5 },
    { rule: '.error-summary a', foreground: 'color-danger', background: 'color-danger-surface', minimum: 4.5 },
    { rule: '.status.error', foreground: 'color-danger', background: 'color-canvas', minimum: 4.5 },
    { rule: '.source', foreground: 'color-chip-fg', background: 'color-chip-bg', minimum: 4.5 },
    // A primitive background, and the only one left: ADR-0009 says nothing below
    // the semantic layer names a raw colour, and `.source:hover` does. Checked
    // here rather than left alone, because a rule that breaks the layering should
    // at least break the build on the value it draws.
    { rule: '.source:hover', foreground: 'color-text', background: 'blue-100', minimum: 4.5 },
    { rule: '.account__tier', foreground: 'color-chip-fg', background: 'color-chip-bg', minimum: 4.5 },
    { rule: '.card--held .title', foreground: 'color-text-subtle', background: 'color-surface', minimum: 4.5 },
    { rule: '.entity__lift', foreground: 'color-success', background: 'color-canvas', minimum: 4.5 },
    { rule: 'input:disabled', foreground: 'color-text-muted', background: 'color-surface', minimum: 4.5 },
  ];

  it('pairs tokens the stylesheet declares', () => {
    for (const pair of COMPONENT_PAIRS) {
      for (const token of [pair.foreground, pair.background]) {
        expect(VALUES.has(token), `the stylesheet declares no --${token}`).toBe(true);
      }
    }
  });

  for (const pair of COMPONENT_PAIRS) {
    it(`${pair.rule} holds ${pair.minimum}:1 or better`, () => {
      const ratio = contrastRatio(
        resolveToken(pair.foreground, VALUES),
        resolveToken(pair.background, VALUES),
      );
      expect(
        ratio,
        `${pair.rule} pairs --${pair.foreground} with --${pair.background} at ${ratio.toFixed(2)}:1, below the ${pair.minimum}:1 it needs`,
      ).toBeGreaterThanOrEqual(pair.minimum);
    });
  }

  it('covers every rule that draws a text colour on a background of its own', () => {
    // The one-direction check that keeps the list honest, and it is decidable: read
    // the rules that set both `color` and `background`, take the two semantic
    // tokens each names, and require every one of those pairings to be listed above.
    // A rule that pairs two colours without a pair here is a pair nobody checked,
    // and adding the rule to the stylesheet fails this rather than passing quietly.
    //
    // One-directional on purpose. A rule that sets only one of the two — `a:hover`,
    // `.secondary:hover` — inherits the other, and those pairs are in the list
    // because the inheritance is worth stating, not because a pattern found it.
    const drawn = [
      ...STYLESHEET.matchAll(/^\s*[^{]*\{([^}]*)\}/gm),
    ]
      .map((match) => match[1] ?? '')
      .filter(
        (body) =>
          /(?:^|;)\s*color\s*:/.test(body) && /(?:^|;)\s*background(?:-color)?\s*:/.test(body),
      )
      .map((body) => ({
        foreground: /(?:^|;)\s*color\s*:\s*var\(--([\w-]+)\)/.exec(body)?.[1],
        background: /(?:^|;)\s*background(?:-color)?\s*:\s*var\(--([\w-]+)\)/.exec(body)?.[1],
      }))
      .filter((pair) => pair.foreground !== undefined && pair.background !== undefined);

    const listed = new Set(
      COMPONENT_PAIRS.map((pair) => `${pair.foreground} on ${pair.background}`),
    );
    const unchecked = [
      ...new Set(
        drawn
          .map((pair) => `${pair.foreground} on ${pair.background}`)
          .filter((pair) => !listed.has(pair)),
      ),
    ].sort();

    expect(
      unchecked,
      'the stylesheet draws these colour pairs and no rule in this file checks them',
    ).toEqual([]);
  });
});