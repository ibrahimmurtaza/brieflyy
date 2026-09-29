/**
 * The words extraction reads an Article's text with.
 *
 * They are kept apart from the rules that use them because they are the part of
 * extraction that is data rather than reasoning, and because the rules that use
 * them are worth reading without two hundred lines of English in the way. They
 * are also the part that is wrong most easily: a word added here changes what an
 * Article is taken to name, which is why the two guards in
 * entity-extraction.test.ts are measured over the wire-copy fixtures rather
 * than asserted case by case.
 *
 * Every entry is a word English does not capitalise in the middle of a sentence,
 * so none of them is a name waiting to be swallowed — with the exceptions that
 * say so where they are listed.
 */

import { STOPWORDS } from './stopwords.js';
/** Weekdays, months and seasons: a report about Tuesday, in March, is full of names that are not. */
const CALENDAR_WORDS: readonly string[] = [
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
  'sunday',
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'autumn',
  'winter',
  'summer',
  'spring',
];

/** How many of anything a sentence can open with. */
const NUMERAL_WORDS: readonly string[] = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'dozen',
  'hundred',
  'thousand',
  'million',
  'billion',
];

/**
 * Titles and the words that name a role.
 *
 * They break a name rather than joining it — "Governor Elsa Marquardt" is two
 * things, not one Entity called "Governor Elsa Marquardt" — and a name that
 * follows one is a person.
 */
export const PERSON_CUES: readonly string[] = [
  'mr',
  'mrs',
  'ms',
  'miss',
  'dr',
  'prof',
  'professor',
  'sir',
  'dame',
  'lord',
  'lady',
  'president',
  'vice-president',
  'chairman',
  'chairwoman',
  'chairperson',
  'chief',
  'executive',
  'ceo',
  'cfo',
  'coo',
  'spokesman',
  'spokeswoman',
  'spokesperson',
  'director',
  'governor',
  'mayor',
  'minister',
  'secretary',
  'senator',
  'manager',
  'coach',
  'judge',
];

/**
 * Words English writes in lower case in the middle of a sentence.
 *
 * A capital on one of these is a fact about where it sits in the sentence rather
 * than about what it names, and it is the commonest way a name-reading rule
 * picks up something that is not a name: "However, Rivcom disagreed" offers a
 * capitalised "However" next to a name, and "Then Jane Doe left" offers a
 * capitalised "Then" at the head of one. None of them is a name, which is what
 * makes this a list of things to exclude rather than things to recognise.
 *
 * Military ranks are deliberately absent from `PERSON_CUES` for the same reason
 * with a sharper edge: "General Motors" and "Captain Cook" are names that begin
 * with one, and a rank is a rarer thing to find in front of a person than a chief
 * executive is.
 */
