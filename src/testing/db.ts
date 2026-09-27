/** Count the rows of a table, for tests that assert on what was persisted. */
export function countRows(
  driver: { prepare(sql: string): { get(): unknown } },
  table: string,
): number {
  return (driver.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}
