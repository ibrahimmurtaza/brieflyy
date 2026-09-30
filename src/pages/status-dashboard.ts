import { escapeHtml } from '../domain/html.js';
import { layout, type PageWidth } from './layout.js';

export interface StatusFact {
  readonly label: string;
  /**
   * The value, already escaped — a status fact is frequently an identifier or an
   * error string, and a fact that has to be escaped by each caller is one that
   * will eventually not be.
   */
  readonly value: string;
}

export interface StatusTable {
  readonly headings: readonly string[];
  /** One entry per cell, per row. Short rows are padded, so a caller does not. */
  readonly rows: readonly (readonly string[])[];
}

export interface StatusDashboardInput {
  readonly title: string;
  readonly width?: PageWidth;
  readonly facts: readonly StatusFact[];
  /** Omit when there is nothing tabular to show. */
  readonly table?: { readonly heading: string } & StatusTable;
}

/**
 * The one page shape for a background job's status.
 *
 * The ingest dashboard and the brief dashboard were the same document twice: a
 * heading, a list of name-and-value facts, and a table of recent work, each
 * assembled by hand with its own heading markup. A third background job would
 * have been a third copy, so the shape is here and each job supplies only what it
 * knows.
 *
 * Markup is emitted as written rather than through a template language because it
 * is a status page for an operator: what it says is more important than what it is
 * generated from, and it is already inside the document shell `layout` provides.
 */
export function renderStatusDashboard(input: StatusDashboardInput): string {
  const facts = input.facts
    .map((fact) => `      <dt>${escapeHtml(fact.label)}</dt><dd>${fact.value}</dd>`)
    .join('\n');
  const table =
    input.table === undefined
      ? ''
      : `
    <h2>${escapeHtml(input.table.heading)}</h2>
    <table>
      <thead>
        <tr>
${input.table.headings.map((h) => `          <th>${escapeHtml(h)}</th>`).join('\n')}
        </tr>
      </thead>
      <tbody>
${input.table.rows
  .map(
    (row) =>
      `        <tr>\n${row
        .map((cell) => `          <td>${cell}</td>`)
        .join('\n')}\n        </tr>`,
  )
  .join('\n')}
      </tbody>
    </table>`;

  return layout({
    title: input.title,
    width: input.width ?? 'reading',
    body: `    <h1>${escapeHtml(input.title)}</h1>
    <dl>
${facts}
    </dl>${table}`,
  });
}

/** A fact's value: plain text, escaped here so no caller has to remember. */
export function factValue(value: string | number | boolean | null): string {
  if (value === null) return '<em>never</em>';
  return escapeHtml(String(value));
}