const SENTENCE_STARTERS: readonly string[] = [
  'about',
  'above',
  'according',
  'across',
  'after',
  'against',
  'ago',
  'again',
  'against',
  'ahead',
  'all',
  'almost',
  'along',
  'already',
  'also',
  'although',
  'always',
  'among',
  'another',
  'anyone',
  'anything',
  'apparently',
  'around',
  'as',
  'aside',
  'away',
  'back',
  'basically',
  'because',
  'been',
  'before',
  'behind',
  'below',
  'besides',
  'between',
  'beyond',
  'both',
  'briefly',
  'but',
  'by',
  'came',
  'can',
  'certainly',
  'clearly',
  'come',
  'comes',
  'coming',
  'could',
  'day',
  'despite',
  'did',
  'do',
  'does',
  'doing',
  'done',
  'down',
  'during',
  'early',
  'either',
  'else',
  'enough',
  'especially',
  'even',
  'ever',
  'every',
  'everyone',
  'everything',
  'exactly',
  'far',
  'few',
  'finally',
  'first',
  'for',
  'from',
  'further',
  'get',
  'gets',
  'given',
  'go',
  'goes',
  'going',
  'gone',
  'good',
  'got',
  'had',
  'has',
  'have',
  'having',
  'he',
  'hence',
  'here',
  'hers',
  'herself',
  'him',
  'himself',
  'his',
  'how',
  'however',
  'i',
  'if',
  'in',
  'indeed',
  'instead',
  'into',
  'is',
  'it',
  'its',
  'itself',
  'just',
  'keep',
  'kept',
  'last',
  'later',
  'least',
  'less',
  'let',
  'like',
  'likely',
  'little',
  'long',
  'look',
  'made',
  'mainly',
  'make',
  'many',
  'maybe',
  'may',
  'meanwhile',
  'might',
  'more',
  'moreover',
  'most',
  'much',
  'must',
  'near',
  'neither',
  'never',
  'next',
  'no',
  'none',
  'nor',
  'not',
  'nothing',
  'now',
  'nowhere',
  'obviously',
  'of',
  'off',
  'often',
  'on',
  'once',
  'one',
  'only',
  'onto',
  'or',
  'other',
  'others',
  'otherwise',
  'ought',
  'our',
  'ours',
  'out',
  'outside',
  'over',
  'overall',
  'own',
  'per',
  'perhaps',
  'please',
  'plus',
  'rather',
  'really',
  'recently',
  'reportedly',
  'right',
  'said',
  'same',
  'say',
  'says',
  'see',
  'seen',
  'several',
  'shall',
  'she',
  'should',
  'since',
  'so',
  'some',
  'someone',
  'something',
  'soon',
  'still',
  'such',
  'sure',
  'take',
  'taken',
  'takes',
  'taking',
  'than',
  'that',
  'the',
  'their',
  'theirs',
  'them',
  'themselves',
  'then',
  'there',
  'therefore',
  'these',
  'they',
  'thing',
  'things',
  'think',
  'this',
  'those',
  'though',
  'thought',
  'three',
  'through',
  'thus',
  'till',
  'to',
  'today',
  'together',
  'tomorrow',
  'tonight',
  'too',
  'took',
  'toward',
  'towards',
  'two',
  'under',
  'until',
  'up',
  'upon',
  'us',
  'use',
  'used',
  'very',
  'via',
  'was',
  'way',
  'we',
  'well',
  'went',
  'were',
  'what',
  'when',
  'where',
  'whether',
  'which',
  'while',
  'who',
  'whom',
  'whose',
  'why',
  'will',
  'with',
  'within',
  'without',
  'won',
  'would',
  'yet',
  'you',
  'your',
  'yours',
];

/**
 * The stock nouns of news prose.
 *
 * A capitalised common noun is nearly always a headline word rather than a
 * name, and one read as a name is an Entity that no other Article about the same
 * story will ever mention. Every entry is a noun English writes in lower case in
 * the middle of a sentence, so none of them is a name waiting to be swallowed.
 */
const PROSE_WORDS: readonly string[] = [
  'analysts',
  'authorities',
  'buyers',
  'campaigners',
  'commentators',
  'contractors',
  'customers',
  'details',
  'doctors',
  'employees',
  'enterprise',
  'experts',
  'exports',
  'figures',
  'forecasters',
  'guidance',
  'hospitals',
  'imports',
  'investigators',
  'investors',
  'lawyers',
  'nurses',
  'observers',
  'officials',
  'prices',
  'profits',
  'prosecutors',
  'regulators',
  'revenues',
  'staff',
  'strikes',
  'suppliers',
  'teachers',
  'workers',
];

/**
 * Abbreviations that name no particular thing.
 *
 * An Entity exists so two Articles can be recognised as being about the same
 * subject, and a term that appears in most Articles of a Topic cannot do that:
 * every story set in the country shares "US", every technology story shares
 * "AI", and a shared word that identifies nothing is worse than none, because it
 * counts towards the overlap that decides whether two Stories are one story.
 * NATO and the FDA are left in, because each names one body.
 */
export const NOISE_ACRONYMS: ReadonlySet<string> = new Set([
  'ai',
  'am',
  'api',
  'ceo',
  'cfo',
  'coo',
  'cto',
  'eu',
  'gdp',
  'id',
  'iot',
  'ipo',
  'it',
  'pm',
  'saas',
  'tv',
  'uk',
  'un',
  'us',
  'usa',
]);

/**
 * Languages.
 *
 * A language is a concept rather than a named thing, and the same handful are
 * named in a large share of Articles about anything at all, so one is worth no
 * more towards recognising a second Article as being about the same subject than
 * "AI" is.
 */
const LANGUAGES: readonly string[] = [
  'arabic',
  'chinese',
  'danish',
  'dutch',
  'english',
  'finnish',
  'french',
  'german',
  'greek',
  'hindi',
  'italian',
  'japanese',
  'korean',
  'norwegian',
  'polish',
  'portuguese',
  'russian',
  'spanish',
  'swedish',
  'turkish',
];

