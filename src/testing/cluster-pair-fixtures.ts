/**
 * Labelled Story pairs from a real ingested corpus, for measuring how well
 * Cluster grouping puts one event together and keeps two apart.
 *
 * A pair names two Stories by an Article inside each, because that is the only
 * handle a corpus keeps between ingests.
 *
 * `SAME_EVENT_PAIRS` is the recall set: two Stories that are one thing that
 * happened, however many outlets reported it.
 *
 * `DIFFERENT_EVENT_PAIRS` is the precision set, and it is the hard half. Every
 * pair in it shares something real with its partner — the same recurring column,
 * the same Entities, or nearly the same words — because two unrelated reports
 * are easy to keep apart, and a set of easy negatives reports a precision number
 * that means nothing. The `boilerplate` field names the recurring column where
 * that is what the two share.
 *
 * The set is the durable asset here, and it is small on purpose: it was labelled
 * by reading the two articles rather than by asking the pipeline what it thinks,
 * and it is there to be read by the next person who changes the rule.
 */

/**
 * The recurring column two different-event pairs share.
 *
 * These are the boilerplate cases the precision set is built around: an outlet
 * that publishes the same shape of piece every day, where the text of today's
 * edition and tomorrow's is nearly identical and the Events are not.
 */
export type Boilerplate =
  /** A daily roundup of an analyst's calls. */
  | 'daily-analyst-calls'
  /** A daily live blog of a trading session. */
  | 'market-wrap'
  /** A newsletter sent on a schedule. */
  | 'daily-newsletter'
  /** A weekly roundup of the week’s political cartoons. */
  | 'weekly-cartoon-roundup'
  /** A "best of 2026, tested" list the outlet rewrites for every category. */
  | 'best-of-list'
  /** A roundup of one sale’s discounts. */
  | 'deal-roundup'
  /** A column answering one reader’s money question. */
  | 'advice-column'
  /** A series of polls published the same week. */
  | 'poll-series';

/**
 * One Story in the corpus, named by an Article inside it.
 *
 * A Story's own id is a fresh uuid every time ingest forms it, so a fixture that
 * held one would stop resolving the moment a Source was re-polled. An Article's
 * external id inside its Source is the one handle a corpus keeps.
 */
export interface CorpusStoryRef {
  /** The Source slug the Article came from. */
  readonly source: string;
  /** That Article's own id inside the Source's feed. */
  readonly externalId: string;
  /** The headline, so a label can be checked by reading it rather than a uuid. */
  readonly headline: string;
}

export interface LabelledStoryPair {
  readonly left: CorpusStoryRef;
  readonly right: CorpusStoryRef;
  /** Why this pair carries the label it does, for whoever reads the set next. */
  readonly note: string;
  /** The recurring column these two share, where that is what they share. */
  readonly boilerplate?: Boilerplate;
}

/**
 * What one labelled reference is called when a corpus is read for it.
 *
 * A Source slug and an external id identify an Article together and apart, and
 * nothing else does, so the two are joined in one place rather than in every
 * caller that looks one up.
 */
export function corpusRefKey(source: string, externalId: string): string {
  return `${source}~${externalId}`;
}

