/**
 * How an Article's Entities are found, named and sorted into kinds.
 *
 * Extraction used to read a run of title-case words and nothing else, so it
 * missed every all-caps and mixed-case name, joined nothing that should be split
 * and nothing that should be joined, and offered no way for two spellings of one
 * name to arrive at the same place. Cluster grouping and Trends both compare
 * Entities rather than words, so an Entity that never matches another is an
 * Entity carrying no weight in either.
 *
 * The reading here is deliberately shallow — no model, and no dictionary of
 * every English word. What it does instead is generate candidates generously and
 * then throw away the ones that are not names, and it decides identity separately
 * from the spelling: an Entity is a canonical key, and the name is only the form
 * an outlet happened to use for it. The limits are the ones a rule cascade has,
 * and a name it cannot place is filed as a concept rather than guessed at, so a
 * wrong kind is a shrug where a wrong name would be a story that does not group.
 */

import type { EntityKind } from './types.js';
import { stripFeedMetadata } from './feed-text.js';
import {
  CONNECTORS,
  DEMONYMS,
  DETERMINERS,
  FEED_FURNITURE,
  GENERIC_HEAD_NOUNS,
  GIVEN_NAMES,
  INNER_WORDS,
  LEADING_QUALIFIERS,
  LEGAL_SUFFIXES,
  LAUNCH_PHRASES,
  LAUNCH_VERBS,
  LOCATIVES,
  NOISE_ACRONYMS,
  NOISE_WORDS,
  ORG_CUES,
  ORG_MARKERS,
  PERSON_CUES,
  PLACES_AFTER_INSTITUTION,
  PLACE_MARKERS,
  PRODUCT_NOUNS,
  PUBLISHER_NAMES,
} from './entity-lexicons.js';

/**
 * An Entity as one Article's text presents it.
 *
 * `name` is what an outlet wrote, `key` is what identity is decided on. Two
 * mentions of one thing written two ways share a key and so resolve to one
 * Entity, which is the only reason the same person written two ways by two
 * outlets ever overlaps at all.
 */
export interface ExtractedEntity {
  /** The name as this Article wrote it: what a User reads. */
  readonly name: string;
  /** The identity of the thing, shared by every spelling of the name. */
  readonly key: string;
  /** What sort of thing it is. */
  readonly kind: EntityKind;
}

/**
 * The immediate surroundings of a name, which is all the context the rules need.
 *
 * `before` and `after` are the words either side of it, lowercased and stripped
 * of punctuation. `appositive` records that a comma sat between the name and
 * what follows, because that comma is the difference between "Foo, an AI
 * assistant", where the name is a product, and "Acme Corp AI assistant", where
 * the same words sit around an organization and name nothing.
 */
interface EntityContext {
  readonly before: string;
  readonly after: string;
  readonly appositive: boolean;
}

/**
 * The longest run of name words treated as one name. A real name is not longer
 * than this — "Institute of Cancer Research" is four — and a run that is has run
 * into a headline written in capitals rather than found a name.
 */
const MAX_NAME_WORDS = 4;

/**
 * How much of a text has to be capitalised before it is read as text that was
 * shouted rather than as a page of acronyms.
 *
 * The count is absolute as well as proportional, because a headline is routinely
 * capitalised in full and is not a shouted paragraph; what tells the two apart
 * is how much of a long stretch is capitals.
 */
const SHOUTING_MIN_WORDS = 8;
const SHOUTING_RATIO = 3;

