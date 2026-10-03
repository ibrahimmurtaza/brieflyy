import { escapeHtml } from '../domain/html.js';
import { TOPIC_TITLE_MAX_LENGTH } from '../domain/slug.js';
import {
  CADENCES,
  DEFAULT_WEEKLY_DAY,
  WEEKDAYS,
  type Cadence,
  type Source,
  type Topic,
  type Weekday,
} from '../domain/types.js';
import { layout, type ShellAccount } from './layout.js';

/** How each Cadence reads on the page, and what it means for the next brief. */
const CADENCE_LABELS: Readonly<Record<Cadence, string>> = {
  daily: 'Daily — every morning',
  weekly: 'Weekly — once a week',
  never: 'Never — no briefs at all',
};

/** What each Cadence means, said in words rather than left to the radio button. */
const CADENCE_NOTES: Readonly<Record<Cadence, string>> = {
  daily: 'A brief arrives at your delivery time.',
  weekly: 'A brief arrives at your delivery time on the day you pick below.',
  never: 'This topic stays here and keeps updating, but no brief is emailed.',
};

const WEEKDAY_LABELS: Readonly<Record<Weekday, string>> = {
  sunday: 'Sunday',
  monday: 'Monday',
  tuesday: 'Tuesday',
  wednesday: 'Wednesday',
  thursday: 'Thursday',
  friday: 'Friday',
  saturday: 'Saturday',
};

/**
 * What the page says about the last thing that was changed.
 *
 * A `Map` rather than an object literal, because the key is a query string a
 * User can type. `?changed=constructor` indexes an object literal's prototype and
 * gets back `Object.prototype.constructor`, which is truthy — so a notice that was
 * never written renders a function as if it were a sentence, and the escaping it
 * goes through throws on it. A Map has no prototype to answer to, so the only
 * keys it has are the ones written here.
 *
 * Read back through a redirect rather than answered from the submission, so what
 * the User sees after saving is the page a reload would give them — including the
 * new value, which is the only proof the save happened.
 */
const CHANGED_NOTICES: ReadonlyMap<string, string> = new Map([
  ['name', 'Topic renamed.'],
  ['cadence', 'Brief timing saved.'],
  ['source-added', 'Source added.'],
  ['source-removed', 'Source removed.'],
]);

export interface TopicSettingsInput {
  readonly account: ShellAccount;
  readonly topic: Topic;
  readonly topicSlug: string;
  /** Every Source in the curated registry, for the "add" control. */
  readonly registry: readonly Source[];
  /** What the last form on this page changed, or null. */
  readonly changed: string | null;
  /**
   * Why a submission was refused, or null. The form that failed comes back with
   * what the User typed still in it, because they are here to correct something.
   */
  readonly message: string | null;
  /**
   * The title they typed, when a rename was refused. Null on every other screen,
   * so a page that did not fail never shows a half-typed title as if it were
   * saved.
   */
  readonly submittedTitle?: string | null;
}

/**
 * One Topic's settings: when it briefs, what it reads from, what it is called,
 * and whether it exists.
 *
 * Four things on one page rather than four places, because they are four answers
 * about one Topic and a User who has to find the right screen for each of them
 * will not find any of them. The alternative — spreading them over the LivingBrief,
 * the topic list and a settings index — is what left the Cadence recorded at
 * onboarding with nowhere to be read and the Source list able only to grow.
 *
 * The Source list is the interesting one. It is editable in both directions
 * because a curated default is a starting point and not a decision: the User can
 * only take an outlet away from a Topic that follows it, and can only add one the
 * registry has.
 */
export function topicSettingsPage(input: TopicSettingsInput): string {
  const slug = encodeURIComponent(input.topicSlug);
  // In the Topic's own order rather than the registry's. `position` on the link is
  // the order the User chose, and `topic.sourceIds` is the one read that keeps it;
  // filtering the registry instead would quietly reorder the list on every load.
  const byId = new Map(input.registry.map((source) => [source.id, source] as const));
  const followed = input.topic.sourceIds
    .map((id) => byId.get(id))
    .filter((source): source is Source => source !== undefined);
  const available = input.registry.filter(
    (source) => !input.topic.sourceIds.includes(source.id),
  );

  const notice = input.changed === null ? undefined : CHANGED_NOTICES.get(input.changed);
  const savedHtml = notice
    ? `    <div class="callout callout--success" role="status"><p>${escapeHtml(
        notice,
      )}</p></div>`
    : '';
  const errorHtml = input.message
    ? `    <div class="error-summary" role="alert" tabindex="-1">
      <p>${escapeHtml(input.message)}</p>
    </div>`
    : '';

  const title = input.submittedTitle ?? input.topic.title;

  return layout({
    title: `${input.topic.title} settings`,
    width: 'form',
    account: input.account,
    activeHref: null,
    body: `    <h1>${escapeHtml(input.topic.title)} settings</h1>
    <p class="lede">When this topic briefs, what it reads from, and whether it exists.</p>
    <p class="actions"><a href="/topics/${slug}">Back to this topic's brief</a></p>
${savedHtml}
${errorHtml}
${renameSection(input, slug, title)}
${cadenceSection(input, slug)}
${sourcesSection(input, slug, followed, available)}
${deleteSection(slug)}`,
  });
}