export const SAME_EVENT_PAIRS: readonly LabelledStoryPair[] = [
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/03/spain-housing-protest',
      headline: '‘This can’t go on’: tens of thousands protest against housing crisis in Spain',
    },
    right: {
      source: 'hacker-news',
      externalId: 'https://news.ycombinator.com/item?id=49951966',
      headline: "'This can't go on': thousands protest against housing crisis in Spain",
    },
    note: 'One Saturday march against the housing crisis, carried by the Guardian and by Hacker News as a link.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/03/spain-housing-protest',
      headline: '‘This can’t go on’: tens of thousands protest against housing crisis in Spain',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cm2kej47095no#3',
      headline: "'Anger in the streets': Tens of thousands protest in Spain over housing crisis",
    },
    note: 'Both report the same Saturday marches in Madrid and other cities after the housing bill was struck down.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cm2kej47095no#3',
      headline: "'Anger in the streets': Tens of thousands protest in Spain over housing crisis",
    },
    right: {
      source: 'hacker-news',
      externalId: 'https://news.ycombinator.com/item?id=49951966',
      headline: "'This can't go on': thousands protest against housing crisis in Spain",
    },
    note: 'The same Saturday march, by BBC and by Hacker News.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/us-news/2026/oct/04/marine-arrested-japan-suspicion-murder',
      headline: 'US marine arrested in Japan on suspicion of killing woman, police say',
    },
    right: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/us-marine-arrested-on-suspicion-of-killing-woman-in-japan-13595309',
      headline: 'US marine arrested on suspicion of killing woman in Japan',
    },
    note: 'The same arrest: a US marine held over the killing of a woman at a hotel in Naha, Okinawa.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/us-news/2026/oct/04/marine-arrested-japan-suspicion-murder',
      headline: 'US marine arrested in Japan on suspicion of killing woman, police say',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cme3xw4yy28do#1',
      headline: 'US Marine arrested over murder of woman in Okinawa, Japan',
    },
    note: 'The same arrest, with the BBC carrying Japan’s formal protest as well.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cme3xw4yy28do#1',
      headline: 'US Marine arrested over murder of woman in Okinawa, Japan',
    },
    right: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/us-marine-arrested-on-suspicion-of-killing-woman-in-japan-13595309',
      headline: 'US marine arrested on suspicion of killing woman in Japan',
    },
    note: 'The same arrest, told by three outlets.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/technology/2026/oct/05/sam-altman-open-ai-chatgpt-benefits-risks',
      headline: 'Accept ‘bad things’ in return for benefits of AI, says Sam Altman',
    },
    right: {
      source: 'hacker-news',
      externalId: 'https://news.ycombinator.com/item?id=49964248',
      headline: "Accept 'bad things' in return for benefits of AI, says Sam Altman",
    },
    note: 'One interview in which Sam Altman says the world should accept AI’s bad things.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/politics/live/2026/oct/05/tory-party-conference-labour-reform-planning-economy-business-latest-news-updates',
      headline: 'No 10 insists RAF Fairford is safe after US withdraws its bombers – UK politics live',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cmy56yvv1kxxo#1',
      headline: 'No 10 insists RAF Fairford is safe after US withdraws bombers',
    },
    note: 'The same Downing Street insistence about RAF Fairford, carried inside the Guardian live blog as well as by the BBC.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cmy56yvv1kxxo#1',
      headline: 'No 10 insists RAF Fairford is safe after US withdraws bombers',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/us-news/2026/oct/05/no-10-says-raf-fairford-safe-us-withdraws-bombers-from-base',
      headline: 'No 10 insists RAF Fairford is safe after US withdraws its bombers from base',
    },
    note: 'The same No 10 statement about the withdrawn B-1 bombers.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/us-news/2026/oct/08/nyc-shooting-federal-agent',
      headline: 'ICE agent shoots man in New York City with five-year-old reportedly in car',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c59vzk9yypn3o#1',
      headline: 'ICE agent shoots man in New York City',
    },
    note: 'One shooting by an ICE agent in New York City.',
  },
  {
    left: {
      source: 'arstechnica',
      externalId: 'https://arstechnica.com/gadgets/2026/10/the-7-year-old-nvidia-shield-tv-is-now-100-more-expensive-thanks-to-ai/',
      headline: 'The 7-year-old Nvidia Shield TV is now $100 more expensive due to AI',
    },
    right: {
      source: 'wired',
      externalId: '6abff1eb79a026977dfe804e',
      headline: 'The Nvidia Shield TV Is 7 Years Old. It Just Got a $100 Price Hike',
    },
    note: 'One price rise: the Shield TV Pro going from $199.99 to $299.99 on memory prices.',
  },
  {
    left: {
      source: 'wired',
      externalId: '6abff1eb79a026977dfe804e',
      headline: 'The Nvidia Shield TV Is 7 Years Old. It Just Got a $100 Price Hike',
    },
    right: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1004791',
      headline: 'Nvidia’s Shield TV Pro just got a $100 price hike',
    },
    note: 'The same $100 Shield TV price rise, by two of the three outlets that ran it.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cqdjvg3xww2go#1',
      headline: "'Come all the way' back to EU, French finance minister tells UK",
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/politics/2026/oct/08/french-minister-invites-uk-to-come-all-the-way-back-to-the-eu',
      headline: 'French minister invites UK to ‘come all the way back’ to the EU',
    },
    note: 'One interview in which the French finance minister invites the UK back into the EU.',
  },
  {
    left: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/airlines-suspend-flights-to-saudi-capital-after-houthis-claim-attack-on-airport-13596623',
      headline: "Flights to Saudi capital suspended after Houthis 'attack on airport'",
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/09/riyadh-airport-flights-suspended-houthis-claim-attack',
      headline: 'Houthis claim attack on Riyadh airport as airlines suspend flights to Saudi capital',
    },
    note: 'One attack on Riyadh airport and the flight suspensions that followed.',
  },
  {
    left: {
      source: 'wired',
      externalId: '6ac579521296fb13fb96b1dd',
      headline: 'Amazon Alexa Tablet 12 Pro, Alexa Tablet 11, Alexa Tablet 8: Specs, Features, Price',
    },
    right: {
      source: 'engadget',
      externalId: 'https://www.engadget.com/2280787/amazon-alexa-tablet-12-pro-hands-on/',
      headline: 'Amazon Alexa Tablet 12 Pro hands-on: Taking aim at the iPad Pro for less than half the price',
    },
    note: 'One product launch: Amazon’s new Alexa Tablet line, priced in both.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1008467',
      headline: 'SpaceX announces plan to become a ‘major mobile carrier’',
    },
    right: {
      source: 'engadget',
      externalId: 'https://www.engadget.com/2281967/spacex-major-mobile-carrier-low-band-spectrum-acquisition/',
      headline: "SpaceX wants to become a 'major mobile carrier' with low-band spectrum acquisition",
    },
    note: 'One announcement: SpaceX buying low-band spectrum to become a mobile carrier.',
  },
  {
    left: {
      source: 'cnbc',
      externalId: '108375191',
      headline: 'AI startup Manus raises $500 million in first funding round since Meta breakup',
    },
    right: {
      source: 'techcrunch',
      externalId: 'https://techcrunch.com/?p=3175521',
      headline: 'China’s Manus raises over $500M in first funding round since split with Meta',
    },
    note: 'One funding round: Manus raising $500m after the Meta breakup.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c9e8ld448km8o#4',
      headline: 'Adidas sues Australian label White Fox over four stripes design',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/business/2026/oct/09/adidas-white-fox-fashion-australia-trading-branding-sydney-ntwnfb',
      headline: 'Adidas accuses Australian label White Fox of ‘trading off its reputation’ with use of four-stripe branding',
    },
    note: 'One lawsuit: Adidas suing White Fox over the four stripes.',
  },
  {
    left: {
      source: 'engadget',
      externalId: 'https://www.engadget.com/2281983/meta-bans-tiktok-ads/',
      headline: 'Meta bans TikTok ads from its platforms in tit-for-tat row',
    },
    right: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1008658',
      headline: 'Meta is banning TikTok ads across its platforms',
    },
    note: 'One ban: Meta refusing ByteDance advertising.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/us-news/2026/oct/03/tennessee-christa-pike-frank-strada',
      headline: 'Tennessee’s top prison official resigning after botched execution of Christa Pike',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c8zxl62yzxzxo#3',
      headline: "Tennessee prison chief to resign after Christa Pike's failed execution",
    },
    note: 'One resignation: the Tennessee corrections commissioner stepping down after the Pike execution.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1004734',
      headline: 'CNN’s boss will remain as Paramount and WBD merge into Skydance',
    },
    right: {
      source: 'arstechnica',
      externalId: 'https://arstechnica.com/tech-policy/2026/10/paramount-completes-111b-warner-merger-creating-skydance-behemoth/',
      headline: 'Paramount completes $111B Warner merger, creating “Skydance” behemoth',
    },
    note: 'One merger closing: Paramount and Warner Bros. Discovery becoming Skydance.',
  },
  {
    left: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/russian-laboratory-worker-dies-of-suspected-pneumonic-plague-as-200-under-medical-observation-13595297',
      headline: "Russian lab worker 'dies of suspected plague' as 200 under observation",
    },
    right: {
      source: 'arstechnica',
      externalId: 'https://arstechnica.com/health/2026/10/researchers-death-from-undisclosed-illness-sparks-mass-quarantine-in-russia/',
      headline: 'Mass quarantine issued in Russia after unexplained death of plague researcher',
    },
    note: 'One death and the quarantine it caused, at a Russian laboratory.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/ng-interactive/2026/oct/04/brazil-presidential-election-2026-first-round-live-results',
      headline: 'Brazil presidential election 2026: first-round live results',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/ck1l34ed592no#1',
      headline: 'Right-wing Flávio Bolsonaro wins first round of Brazil election',
    },
    note: 'One result: Flávio Bolsonaro winning the Brazilian first round and sending it to a run-off.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/us-news/2026/oct/08/uss-abraham-lincoln-dock-san-diego',
      headline: 'USS Abraham Lincoln scheduled to dock in San Diego after harrowing stretch at sea',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/videos/cwp8gnp14xr2o#1',
      headline: '​​USS Lincoln finally docks in San Diego after 10-month mission',
    },
    note: 'One arrival: the USS Abraham Lincoln docking in San Diego after ten months at sea.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/politics/2026/oct/09/labour-wins-holborn-st-pancras-byelection-green-party',
      headline: 'Labour fends off Green party to win Holborn and St Pancras byelection',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/politics/live/2026/oct/09/holborn-st-pancras-byelection-result-zack-polanski-sagal-abdi-wali-uk-labour-green-party-uk-politics-latest-news',
      headline: 'Labour wins Holborn and St Pancras byelection; Polanski ‘absolutely’ intends to remain Green party leader – UK politics live',
    },
    note: 'One result: Labour holding Holborn and St Pancras. The live blog embeds the article’s own standfirst.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/07/uk-consulate-east-jerusalem-prepares-close-israel',
      headline: '‘Palestinians will bear the cost’: UK consulate in East Jerusalem prepares to shut its doors',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cw33xd6vegnno#1',
      headline: "Most UK diplomats to leave East Jerusalem consulate, Israel says, as Miliband says 'vital services' to remain",
    },
    note: 'One decision: the UK consulate in East Jerusalem closing to most services.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1007732',
      headline: 'Atari is bringing back one of its earliest 8-bit home computers',
    },
    right: {
      source: 'engadget',
      externalId: 'https://www.engadget.com/2281551/the-atari-800xl-hybrid-gaming-console-is-back-after-decades-in-obscurity/',
      headline: 'The Atari 800XL hybrid gaming console is back after decades in obscurity',
    },
    note: 'One product revival: the Atari 800XL, announced by both.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1008327',
      headline: 'Paramount is making a Cyberpunk 2077 film',
    },
    right: {
      source: 'engadget',
      externalId: 'https://www.engadget.com/2281714/cyberpunk-2077-is-the-latest-video-game-to-get-the-movie-treatment/',
      headline: 'Cyberpunk 2077 is the latest video game to get the movie treatment',
    },
    note: 'One announcement: a Paramount film on Cyberpunk 2077.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1008422',
      headline: 'Apple will reportedly debut its first touchscreen MacBook in three weeks',
    },
    right: {
      source: 'engadget',
      externalId: 'https://www.engadget.com/2281839/apple-reportedly-plans-touchscreen-macbook-and-ipad-mini-launch-for-this-month/',
      headline: 'Apple reportedly plans touchscreen MacBook and iPad Mini launch for this month',
    },
    note: 'One Bloomberg report: a touchscreen MacBook Pro and a new iPad Mini for 27 October.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/crje8edqyej9o#1',
      headline: 'Netanyahu says Flydubai flight attacker underwent Islamist radical indoctrination',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/02/indian-pilot-smit-machchhar-recalls-flydubai-cockpit-attack',
      headline: '‘I was fighting for my life’: Indian pilot hailed as hero recalls Flydubai cockpit attack',
    },
    note: 'The same Flydubai cockpit attack, carried by the BBC and by the Guardian as an interview with the pilot.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cw33x4y8k82no#1',
      headline: 'Twelve killed in attack on airport in Saudi capital Riyadh',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/11/saudi-coalition-retaliation-houthi-attack-riyadh-airport',
      headline: 'Riyadh airport hit again after deadly Houthi missile attack, Saudi authorities say',
    },
    note: 'The same Houthi missile attack on Riyadh airport, carried by the BBC and by the Guardian.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/videos/c962yz01l7mmo#4',
      headline: 'Watch: Why was the sign at the British consulate in East Jerusalem removed?',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/07/uk-consulate-east-jerusalem-prepares-close-israel',
      headline: '‘Palestinians will bear the cost’: UK consulate in East Jerusalem prepares to shut its doors',
    },
    note: 'The same decision to close the UK consulate in East Jerusalem, carried by the BBC and by the Guardian.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/ck3r5dxxwqzpo#1',
      headline: 'Riot police clash with students as education protests rage in France',
    },
    right: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/french-schools-set-alight-by-students-in-violent-protests-over-teacher-shortages-and-run-down-buildings-13594112',
      headline: 'Schools set alight by students in protests across France',
    },
    note: 'The same French school protests, carried by the BBC and by Sky News.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/ck3r5dxxwqzpo#1',
      headline: 'Riot police clash with students as education protests rage in France',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/08/thursday-briefing-why-young-people-are-taking-to-the-streets-across-france',
      headline: 'Thursday briefing: Why young people are taking to the streets across France',
    },
    note: 'The same French school protests, carried by the BBC and by the Guardian.',
  },
  {
    left: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/french-schools-set-alight-by-students-in-violent-protests-over-teacher-shortages-and-run-down-buildings-13594112',
      headline: 'Schools set alight by students in protests across France',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/08/thursday-briefing-why-young-people-are-taking-to-the-streets-across-france',
      headline: 'Thursday briefing: Why young people are taking to the streets across France',
    },
    note: 'The same French school protests, carried by Sky News and by the Guardian.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/ck1l34ed592no#1',
      headline: 'Polls close in Brazil as Lula and Flávio Bolsonaro remain neck and neck',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/07/flavio-bolsonaro-vows-to-re-democratise-brazil-election',
      headline: '‘Another coup d’état’: fears grow as Flávio Bolsonaro vows to re-democratise Brazil',
    },
    note: 'The same Brazilian election run-off, with Flávio Bolsonaro facing Lula, carried by the BBC and by the Guardian.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cm2d6xd2g4w2o#1',
      headline: 'Thousands of security personnel deployed as Delhi braces for Cockroach protest',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/02/india-cockroach-movement-protests-mumbai-changes-voter-roll',
      headline: 'India’s Cockroach movement launches new protests over changes to voter roll',
    },
    note: 'The same Cockroach movement protests in India over voter roll changes, carried by the BBC and by the Guardian.',
  },
  {
    left: {
      source: 'arstechnica',
      externalId: 'https://arstechnica.com/health/2026/10/researchers-death-from-undisclosed-illness-sparks-mass-quarantine-in-russia/',
      headline: 'Mass quarantine issued in Russia after unexplained death of plague researcher',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/07/who-says-it-does-not-have-full-picture-from-russia-following-suspected-plague-death',
      headline: 'WHO says it does not have full picture from Russia following suspected plague death',
    },
    note: 'The same death of a Russian plague researcher and the quarantine it triggered, carried by Ars Technica and by the Guardian.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cm2kej47095no#1',
      headline: 'Anger in the streets: Tens of thousands protest in Spain over housing crisis',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/07/maria-del-carmen-abascal-spain-housing-protests-dies',
      headline: 'María del Carmen Abascal, symbol of Spain’s housing protests, dies aged 87',
    },
    note: 'The same Spain housing crisis and its protests, with the death of a symbol of the movement, carried by the BBC and by the Guardian.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c8zxl62yzxzxo#1',
      headline: 'Tennessee prison chief to resign after Christa Pike failed execution',
    },
    right: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/prisons-chief-resigns-after-failed-execution-of-christa-pike-in-tennessee-13594688',
      headline: 'Tennessee prisons chief resigns after failed execution of Christa Pike',
    },
    note: 'The same resignation of the Tennessee prisons chief after the botched Christa Pike execution, carried by the BBC and by Sky News.',
  },
];