const SENTENCE_SPLIT = /(?<=[.!?])\s+|(?<=.{40,})\n/;
const WORD = /[A-Za-z]+(?:['’-][A-Za-z]+)*/g;
/**
 * A possessive, in either of the apostrophes an outlet writes.
 *
 * The typographic one is not an edge case: a feed that serves curly prose is
 * the majority of them, and `Russia’s` scanned as `Russia’s` rather than as
 * `Russia` — so the Entity a User is shown carries a possessive no name has, and
 * the run it opens is one word longer than the name in it.
 */
const POSSESSIVE = /(?:['’]s|s')$/;
const ALLCAPS = /^[A-Z0-9&.]+$/;

interface Word {
  /** The word as it was written, minus any possessive. */
  readonly raw: string;
  /** The word lowercased. */
  readonly text: string;
  /** How it is capitalised: what tells a name from an ordinary word. */
  readonly style: 'title' | 'upper' | 'lower';
  /** Whether a comma sits between this word and the one before it. */
  readonly commaBefore: boolean;
  /** Whether this word is the first of its sentence. */
  readonly sentenceInitial: boolean;
  /** Whether this word attaches to the previous one by a hyphen. */
  readonly hyphenated: boolean;
  /** Whether it carries a capital inside it, as eBay and McDonald do. */
  readonly innerCapital: boolean;
}

function styleOf(raw: string): Word['style'] {
  if (ALLCAPS.test(raw)) return 'upper';
  // eBay and iPhone are capitalised inside the word, which no ordinary English
  // word is, so they are read as titles rather than as lower-case noise.
  if (/[A-Z]/.test(raw)) return 'title';
  return 'lower';
}

/** The words of a sentence, with the punctuation around them kept as facts. */
function tokenize(sentence: string): Word[] {
  const words: Word[] = [];
  WORD.lastIndex = 0;
  let previousEnd = 0;
  let match: RegExpExecArray | null;
  while ((match = WORD.exec(sentence)) !== null) {
    const commaBefore = sentence.slice(previousEnd, match.index).includes(',');
    previousEnd = match.index + match[0].length;
    // A compound is split on its hyphens so that one can hold a name together
    // ("Jean-Luc") without holding an adjective to it ("Riverton-based").
    const parts = match[0].split('-');
    for (let i = 0; i < parts.length; i++) {
      const bare = (parts[i] ?? '').replace(POSSESSIVE, '');
      if (bare.length === 0) continue;
      words.push({
        raw: bare,
        text: bare.toLowerCase(),
        style: styleOf(bare),
        commaBefore: i === 0 && commaBefore,
        sentenceInitial: words.length === 0,
        hyphenated: i > 0,
        innerCapital: /[A-Z]/.test(bare.slice(1)),
      });
    }
  }
  return words;
}

function isNameWord(word: Word): boolean {
  if (word.style === 'lower') return false;
  if (NOISE_WORDS.has(word.text)) return false;
  if (word.style === 'upper') {
    // One capital letter is an initial rather than a name, and a shouted
    // headline would otherwise be a page of two-letter Entities.
    if (word.text.length < 2) return false;
    if (NOISE_ACRONYMS.has(word.text)) return false;
  }
  return true;
}

/** Whether a word can begin a name. A legal suffix on its own names nothing. */
function startsName(word: Word): boolean {
  return isNameWord(word) && !LEGAL_SUFFIXES.has(word.text);
}

/**
 * A run of words reading as one name: the words themselves, whether they open
 * the text, and the words they run through.
 */
interface Run {
  /** The words, including any connector inside the name. */
  readonly words: readonly Word[];
  /** Whether the run starts at the first word of a sentence. */
  readonly opening: boolean;
  /** Whether the words say what they are without the sentence's help. */
  readonly selfNamed: boolean;
  /** The index the word after the run sits at. */
  readonly end: number;
}

/**
 * The longest run of name words starting at `from`.
 *
 * A run never crosses a comma or a sentence boundary, because a comma joins two
 * names ("Jane Doe, Acme Corp") rather than continuing one, and two sentences
 * have nothing to do with each other however similar their capitals. A legal
 * suffix ends a name rather than beginning the next, so "Acme Corp Foo" is two
 * Entities rather than one called all three. A connector is carried inside the
 * run rather than stepped over, so "Bank of England" is one name and the word
 * after it is the one the scan continues from.
 */
function runFrom(words: readonly Word[], from: number): Run | null {
  const first = words[from];
  if (!first || !startsName(first)) return null;
  const run: Word[] = [first];
  let nameWords = 1;
  let at = from;
  while (nameWords < MAX_NAME_WORDS) {
    const next = words[at + 1];
    if (!next || next.commaBefore || next.sentenceInitial) break;
    if (isNameWord(next) && next.style === first.style) {
      run.push(next);
      at += 1;
      nameWords += 1;
      if (LEGAL_SUFFIXES.has(next.text)) break;
      continue;
    }
    const after = words[at + 2];
    if (
      CONNECTORS.has(next.text) &&
      after &&
      !after.commaBefore &&
      !after.sentenceInitial &&
      isNameWord(after) &&
      after.style === first.style
    ) {
      run.push(next, after);
      at += 2;
      nameWords += 1;
      continue;
    }
    break;
  }
  return {
    words: run,
    opening: first.sentenceInitial,
    selfNamed: namesItself(run),
    end: at + 1,
  };
}

function joinRun(run: Run): string {
  return run.words
    .map((word, i) => (i > 0 && word.hyphenated ? '-' : ' ') + word.raw)
    .join('')
    .trim();
}

/** The words either side of a name, for the rules that read its context. */
function contextOf(
  words: readonly Word[],
  from: number,
  end: number,
): EntityContext {
  return {
    before: words
      .slice(Math.max(0, from - 3), from)
      .map((w) => w.text)
      .join(' '),
    after: words
      .slice(end, end + 5)
      .map((w) => w.text)
      .join(' '),
    appositive: words[end]?.commaBefore === true,
  };
}

/** The last word of a phrase, with the determiner in front of it dropped. */
function lastWord(phrase: string): string {
  const words = phrase.split(' ').filter((w) => !DETERMINERS.has(w));
  return words[words.length - 1] ?? '';
}

/** Whether a phrase ends in one of the cues, ignoring a connective after it. */
function hasCue(phrase: string, cues: readonly string[]): boolean {
  const trimmed = phrase.trim();
  const withoutConnective = trimmed
    .split(' ')
    .filter((w) => !CONNECTORS.has(w))
    .join(' ');
  return cues.some(
    (cue) =>
      trimmed === cue ||
      trimmed.endsWith(` ${cue}`) ||
      withoutConnective === cue ||
      withoutConnective.endsWith(` ${cue}`),
  );
}

/**
 * Whether an apposition after a comma says what the name is: "an AI assistant",
 * "the new app". Bounded to the words an apposition can reach through, so a
 * product noun a clause later says nothing about the name in front of it.
 */
function isProductApposition(after: string): boolean {
  const nouns = [...PRODUCT_NOUNS].join('|');
  const pattern = new RegExp(
    `^(?:(?:${[...DETERMINERS].join('|')})\\s+)*(?:[a-z]+\\s+){0,2}(?:${nouns})\\b`,
  );
  return pattern.test(after);
}

/**
 * What sort of thing a name is.
 *
 * Read from the name first — an organization says so in its own name, and a
 * person is two words whose first is a given name — and then from the words
 * around it, because that is where a product is named ("launched Foo"), where a
 * place is placed ("in Frankfurt"), and where a government names a bank that is
 * not called one ("the central bank of Belvern"). A name none of the rules
 * place is a concept: the kind that says only that this is a named thing, which
 * is true even when it is the only thing known about it.
 */
function classifyEntity(name: string, context: EntityContext): EntityKind {
  const words = name
    .split(/[\s-]+/)
    .filter((w) => w.length > 0)
    .map((w) => w.toLowerCase());
  const before = lastWord(context.before);

  if (PERSON_CUES.includes(before)) return 'person';
  if (words.length > 1 && GIVEN_NAMES.has(words[0] ?? '')) return 'person';

  if (words.some((w) => ORG_MARKERS.has(w) || LEGAL_SUFFIXES.has(w))) {
    return 'org';
  }
  // A place before either organization cue, because "in" is a place and because a
  // ministry's jurisdiction is a place and not the ministry.
  if (LOCATIVES.has(before)) return 'place';
  if (words.some((w) => PLACE_MARKERS.has(w))) return 'place';
  if (hasCue(context.before, ORG_CUES)) return 'org';
  if (hasCue(context.before, PLACES_AFTER_INSTITUTION)) return 'place';

  if (LAUNCH_VERBS.has(before) || PRODUCT_NOUNS.has(before)) return 'product';
  if (hasCue(context.before, LAUNCH_PHRASES)) return 'product';
  if (/\bon sale\b/.test(context.after)) return 'product';
  if (context.appositive && isProductApposition(context.after)) return 'product';

  return 'concept';
}

/**
 * The identity of a name: what two spellings of it have to share to be one
 * Entity.
 *
 * Case, punctuation, a leading article, a connective inside the name and a legal
 * form are all things two outlets write differently about one name, so none of
 * them is part of what the name identifies. What is left is the name itself,
 * which is why "Acme Corp", "ACME CORP." and "Acme Corporation" are one Entity,
 * and why "Institute of Cancer Research" and "Institute for Cancer Research" are
 * one as well, while "Acme Foods" is another.
 *
 * Three more folds, each of them a way an outlet writes the same thing and none
 * of them anything the name identifies. A **qualifier** in front — the verb a
 * headline leads with, the column it is filed under, the adjective that says
 * which of several, the transliteration of one of those — says which name, not
 * what it is: "Fired OpenAI", "Analysis Riverton Labs" and "Pivnichyi Northern
 * Bridge" are OpenAI, Riverton Labs and the Northern Bridge. A **demonym** is the
 * country rather than its adjective: "Israeli" and "Israel" are one thing, and
 * the two were two Entities that never overlapped.
 *
 * The prefix is only dropped from the front and only while something is left to
 * name. "Former" is a word, not a name, and folding it to nothing would be the
 * rule deciding it is not there.
 */
export function canonicalEntityKey(name: string): string {
  let words = name
    .toLowerCase()
    .replace(/['’]s\b/g, ' ')
    // A dotted abbreviation is one word written with stops in it: "S.A." is "sa",
    // not "s a", or the same company is two Entities by the length of its suffix.
    .replace(/\.(?=[a-z])/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length > 0 && !INNER_WORDS.has(w));
  while (words.length > 1 && LEGAL_SUFFIXES.has(words[words.length - 1] ?? '')) {
    words.pop();
  }
  while (words.length > 1 && LEADING_QUALIFIERS.has(words[0] ?? '')) {
    words.shift();
  }
  // After the prefix, because "Former Israeli" is a former something in Israel
  // and the adjective is not in front of the country until the "former" has gone.
  //
  // Only when there is a noun for it to modify. "Israeli company" is Israel, and
  // folding it produces `israel company` — a rare Entity, adding no weight to the
  // country's own. "Israeli" alone is a different problem: folding it into
  // `israel` merges a rare Entity into a common one, which raises Israel's
  // document frequency and so lowers its IDF weight in every Story that carries
  // it. Measured over this corpus, that standalone fold is the only fold in this
  // module that costs anything — one different-event family — because every pair
  // whose whole overlap is that country falls with its weight. So the adjective
  // folds and the bare demonym does not, and "Israeli" and "Israel" are two
  // Entities where one was wanted.
  if (words.length > 1) {
    words = words.map((word) => DEMONYMS.get(word) ?? word);
  }
  return words.join(' ');
}

/**
 * Whether a name is in the text but is not a thing in the story.
 *
 * Three kinds, and the same failure in each. An **outlet** is named in every
 * Article it published, so an Entity for one is in every Story that outlet
 * covered and overlaps all of them — a link between unrelated Stories that costs
 * exactly what a link about the same subject costs. A **feed's own furniture** is
 * stamped on every item it serves rather than written about any of them. A
 * **generic head noun** standing alone names a sort of thing rather than one of
 * them, so every Article about a university has one and none of them are about
 * the same university.
 *
 * The check is on the folded key rather than on the words as written, because the
 * fold is what makes "The Guardian" and "Guardian" one spelling: it is no use
 * listing an outlet under a form two of them do not use. What is left of a name
 * after the prefix comes off can still be a head noun on its own — "Daily
 * Briefing" is a newsletter's title rather than a briefing — so the head noun is
 * read off the key as well as off the name.
 */
export function namesNothing(name: string): boolean {
  return namesNothingUnder(canonicalEntityKey(name));
}

/** Whether a key already folded names nothing. The rule {@link namesNothing} reads. */
function namesNothingUnder(key: string): boolean {
  if (key.length === 0) return true;
  if (PUBLISHER_NAMES.has(key) || FEED_FURNITURE.has(key)) return true;
  const words = key.split(' ');
  // Every word an outlet or a label: "BBC", "HN", "Guardian".
  if (words.every(isFurnitureWord)) return true;
  // And the head noun, which is only a head noun while it is the whole name.
  if (words.length > 1) return false;
  return GENERIC_HEAD_NOUNS.has(words[0] ?? '');
}

/** Whether a word names the report rather than what it reports. */
function isFurnitureWord(word: string): boolean {
  return PUBLISHER_NAMES.has(word) || FEED_FURNITURE.has(word);
}

/**
 * How short a word has to be before it is not a name written short.
 *
 * Below this it is an abbreviation or a fragment — `fl`, `th`, `pi` — and the
 * corpus is full of them, every one of which would otherwise be matched onto
 * whatever longer name happens to end in it.
 */
const MIN_PARTIAL_NAME_CHARS = 3;

/**
 * Whether a key is a whole name that a longer one could be a fuller writing of:
 * one word, and one specific enough that naming it names a thing.
 *
 * This is what makes a partial name resolvable rather than merely short. "Pike"
 * is the same person as "Christa Pike", and resolving it needs to know that
 * "Pike" could be the end of a name at all. "Bridge", "University" and "County"
 * could be the end of thousands, so matching one of them onto whichever fuller
 * name happens to exist is not a resolution but a coincidence — which is why the
 * same test as {@link namesNothing} answers it: what a word cannot name on its own
 * it cannot be half of either.
 */
export function isPartialName(key: string): boolean {
  if (key.length < MIN_PARTIAL_NAME_CHARS || key.includes(' ')) return false;
  return !namesNothingUnder(key) && !NOISE_WORDS.has(key);
}

/**
 * Whether `longer` is the whole name of the thing `shorter` is a short form of.
 *
 * Two conditions, and both of them are load-bearing. The shorter name has to be
 * the **end** of the longer one rather than its beginning, or "Pike" would reach
 * "Pike Hinson" and every place name ending in a common word would be one Entity;
 * and the longer name has to be **a given name and a surname**, because that is
 * the shape an outlet shortens without saying what it shortened. "OpenAI" is a
 * name in its own right and appears at the end of "ChatGPT OpenAI" and "Pac Man
 * OpenAI", which are two names an Article happened to put side by side — resolving
 * "OpenAI" onto either would lose the most-mentioned Entity in the corpus, and
 * nothing in the spelling says it should be lost.
 *
 * Two words exactly: "Tennessee Christa Pike" carries "Christa Pike" and is not
 * the whole of anybody's name.
 */
export function isFullerNameFor(longer: string, shorter: string): boolean {
  if (longer.length <= shorter.length || !longer.endsWith(` ${shorter}`)) return false;
  const words = longer.split(' ');
  return words.length === 2 && GIVEN_NAMES.has(words[0] ?? '');
}

/**
 * The one of several stored names a partial name can be read as, or nothing.
 *
 * The **tightest** one, because a longer name is a headline's adjective in front
 * of it rather than a fuller writing of the short one. And only when there is
 * exactly one: "Martin" is `Jay Martin` or `Michel Martin`, both a given name and
 * a surname and both two words, and choosing between them is a guess dressed up as
 * a lookup. A partial with no fuller name keeps its own row rather than being
 * dissolved, and the next mention of the full name takes it over instead.
 *
 * Both callers — ingest and the boot-time reconciliation — decide it here rather
 * than each writing the choice out, because a boot that disagreed with ingest
 * would leave the stored shape depending on when the database was last started.
 */
export function theOnlyFullerName(
  candidates: readonly string[],
  partial: string,
): string | undefined {
  const carries = candidates.filter((key) => isFullerNameFor(key, partial));
  if (carries.length === 0) return undefined;
  const shortest = Math.min(...carries.map((key) => key.split(' ').length));
  const tightest = carries.filter((key) => key.split(' ').length === shortest);
  return tightest.length === 1 ? tightest[0] : undefined;
}

/**
 * Whether a name is a name on its own account, whatever sentence it opens.
 *
 * A capitalised word at the head of a sentence is capitalised because that is
 * where a capital goes, and "Rainfall", "Then" and "New" are among the commonest
 * words in news prose. A name that carries capitals of its own — "IBM", "eBay",
 * "Elsa" — or that says what it is in its own form, as "Acme Corp" and "Bank of
 * England" do, has a reason to be capitalised that the sentence did not give it.
 */
function namesItself(run: readonly Word[]): boolean {
  return run.some(
    (word) =>
      word.style === 'upper' ||
      word.innerCapital ||
      GIVEN_NAMES.has(word.text) ||
      ORG_MARKERS.has(word.text) ||
      LEGAL_SUFFIXES.has(word.text),
  );
}

interface Candidate {
  readonly name: string;
  readonly key: string;
  readonly kind: EntityKind;
  /** Whether it opened a sentence, which is what makes it suspect. */
  readonly opening: boolean;
  /** Whether it says what it is without the sentence's help. */
  readonly selfNamed: boolean;
}

/**
 * Every Entity an Article's text names, in the order it names them.
 *
 * A name at the head of a sentence is kept when the Article says it more than
 * once, or when the word names itself: repetition is the other thing that
 * separates a name from a capital letter, and it is the one that does not need a
 * dictionary. So "Foo goes on sale" in a headline and again in the first line of
 * the body is an Entity, and "New Acme" in a headline with "Acme Corp" in the body
 * is not — it is the same Acme, said two ways.
 *
 * The same name twice is one Entity however it is spelt, and the kind is the one
 * most of the Article's mentions of it agree on: an Article that calls a company
 * a product once and a business the other four times has not found a second
 * Entity, it has made a mistake, and the majority is the one worth keeping. The
 * name kept is the first form the Article used, because that is the one it leads
 * with.
 */
export function extractEntities(text: string): ExtractedEntity[] {
  if (text.length === 0) return [];
  // A feed's own bookkeeping is removed before anything is read out of the text.
  // It carries no names, and the word pattern cannot tell that on its own: it
  // throws the digits away, so `Points: 6 # Comments: 0` arrives as two ordinary
  // capitalised words and is read as one name called `Points Comments`. Because
  // an Entity is what two Articles are matched on, such a name does not merely
  // look wrong — it matches every Article the same feed ever sent, which is
  // precisely how a Hacker News Article and an obituary were found to be about
  // the same thing. The parser strips this too; doing it here as well means the
  // rule holds for any caller rather than only the one that tidies its input
  // first.
  const words: Word[] = [];
  for (const sentence of stripFeedMetadata(text).split(SENTENCE_SPLIT)) {
    words.push(...tokenize(sentence.trim()));
  }
  if (words.length === 0) return [];

  const shouted = isShouting(words);
  const candidates: Candidate[] = [];
  const mentions = new Map<string, number>();
  for (let i = 0; i < words.length; i++) {
    if (shouted && words[i]!.style === 'upper') continue;
    const from = i;
    const run = runFrom(words, from);
    if (!run) continue;
    // The scan moves on past the whole run whatever is decided about it: a run
    // that is not an Entity is not an Entity in its last word either, and
    // re-reading the tail of it is how "The Guardian Environment" left an Entity
    // called `Environment` behind.
    i = run.end - 1;
    const name = joinRun(run);
    const key = canonicalEntityKey(name);
    if (key.length === 0) continue;
    // A name can be in the text and not be a thing in the story: an outlet
    // publishes every Article it names itself in, and a feed stamps its own
    // labels on every item it serves. Both are matched on like anything else, so
    // an Entity for either is a link between Articles about different subjects
    // that costs the same as a link about the same subject.
    if (namesNothing(name)) continue;
    candidates.push({
      name,
      key,
      kind: classifyEntity(name, contextOf(words, from, run.end)),
      opening: run.opening,
      selfNamed: run.selfNamed,
    });
    mentions.set(key, (mentions.get(key) ?? 0) + 1);
  }

  const found = new Map<
    string,
    { name: string; kind: EntityKind; kinds: Map<EntityKind, number> }
  >();
  for (const candidate of candidates) {
    if (candidate.opening && !candidate.selfNamed && (mentions.get(candidate.key) ?? 0) < 2) {
      continue;
    }
    const seen = found.get(candidate.key);
    if (!seen) {
      found.set(candidate.key, {
        name: candidate.name,
        kind: candidate.kind,
        kinds: new Map([[candidate.kind, 1]]),
      });
      continue;
    }
    seen.kinds.set(candidate.kind, (seen.kinds.get(candidate.kind) ?? 0) + 1);
    seen.kind = majorityKind(seen.kinds, seen.kind);
  }
  return [...found].map(([key, entry]) => ({
    name: entry.name,
    key,
    kind: entry.kind,
  }));
}

/** The kind most of an Article's mentions agree on, ties going to the first. */
function majorityKind(
  kinds: ReadonlyMap<EntityKind, number>,
  current: EntityKind,
): EntityKind {
  let best = current;
  for (const [kind, count] of kinds) {
    if (count > (kinds.get(best) ?? 0)) best = kind;
  }
  return best;
}

/**
 * Whether a text is written in capitals throughout, in which case capitals stop
 * meaning anything and only mixed-case words can be names.
 */
function isShouting(words: readonly Word[]): boolean {
  const upper = words.filter((w) => w.style === 'upper').length;
  if (upper < SHOUTING_MIN_WORDS) return false;
  return (
    upper > SHOUTING_RATIO * (words.filter((w) => w.style === 'title').length + 1)
  );
}