/** Every word that is capitalised for a reason other than being a name. */
export const NOISE_WORDS: ReadonlySet<string> = new Set([
  ...STOPWORDS,
  ...CALENDAR_WORDS,
  ...NUMERAL_WORDS,
  ...PERSON_CUES,
  ...LANGUAGES,
  ...SENTENCE_STARTERS,
  ...PROSE_WORDS,
]);

/**
 * Words that sit inside a name without being part of what is named: "Bank of
 * England", "Robert de Niro". Deliberately free of "and" and "for", which join
 * two separate names rather than a name to a word inside it.
 */
export const CONNECTORS: ReadonlySet<string> = new Set([
  'of',
  'the',
  'de',
  'del',
  'da',
  'das',
  'dos',
  'du',
  'di',
  'van',
  'von',
  'der',
  'den',
  'la',
  'le',
]);

/**
 * Words that say nothing about which name they are inside, and so are dropped
 * from a name's key.
 *
 * Wider than `CONNECTORS` on purpose: "for" joins two separate names often
 * enough that a run will not step over it, but "Institute for Cancer Research"
 * and "Institute of Cancer Research" are one name, and the key has to fold them
 * together whether or not the run was willing to read across it.
 */
export const INNER_WORDS: ReadonlySet<string> = new Set([...CONNECTORS, 'for']);

/**
 * Words a name may carry at its end that say nothing about which name it is.
 *
 * They are read as part of the name and end it, so "Acme Corp Foo" is "Acme
 * Corp" and "Foo" rather than one Entity called all three, and the canonical key
 * drops them, so "Acme Corp", "Acme Corporation" and "Acme" are one Entity.
 * "Bank", "University" and "Trust" are not here: they are part of what is named
 * rather than a legal form.
 */
export const LEGAL_SUFFIXES: ReadonlySet<string> = new Set([
  'inc',
  'incorporated',
  'corp',
  'corporation',
  'co',
  'company',
  'ltd',
  'limited',
  'llc',
  'llp',
  'plc',
  'gmbh',
  'ag',
  'sa',
  'nv',
  'bv',
  'ab',
  'asa',
  'oy',
  'srl',
  'se',
  'holdings',
  'group',
]);

/** Given names, which is how a two-word name is read as a person. */
export const GIVEN_NAMES: ReadonlySet<string> = new Set([
  'ahmed', 'alex', 'alexander', 'alice', 'amanda', 'amir', 'ana', 'anders',
  'andrea', 'andrew', 'angela', 'anna', 'anne', 'antoine', 'antonio', 'aria',
  'arjun', 'ashley', 'barbara', 'benjamin', 'bernard', 'bettina', 'bianca',
  'bruno', 'carlos', 'carla', 'catherine', 'charles', 'chiara', 'chris',
  'christina', 'claire', 'clara', 'daniel', 'david', 'diana', 'diego', 'divya',
  'dmitri', 'donna', 'douglas', 'edward', 'elena', 'elias', 'elisa', 'elise',
  'eliza', 'ella', 'elsa', 'emily', 'emma', 'erik', 'esther', 'eugene', 'eva',
  'felix', 'fiona', 'frances', 'francis', 'frank', 'gabriel', 'gabriela',
  'geoffrey', 'george', 'graham', 'hanna', 'hans', 'harold', 'helen', 'henri',
  'henry', 'hugo', 'ian', 'ibrahim', 'ines', 'irene', 'isabel', 'ivan', 'jack',
  'jacob', 'james', 'jane', 'janet', 'jason', 'jean', 'jeffrey', 'jennifer',
  'jessica', 'joan', 'joel', 'john', 'jonathan', 'josef', 'joseph', 'juan',
  'judith', 'julia', 'julie', 'karen', 'karl', 'kate', 'katherine', 'kavita',
  'keith', 'kevin', 'laura', 'laurent', 'lee', 'liam', 'linda', 'lucas',
  'lucia', 'luke', 'mads', 'marc', 'maria', 'marie', 'marina', 'mark', 'marta',
  'martin', 'mary', 'matthew', 'maureen', 'megan', 'meera', 'melissa', 'mia',
  'michel', 'mila', 'nadia', 'nancy', 'natalie', 'nathan', 'nathaniel', 'neil',
  'nicholas', 'nicole', 'noah', 'norma', 'olga', 'oliver', 'olivia', 'oscar',
  'pablo', 'patricia', 'patrick', 'paul', 'paula', 'pedro', 'peter', 'philip',
  'priya', 'rachel', 'rafael', 'raj', 'ralph', 'renata', 'rebecca', 'richard',
  'rita', 'robert', 'robin', 'roger', 'rohan', 'rosa', 'ruth', 'ryan', 'sadie',
  'salma', 'sam', 'samantha', 'samuel', 'sandra', 'sanjay', 'sara', 'sarah',
  'scott', 'sean', 'sergei', 'seth', 'sharon', 'sofia', 'stephan', 'steven',
  'susan', 'sylvia', 'takeshi', 'tanya', 'theodore', 'thomas', 'tiffany',
  'timothy', 'tomas', 'valerie', 'vanessa', 'victor', 'victoria', 'vincent',
  'virginia', 'walter', 'wei', 'wendy', 'william', 'yara', 'yusuf', 'zoe',
]);