export const DIFFERENT_EVENT_PAIRS: readonly LabelledStoryPair[] = [
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/02/brazil-lula-stop-fascism-bolsonaro-son',
      headline: 'Brazil’s Lula says only he can stop rise of fascism under Bolsonaro’s son',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/ng-interactive/2026/oct/04/brazil-presidential-election-2026-first-round-live-results',
      headline: 'Brazil presidential election 2026: first-round live results',
    },
    note: 'Lula’s Rio rally on the eve of the vote, and the first-round count three days later: one campaign, two events.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/us-news/2026/oct/05/no-10-says-raf-fairford-safe-us-withdraws-bombers-from-base',
      headline: 'No 10 insists RAF Fairford is safe after US withdraws its bombers from base',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c60qk0p043kdo#4',
      headline: 'Seventh man bailed in connection with RAF Fairford incident',
    },
    note: 'The withdrawal of the bombers, and a man bailed three days later over the incident that caused it.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c8zxl62yzxzxo#3',
      headline: "Tennessee prison chief to resign after Christa Pike's failed execution",
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/ckgelynyg7d3o#1',
      headline: "Christa Pike's prognosis still unclear after failed execution, lawyer says",
    },
    note: 'The commissioner resigning, and Pike’s prognosis the next day. One person, two events.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c6jdm5n1vy7go#1',
      headline: "Green Party members back 'Zionism is racism' motion",
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cm2d6x11l6pko#1',
      headline: 'Zack Polanski defends leadership after Zionism row and by-election loss',
    },
    note: 'The party conference vote, and Polanski answering for it five days later.',
  },
  {
    left: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/opposition-fighters-withdraw-from-capital-of-ethiopias-northern-tigray-region-13594931',
      headline: "Opposition fighters withdraw from capital of Ethiopia's northern Tigray region",
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/global-development/2026/oct/06/ethiopia-tigray-conflict-tplf-rebels-forcibly-recruit-boys-war-crimes',
      headline: 'Tigray rebel groups ‘forcibly recruiting boys as young as 15’ as fighting spreads',
    },
    note: 'Government troops entering Mekelle, and a separate report of forced recruitment in Tigray.',
  },
  {
    left: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/germany-at-risk-of-violent-conflict-with-russia-warns-intelligence-chief-13595339',
      headline: "Germany at risk of 'violent conflict' with Russia, warns intelligence chief",
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cmwyq34qexdzo#4',
      headline: 'Burnham to meet German chancellor in Berlin to discuss security and EU ties',
    },
    note: 'A domestic intelligence warning, and a prime minister’s visit to Berlin three days later.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cmdx39k49xw0o#1',
      headline: 'Spanish PM Sánchez calls early election after housing protests',
    },
    right: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/woman-87-whose-eviction-triggered-snap-election-in-spain-following-housing-protests-has-died-13596292',
      headline: 'The 87-year-old woman evicted from her home in Spain has died',
    },
    note: 'The snap election being called, and the death of the woman whose eviction prompted the protests behind it.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/08/pedro-sanchez-spanish-voters-housing-crisis-analysis',
      headline: 'Can Sánchez convince Spanish voters he is their best hope for fairer housing?',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/08/thousands-to-march-in-madrid-after-death-of-evicted-pensioner-maricarmen',
      headline: 'Thousands march in Madrid after death of evicted pensioner Maricarmen',
    },
    note: 'An analysis of Sánchez’s chances, and the memorial march that ran eight hours later.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/sport/football/articles/c6y93qq5175wo#1',
      headline: 'Clubs fear political interference in Man City appeal',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/sport/football/articles/c6n4ex2lgg2ko#8',
      headline: "Maresca says 'feeling is fantastic' among Man City squad",
    },
    note: 'Clubs worrying about political interference in the appeal, and the manager answering the charge that evening.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c9zrdmxp4vy6o#1',
      headline: "Teenager's hand blown off during confrontation between France school protesters and police",
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c6n9rgg80z94o#2',
      headline: "France's school protests: What lies behind the anger",
    },
    note: 'One teenager losing a hand, and an explainer on the movement three days later.',
  },
  {
    left: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/seven-injured-in-attack-with-sharp-object-at-polish-school-say-police-13596114',
      headline: 'Seven injured in attack at Polish school, say police',
    },
    right: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/one-dead-and-two-children-injured-in-polands-second-school-attack-in-two-days-13596420',
      headline: "One dead in Poland's second school attack in two days",
    },
    note: 'Two separate school attacks in Poland on consecutive days. Same country, same phrase, two events.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/technology/2026/oct/03/openai-review-hacks-australian-government-sites-costing-500000-a-day',
      headline: 'OpenAI says its review into hacks, including on Australian government sites, is costing $500,000 a day',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/australia-news/2026/oct/08/openai-used-ai-to-help-write-email-warning-australian-government-ai-had-hacked-its-websites',
      headline: 'OpenAI used AI to help write email warning Australian government AI had hacked its websites',
    },
    note: 'The cost of the review, and the revelation that OpenAI drafted the warning email.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1004643',
      headline: 'Google admits not every Android app runs great on Intel Googlebooks',
    },
    right: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1007409',
      headline: 'Android’s physical navigation buttons are back on Googlebooks, but not the way you think',
    },
    note: 'Google admitting an Android compatibility problem, and a review of the navigation keys.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1004643',
      headline: 'Google admits not every Android app runs great on Intel Googlebooks',
    },
    right: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1008563',
      headline: 'A week with Googlebooks: four notes from our testing so far',
    },
    note: 'The same compatibility admission, and a week-long review of the same laptops.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1004330',
      headline: 'Meta open sources code to let you make Muse AI gadgets',
    },
    right: {
      source: 'wired',
      externalId: '6abc27c619638e7270d13469',
      headline: 'Muse Creates Detailed Profiles of All Your Friends and Family',
    },
    note: 'Open-sourcing the Muse gadget code, and profiling everyone you know with it.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1004655',
      headline: 'OpenAI is sticking more ads in ChatGPT',
    },
    right: {
      source: 'arstechnica',
      externalId: 'https://arstechnica.com/ai/2026/10/openai-will-watermark-chatgpt-outputs-by-default-but-only-in-the-eu/',
      headline: 'OpenAI will watermark ChatGPT outputs by default—but only in the EU',
    },
    note: 'More advertising in ChatGPT, and watermarking its outputs in the EU.',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1004408',
      headline: 'An OpenAI safety employee has quit and is sounding the alarm',
    },
    right: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1004655',
      headline: 'OpenAI is sticking more ads in ChatGPT',
    },
    note: 'A safety researcher resigning, and the advertising product’s launch.',
  },
  {
    left: {
      source: 'arstechnica',
      externalId: 'https://arstechnica.com/google/2026/10/antitrust-lawsuits-targeting-google-ai-search-dismissed-by-federal-judge/',
      headline: 'Judge dismisses Chegg and Penske antitrust lawsuits targeting Google AI search',
    },
    right: {
      source: 'arstechnica',
      externalId: 'https://arstechnica.com/ai/2026/10/google-rolls-out-improved-synthid-ai-content-detector-now-available-globally/',
      headline: 'Google rolls out improved SynthID AI content detector, now available globally',
    },
    note: 'An antitrust ruling, and a better AI-content detector.',
  },
  {
    left: {
      source: 'wired',
      externalId: '6abc0464897fab4030f834f4',
      headline: 'The Best Early Amazon Echo Deals (and the Worst) Ahead of Prime Big Deal Days',
    },
    right: {
      source: 'wired',
      externalId: '6a3921356f2db0127b2a052a',
      headline: 'The Best Early Prime Day Deals Ahead of Amazon’s Second Sale (2026)',
    },
    note: 'Two separate early-deal roundups, eight hours apart, for the same sale.',
    boilerplate: 'deal-roundup',
  },
  {
    left: {
      source: 'wired',
      externalId: '6a2c5a1a60cf2edb0a4e8309',
      headline: '7 Best Prime Day Kindle Deals (2026): Save Up to $150',
    },
    right: {
      source: 'wired',
      externalId: '6a3049e1dc32638554aee625',
      headline: '30 Best Amazon Prime Day Deals Under $50 (October 2026)',
    },
    note: 'A Kindle deal list, and a different under-$50 list written the same evening.',
    boilerplate: 'deal-roundup',
  },
  {
    left: {
      source: 'wired',
      externalId: '6a3049e1dc32638554aee625',
      headline: '30 Best Amazon Prime Day Deals Under $50 (October 2026)',
    },
    right: {
      source: 'wired',
      externalId: '6a38e3221adb6c28f2a338eb',
      headline: 'The 28 Best Prime Day Tech Deals Will Expire Tonight',
    },
    note: 'Two under-$50 and expiring-tonight roundups covering different sets of products.',
    boilerplate: 'deal-roundup',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1000832',
      headline: 'The MacBook Air M5 is $200 off for the first time in months',
    },
    right: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1000323',
      headline: 'The iPad Mini is slightly cheaper again during Prime Day',
    },
    note: 'A MacBook Air discount, and an iPad Mini discount, announced the same morning.',
    boilerplate: 'deal-roundup',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1007149',
      headline: 'Roku’s OLED TVs are up to $400 off during Prime Day, starting at $700',
    },
    right: {
      source: 'wired',
      externalId: '6ac4fa273bf6bf8e97ba6350',
      headline: 'Apple AirPods Max 2 Are $120 Off Right Now During Prime Day (2026)',
    },
    note: 'Roku TVs at $400 off, and AirPods Max at $120 off.',
    boilerplate: 'deal-roundup',
  },
  {
    left: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1007110',
      headline: 'We found some great October Prime Day deals under $50',
    },
    right: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/1007804/its-your-last-chance-to-save-on-our-favorite-october-prime-day-deals',
      headline: '75 great October Prime Day deals are still happening',
    },
    note: 'Two under-$50 deal roundups, one the next morning after the sale was said to be over.',
    boilerplate: 'deal-roundup',
  },
  {
    left: {
      source: 'wired',
      externalId: '6246df08ceb527a328de3864',
      headline: 'Best Wi-Fi Routers (2026): My Honest Picks After Testing 50+',
    },
    right: {
      source: 'wired',
      externalId: '6abbfd1b897fab4030f834b6',
      headline: 'Best Reusable Water Bottles of 2026, Tested by WIRED',
    },
    note: 'A router roundup and a water bottle roundup: the same "Best … of 2026, tested by WIRED" template, rewritten for another category.',
    boilerplate: 'best-of-list',
  },
  {
    left: {
      source: 'wired',
      externalId: '607895413c4558580f4abffa',
      headline: '15 Best Office Chairs of 2026—We Tested 70 to Pick Them',
    },
    right: {
      source: 'wired',
      externalId: '5a8f727d213ac83aca7f0a36',
      headline: '7 Best Cheap Phones (2026), Tested and Reviewed',
    },
    note: 'Office chairs and cheap phones, from the same "Best … of 2026, tested" template.',
    boilerplate: 'best-of-list',
  },
  {
    left: {
      source: 'wired',
      externalId: '5c9126abe48fae1a55ed4ea6',
      headline: 'What’s the Best Kindle of 2026 (So Far)?',
    },
    right: {
      source: 'wired',
      externalId: '6a2c5a1a60cf2edb0a4e8309',
      headline: '7 Best Prime Day Kindle Deals (2026): Save Up to $150',
    },
    note: 'A buying guide and a deals list, about the same e-readers.',
  },
  {
    left: {
      source: 'engadget',
      externalId: 'https://www.engadget.com/2280951/panos-panay-tease-neo-design-language-and-alexa-interface/',
      headline: "Amazon's Panos Panay teases more Alexa-branded devices and a new design language",
    },
    right: {
      source: 'the-verge',
      externalId: 'https://www.theverge.com/?p=1007565',
      headline: 'Alexa Plus is better at running my home, but it’s not ready to run my life',
    },
    note: 'Amazon teasing new Alexa hardware, and a hands-on with the assistant that runs on the old hardware.',
  },
  {
    left: {
      source: 'engadget',
      externalId: 'https://www.engadget.com/2281378/everything-amazon-announced-october-2026-alexa-tablet-kindle-fire-tv-ring-lock/',
      headline: 'Everything Amazon has announced so far in October 2026',
    },
    right: {
      source: 'wired',
      externalId: '5c9126abe48fae1a55ed4ea6',
      headline: 'What’s the Best Kindle of 2026 (So Far)?',
    },
    note: 'A month-to-date roundup of Amazon’s launches, and a guide to one of the things launched.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cwvgrle6dx2lo#1',
      headline: 'British Museum announces changes to ease Bayeux Tapestry queues',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/culture/2026/oct/05/mary-beard-british-museum-queues-bayeux-tapestry',
      headline: 'Mary Beard suggests ‘tweaks’ to British Museum’s handling of queues to see Bayeux tapestry',
    },
    note: 'The museum announcing longer opening hours, and Mary Beard filing her own list of changes the day before. Same queue, same tapestry, two events.',
  },
  {
    left: {
      source: 'cnbc-finance',
      externalId: '108368344',
      headline: 'Appeals court rules that states can regulate Kalshi’s sports prediction markets, dealing another legal blow to platforms',
    },
    right: {
      source: 'cnbc',
      externalId: '108377814',
      headline: 'Kalshi traders see high odds that more than 5,100 data centers will be planned or operating before 2027',
    },
    note: 'An appeals-court ruling on prediction markets, and a story about prediction-market odds on data centres. The only thing they share is an Entity extracted from the word Kalshi.',
  },
  {
    left: {
      source: 'cnbc-finance',
      externalId: '108368344',
      headline: 'Appeals court rules that states can regulate Kalshi’s sports prediction markets, dealing another legal blow to platforms',
    },
    right: {
      source: 'cnbc-finance',
      externalId: '108372756',
      headline: 'House Democrat targets candidate prediction market trades after opponent’s Kalshi penalty',
    },
    note: 'A court ruling and a bill, a fortnight apart, on the same platform.',
  },
  {
    left: {
      source: 'cnbc-finance',
      externalId: '108368027',
      headline: 'The 10-year Treasury yield is at its highest in nearly two decades. How we got here',
    },
    right: {
      source: 'cnbc-finance',
      externalId: '108367748',
      headline: 'Debt-hungry AI companies face increased risk as bond yields spike',
    },
    note: 'A look at how the 10-year yield got here, and what the same yield does to AI issuers.',
  },
  {
    left: {
      source: 'cnbc',
      externalId: '108371024',
      headline: 'Top Wall Street analysts are upbeat about the prospects for these 3 stocks',
    },
    right: {
      source: 'marketwatch',
      externalId: 'WP-MKTW-0005278365',
      headline: 'Why one Wall Street firm sees parallels to the late 1970s and recommends shorting U.S. stocks',
    },
    note: 'Three stocks a bank likes, and a different bank shorting the market. “Wall Street” is the whole of the overlap.',
  },
  {
    left: {
      source: 'cnbc',
      externalId: '108372413',
      headline: 'Wells Fargo has lagged rival banks. Morgan Stanley says it’s time to buy',
    },
    right: {
      source: 'cnbc',
      externalId: '108381108',
      headline: 'This exchange stock is a buy on renewed options deal, Morgan Stanley says',
    },
    note: 'Two different notes from the same bank four days apart.',
    boilerplate: 'daily-analyst-calls',
  },
  {
    left: {
      source: 'cnbc',
      externalId: '108372304',
      headline: "Here are Monday's biggest analyst calls: Nvidia, SpaceX, Tesla, Apple, Microsoft, Wells Fargo, Samsara & more",
    },
    right: {
      source: 'cnbc',
      externalId: '108378234',
      headline: "Here are Friday's biggest analyst calls: Nvidia, SpaceX, Tesla, Boeing, Apple, American Express & more",
    },
    note: 'The same roundup written for Monday and again for Friday. Each is a day’s calls, not the same calls.',
    boilerplate: 'daily-analyst-calls',
  },
  {
    left: {
      source: 'cnbc',
      externalId: '108372459',
      headline: "Jim Cramer's top 10 things to watch in the stock market Monday",
    },
    right: {
      source: 'cnbc',
      externalId: '108376162',
      headline: "Jim Cramer's top 10 things to watch in the stock market Thursday",
    },
    note: 'Monday’s ten things to watch, and Thursday’s.',
    boilerplate: 'daily-analyst-calls',
  },
  {
    left: {
      source: 'cnbc',
      externalId: '108372280',
      headline: 'Nasdaq rises to fresh record high led by tech; traders eye oil and yields: Live updates',
    },
    right: {
      source: 'cnbc',
      externalId: '108374411',
      headline: 'Dow futures tumble 500 points as yields continue rising; oil surges 5%: Live updates',
    },
    note: 'The same live market blog on Monday and on Thursday.',
    boilerplate: 'market-wrap',
  },
  {
    left: {
      source: 'cnbc',
      externalId: '108374411',
      headline: 'Dow futures tumble 500 points as yields continue rising; oil surges 5%: Live updates',
    },
    right: {
      source: 'cnbc',
      externalId: '108378223',
      headline: "Stock futures edge higher after OpenAI's revenue report prompts tech sector turmoil: Live updates",
    },
    note: 'Two live market blogs three days apart, both about yields and oil.',
    boilerplate: 'market-wrap',
  },
  {
    left: {
      source: 'cnbc',
      externalId: '108372280',
      headline: 'Nasdaq rises to fresh record high led by tech; traders eye oil and yields: Live updates',
    },
    right: {
      source: 'cnbc',
      externalId: '108378814',
      headline: "Friday's big stock stories: What’s likely to move the market in the next trading session",
    },
    note: 'A live blog for the Monday session, and the Friday night preview of the next one.',
    boilerplate: 'market-wrap',
  },
  {
    left: {
      source: 'marketwatch',
      externalId: 'WP-MKTW-0005256076',
      headline: '‘I want to make her proud’: My mother, a divorcée, died and I’m her executor. Do I need to file for probate?',
    },
    right: {
      source: 'marketwatch',
      externalId: 'WP-MKTW-0005266201',
      headline: '‘I don’t want to die on the sales floor’: I’m 67 and earn $19.50 an hour at a big-box store. When can I finally retire?',
    },
    note: 'Two readers’ money questions an hour apart, from the same advice column.',
    boilerplate: 'advice-column',
  },
  {
    left: {
      source: 'marketwatch',
      externalId: 'WP-MKTW-0005267602',
      headline: 'The government can take 15% of Social Security benefits to repay student loans. These proposals seek to stop it.',
    },
    right: {
      source: 'cnbc',
      externalId: '108294123',
      headline: "Social Security checks could increase by just $69 next year. Here's how to close the retirement income gap",
    },
    note: 'A proposal to offset student loans against Social Security, and a note about next year’s COLA.',
  },
  {
    left: {
      source: 'nature',
      externalId: 'https://www.nature.com/articles/d41586-026-03185-x',
      headline: 'Daily briefing: Medicine Nobel prize goes to optogenetics',
    },
    right: {
      source: 'nature',
      externalId: 'https://www.nature.com/articles/d41586-026-03190-0',
      headline: 'Daily briefing: Physics Nobel for founder of neutrino-hunting observatory',
    },
    note: 'Two issues of Nature’s daily newsletter, the day after the other, on two different Nobel prizes.',
    boilerplate: 'daily-newsletter',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/02/friday-briefing-how-we-covered-the-flydubai-incident-as-it-unfolded',
      headline: 'Friday briefing: How we covered the flydubai incident as it unfolded',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/08/thursday-briefing-why-young-people-are-taking-to-the-streets-across-france',
      headline: 'Thursday briefing: Why young people are taking to the streets across France',
    },
    note: 'Two issues of the Guardian’s morning newsletter, a week apart, opening with the same three words.',
    boilerplate: 'daily-newsletter',
  },
  {
    left: {
      source: 'politico',
      externalId: '000001a0-d53b-d276-aff6-f57f64760000',
      headline: 'The nation’s cartoonists on the week in politics',
    },
    right: {
      source: 'politico',
      externalId: '000001a0-f9ea-d424-abed-ffea5c220000',
      headline: 'The nation’s cartoonists on the week in politics',
    },
    note: 'The same weekly cartoon roundup, a week apart, with the same standfirst word for word.',
    boilerplate: 'weekly-cartoon-roundup',
  },
  {
    left: {
      source: 'politico',
      externalId: '000001a0-d53b-d276-aff6-f57f64760000',
      headline: 'The nation’s cartoonists on the week in politics',
    },
    right: {
      source: 'politico',
      externalId: '000001a1-1e58-dc9a-a9a3-5f7cbdb50000',
      headline: 'The nation’s cartoonists on the week in politics',
    },
    note: 'The same weekly cartoon roundup, a fortnight apart.',
    boilerplate: 'weekly-cartoon-roundup',
  },
  {
    left: {
      source: 'politico',
      externalId: '000001a0-d440-d462-adb2-f4fb158d0000',
      headline: 'Poll: A crack is emerging in Trump’s coalition over deportations',
    },
    right: {
      source: 'politico',
      externalId: '000001a0-c50a-d462-adb2-e5bb637f0000',
      headline: 'Poll: Trump’s MAGA loyalists don’t think he has an affordability problem',
    },
    note: 'Two different POLITICO polls, a day apart, carrying the same “Poll:” furniture.',
    boilerplate: 'poll-series',
  },
  {
    left: {
      source: 'politico',
      externalId: '000001a0-d35c-d462-adb2-f7ff3a9b0000',
      headline: 'Young men are swinging away hard from Republicans, pessimistic about economy, new poll finds',
    },
    right: {
      source: 'politico',
      externalId: '000001a0-f4f9-d09b-afae-fffb1fc40000',
      headline: '‘These guys are in a pickle’: Some Republicans spurn Trump on the campaign trail',
    },
    note: 'A poll about young men, and a reported tour of candidates abandoning Trump.',
  },
  {
    left: {
      source: 'politico',
      externalId: '000001a0-cfb6-d276-aff6-efff02a30000',
      headline: 'Trump officials weigh rolling back beef import plan as GOP midterm panic spreads',
    },
    right: {
      source: 'politico',
      externalId: '000001a1-1d1b-d058-adf3-3f7b5f140000',
      headline: 'Poll: 1 in 4 Trump voters say GOP candidates should break from the president',
    },
    note: 'A leaked plan to roll back the beef import rule, and a poll about Republican disloyalty.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/environment/2026/oct/02/weather-tracker-eastern-spain-torrential-rain-flooding-nepal-landslides',
      headline: 'Eastern Spain braces for torrential rain and flooding',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/07/uk-consulate-east-jerusalem-prepares-close-israel',
      headline: '‘Palestinians will bear the cost’: UK consulate in East Jerusalem prepares to shut its doors',
    },
    note: 'Two Guardian stories about Spain and about the UK consulate in Jerusalem: the same outlet, two different events.',
  },
  {
    left: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/07/flydubai-attack-investigation-widens-as-alleged-hijackers-training-in-new-zealand-scrutinised-ntwnfb',
      headline: 'Flydubai attack investigation widens as alleged hijacker’s training in New Zealand scrutinised',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/world/2026/oct/07/maria-del-carmen-abascal-spain-housing-protests-dies',
      headline: 'María del Carmen Abascal, symbol of Spain’s housing protests, dies aged 87',
    },
    note: 'Two Guardian stories on the same day: the Flydubai investigation and the death of a housing-protest symbol, two different events.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/ck1l34ed592no#1',
      headline: 'Polls close in Brazil as Lula and Flávio Bolsonaro remain neck and neck',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/ck3r5dxxwqzpo#1',
      headline: 'Riot police clash with students as education protests rage in France',
    },
    note: 'Two BBC stories: Brazil’s election and France’s school protests, the same outlet, two different events.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/cw33x4y8k82no#1',
      headline: 'Twelve killed in attack on airport in Saudi capital Riyadh',
    },
    right: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c8zxl62yzxzxo#1',
      headline: 'Tennessee prison chief to resign after Christa Pike failed execution',
    },
    note: 'Two BBC stories: the Riyadh airport attack and the Tennessee prison chief’s resignation, the same outlet, two different events.',
  },
  {
    left: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/french-schools-set-alight-by-students-in-violent-protests-over-teacher-shortages-and-run-down-buildings-13594112',
      headline: 'Schools set alight by students in protests across France',
    },
    right: {
      source: 'sky-news',
      externalId: 'https://news.sky.com/story/flydubai-co-pilot-australian-links-probed-after-axe-attack-on-captain-13595012',
      headline: 'Flydubai co-pilot: Australian links probed after axe attack on captain',
    },
    note: 'Two Sky News stories: French school protests and the Flydubai co-pilot, the same outlet, two different events.',
  },
  {
    left: {
      source: 'bbc-news',
      externalId: 'https://www.bbc.co.uk/news/articles/c8zxl62yzxzxo#1',
      headline: 'Tennessee prison chief to resign after Christa Pike failed execution',
    },
    right: {
      source: 'the-guardian',
      externalId: 'https://www.theguardian.com/us-news/2026/oct/07/texas-execution-jamaal-howard',
      headline: 'Texas kills man in first US execution since botched lethal injection of Christa Pike',
    },
    note: 'Two executions ten days apart in different states, linked only by the name Christa Pike: the same Entity, two different events.',
  },
];

/**
 * Every labelled pair, whichever set it came from.
 *
 * The benchmark resolves each of these against a corpus and works out which set
 * each one ended up in; a family both sets claim is unusable and is dropped
 * rather than counted twice.
 */
export const ALL_CLUSTER_PAIRS: readonly LabelledStoryPair[] = [
  ...SAME_EVENT_PAIRS,
  ...DIFFERENT_EVENT_PAIRS,
];