/**
 * What the Topic is called.
 *
 * The address does not change with it, and the page says so: the slug is what
 * briefs and links point at, and a User who has shared one should not find it
 * broken because they retyped a title.
 */
function renameSection(input: TopicSettingsInput, slug: string, title: string): string {
  return `    <section>
      <h2>Name</h2>
      <form method="POST" action="/topics/${slug}/rename">
        <label for="title">Topic name
          <input id="title" name="title" type="text" maxlength="${TOPIC_TITLE_MAX_LENGTH}" value="${escapeHtml(
            title,
          )}" required>
        </label>
        <p class="hint">The address of this topic does not change, so links to it keep working.</p>
        <button type="submit">Save name</button>
      </form>
    </section>`;
}

/**
 * How often, and on which day.
 *
 * One form, because the two are one setting: a weekly brief with no day is not a
 * cadence. The day is offered whichever Cadence is selected rather than shown and
 * hidden, because this page has no script and a control that appears on a click is
 * a control that has to be submitted twice.
 */
function cadenceSection(input: TopicSettingsInput, slug: string): string {
  const cadence = input.topic.cadence;
  const day = input.topic.cadenceDay ?? DEFAULT_WEEKLY_DAY;
  const options = CADENCES.map(
    (value) => `        <label class="card">
          <input type="radio" name="cadence" value="${value}"${
            cadence === value ? ' checked' : ''
          }>
          <span class="title">${escapeHtml(CADENCE_LABELS[value])}</span>
          <span class="blurb">${escapeHtml(CADENCE_NOTES[value])}</span>
        </label>`,
  ).join('\n');
  const days = WEEKDAYS.map(
    (value) =>
      `          <option value="${value}"${value === day ? ' selected' : ''}>${escapeHtml(
        WEEKDAY_LABELS[value],
      )}</option>`,
  ).join('\n');
  return `    <section>
      <h2>How often</h2>
      <form method="POST" action="/topics/${slug}/cadence">
        <fieldset class="grid">
          <legend>How often this topic briefs</legend>
${options}
        </fieldset>
        <label for="day">Weekly, on
          <select id="day" name="day">
${days}
          </select>
        </label>
        <p class="hint">The day applies only when you pick weekly. Briefs arrive at your <a href="/settings/delivery">delivery time</a>.</p>
        <button type="submit">Save</button>
      </form>
    </section>`;
}

/**
 * What this Topic reads, and what it could read instead.
 *
 * Every Source on the list has its own control rather than one control with a
 * picker, because the decision is "stop this one" about a name the User is
 * looking at, not "choose one from a list of every outlet in the registry".
 *
 * The "add" control only offers Sources this Topic does not already follow, so
 * the list cannot be asked to hold a second copy of something already on it. When
 * every Source is followed there is nothing to add, and the page says that rather
 * than offering an empty select.
 */
function sourcesSection(
  input: TopicSettingsInput,
  slug: string,
  followed: readonly Source[],
  available: readonly Source[],
): string {
  const rows = followed
    .map(
      (source) => `      <li>
        <span>${escapeHtml(source.name)}</span>
        <form class="remove" method="POST" action="/topics/${slug}/sources/remove">
          <input type="hidden" name="sourceId" value="${escapeHtml(source.id)}">
          <button class="secondary" type="submit">Remove</button>
        </form>
      </li>`,
    )
    .join('\n');
  const list =
    followed.length === 0
      ? `    <p class="empty-state">This topic follows no sources yet, so nothing can be ingested for it.</p>`
      : `    <ul class="topics">
${rows}
    </ul>`;

  const add =
    available.length === 0
      ? ''
      : `      <label for="sourceId">Add a source
        <select id="sourceId" name="sourceId">
${available
  .map((source) => `          <option value="${escapeHtml(source.id)}">${escapeHtml(source.name)}</option>`)
  .join('\n')}
        </select>
      </label>
      <button type="submit">Add source</button>`;

  return `    <section>
      <h2>Sources</h2>
      <p class="hint">The sources this topic reads from. Changing this takes effect on the next ingest.</p>
${list}
      <form method="POST" action="/topics/${slug}/sources/add">
${add}
      </form>
    </section>`;
}

/**
 * Whether this Topic exists.
 *
 * Last, and in the one place on the page that can take something away. Removing a
 * Topic frees the slot it held and stops its briefs, so the page says what will
 * happen before the button rather than after: a User who expects to swap a Topic
 * needs to know the brief history stays and that the name will be free again.
 */
function deleteSection(slug: string): string {
  return `    <section>
      <h2>Remove this topic</h2>
      <p class="hint">This frees one of your topic slots and stops this topic's briefs. Its past briefs are kept, and the name is free to use again.</p>
      <form method="POST" action="/topics/${slug}/delete">
        <button class="secondary" type="submit">Remove this topic</button>
      </form>
    </section>`;
}