/** Words that name an organization wherever they appear inside one. */
export const ORG_MARKERS: ReadonlySet<string> = new Set([
  'agency',
  'association',
  'authority',
  'bank',
  'board',
  'club',
  'commission',
  'committee',
  'council',
  'court',
  'department',
  'federation',
  'foundation',
  'institute',
  'institution',
  'ministry',
  'office',
  'organisation',
  'organization',
  'party',
  'society',
  'university',
  'union',
]);

/**
 * Phrases that make the name just after them an organization, because the
 * phrase carries the word and the name does not.
 *
 * Every one of these ends in a connective, and that is what tells them apart from
 * `PLACES_AFTER_INSTITUTION`: "the acquisition of TinyCo" is TinyCo, but "the
 * central bank of Belvern" is a bank in Belvern, and Belvern is the place.
 */
export const ORG_CUES: readonly string[] = [
  'acquisition of',
  'buyout of',
  'merger with',
  'takeover of',
];

/**
 * Phrases that name an institution the name after them does not: "the central
 * bank of Belvern", "the finance ministry of Germany". What follows one of these
 * is the place the institution acts for, and no matter how many of them are
 * capitalised in a row the name is the jurisdiction rather than the ministry.
 */
export const PLACES_AFTER_INSTITUTION: readonly string[] = [
  'central bank',
  'commercial bank',
  'emergency service',
  'finance ministry',
  'foreign ministry',
  'health ministry',
  'investment bank',
  'police force',
  'prime minister',
  'research institute',
];

/** Prepositions that put the name after them somewhere. */
export const LOCATIVES: ReadonlySet<string> = new Set([
  'across',
  'around',
  'at',
  'from',
  'in',
  'near',
  'outside',
  'to',
  'toward',
  'towards',
]);

/** Words that make the name they sit in a place. */
export const PLACE_MARKERS: ReadonlySet<string> = new Set([
  'avenue',
  'bay',
  'city',
  'county',
  'district',
  'island',
  'kingdom',
  'lake',
  'mount',
  'mountain',
  'ocean',
  'province',
  'region',
  'republic',
  'river',
  'sea',
  'state',
  'street',
  'valley',
]);

/** Words that make the name they sit in a thing that can be bought. */
export const PRODUCT_NOUNS: ReadonlySet<string> = new Set([
  'app',
  'application',
  'assistant',
  'browser',
  'car',
  'chip',
  'console',
  'database',
  'device',
  'earbud',
  'game',
  'headset',
  'laptop',
  'model',
  'phone',
  'platform',
  'product',
  'robot',
  'service',
  'software',
  'system',
  'tablet',
  'tool',
  'toy',
  'vehicle',
  'watch',
]);

/** Verbs an outlet uses when a thing comes onto the market. */
export const LAUNCH_VERBS: ReadonlySet<string> = new Set([
  'announced',
  'announces',
  'bought',
  'brought',
  'buys',
  'called',
  'debuted',
  'debuts',
  'introduced',
  'introduces',
  'launch',
  'launched',
  'launches',
  'named',
  'names',
  'put',
  'puts',
  'relaunched',
  'released',
  'releases',
  'rolled',
  'sell',
  'sells',
  'selling',
  'sold',
  'unveiled',
  'unveils',
]);

/** Launches spelled as two words. */
export const LAUNCH_PHRASES: readonly string[] = [
  'going on sale',
  'put on sale',
  'pushed out',
  'rolled out',
];

/** Determiners and possessives, skipped when reading what a name follows. */
export const DETERMINERS: ReadonlySet<string> = new Set([
  'a',
  'an',
  'first',
  'her',
  'his',
  'its',
  'new',
  'our',
  'own',
  'second',
  'that',
  'the',
  'their',
  'these',
  'this',
]);
