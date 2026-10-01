import { pad2, partsInTz } from '../domain/timezone.js';

/**
 * How an instant reads to a person on a web page, in the zone they keep their
 * hours in.
 *
 * Every date a User reads on a page has to name the zone it is in, because a
 * clock reading on its own is a claim without a frame. The pages and the shared
 * header between them show more than one such date, and they must read the same
 * way: two spellings of the same instant in one application is one more thing a
 * reader of a screenshot has to reconcile.
 *
 * The plain-text renderers do not come through here — the welcome email spells a
 * date in its own sentence because a body of plain text is not a page, and the
 * BriefSnapshot renderer cannot use a `<style>` block at all. This is the one
 * spelling for the one medium this owns.
 */
export function formatHumanTime(date: Date, timezone: string): string {
  const parts = partsInTz(date, timezone);
  const month = MONTH_NAMES[parts.month - 1] ?? '';
  return `${parts.weekday}, ${parts.day} ${month} at ${pad2(parts.hour)}:${pad2(parts.minute)}`;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];