/**
 * Text fixtures for Story deduplication.
 *
 * The point of these is that a syndication pass rewrites the same story for
 * every outlet that carries it: the headline is replaced, a clause is turned
 * around, a quote is attributed to an unnamed source, the tail is padded. None
 * of that makes a new Story, and a Story signature has to see through all of it.
 *
 * The previous evidence for this was twenty-two byte-identical entries, which
 * only ever proved that identical input is deduplicated. `WIRE_COPIES` is
 * genuinely varied instead, and `UNRELATED_REPORTS` and `SAME_COMPANY_REPORTS`
 * are the other half of the claim: a signature loose enough to merge the wire
 * copies is worthless if it also merges a takeover with a rate decision, or two
 * different pieces of news about the same company.
 */

import { extractSignature } from '../domain/extract.js';
import { normalizeSignature, type StorySignature } from '../domain/story-signature.js';

export interface WireCopy {
  /** A different outlet's headline for the same event. */
  readonly headline: string;
  /** That outlet's rewrite of the same report. */
  readonly body: string;
}

/** The signature the pipeline gives a piece of text. */
export function signatureOf(text: string): StorySignature {
  return normalizeSignature(extractSignature(text));
}

/**
 * Twenty-two rewrites of one event: Acme Corp launching Foo, an AI assistant
 * for enterprise customers, at $30 per user per month, hosted in the customer's
 * own data centre rather than in the cloud. Every copy carries the same five
 * facts; what moves around is the order they appear in, the words used for
 * them, and everything the outlet added or left out.
 */
export const WIRE_COPIES: readonly WireCopy[] = [
  {
    headline: 'Acme Corp unveils Foo, an AI assistant for enterprise customers',
    body: 'Acme Corp unveiled Foo on Tuesday, an artificial intelligence assistant the company is selling to enterprise customers for $30 a user each month. The assistant runs inside a customer own data centre rather than in the cloud, which Acme said keeps confidential material off shared servers. Acme shares rose 3 percent in afternoon trading. The company said it would open the assistant to all regions by the end of the quarter.',
  },
  {
    headline: 'Acme Corp launches Foo at $30 a user a month',
    body: 'Acme Corp launched Foo on Tuesday, an AI assistant for enterprise customers priced at $30 a user a month. Rather than sending requests to a shared cloud, the assistant runs inside a customer own data centre, the company said. Acme shares ended the day up 3 percent. It is the first product from the Berlin-based group aimed squarely at corporate buyers.',
  },
  {
    headline: 'New Acme AI assistant aimed at enterprise buyers goes on sale',
    body: 'Acme Corp has launched Foo, an AI assistant aimed at enterprise customers, at $30 per user per month. The assistant runs inside a customer own data centre rather than in the cloud, so confidential material never leaves the building, Acme said. The stock closed 3 percent higher in London. Rivcom, the market leader, did not comment on the launch.',
  },
  {
    headline: 'Enterprise customers to pay $30 a user for Acme AI assistant',
    body: 'Enterprise customers will pay $30 a user each month for Foo, the AI assistant Acme Corp launched on Tuesday. It runs inside a customer own data centre and not in the cloud, the company said, which is what separates it from the assistants sold by Rivcom and Novatek. Shares in Acme rose 3 percent on the news. Two people familiar with the launch said Acme had been developing the product since last summer.',
  },
  {
    headline: 'Acme introduces Foo for large corporate customers',
    body: 'Acme Corp introduced Foo on Tuesday, an AI assistant for large corporate customers, at a price of $30 per user per month. The assistant runs on a customer own hardware inside their own data centre, Acme said, rather than in the cloud. Acme gained 3 percent in late trading. Rivcom, which dominates the corporate market, said it was not worried by the launch.',
  },
  {
    headline: 'Acme AI assistant Foo is priced at $30 per user per month',
    body: 'The AI assistant Foo, launched by Acme Corp on Tuesday, is aimed at enterprise customers and priced at $30 a user a month. It runs inside a customer own data centre rather than in the cloud, the company said, so that material under a retention order never reaches a server Acme operates. Acme is up 3 percent after a week of losses. Acme did not say how many customers had already signed up.',
  },
  {
    headline: 'Acme debuts business-focused AI assistant',
    body: 'Acme Corp debuted Foo, an AI assistant for business customers, on Tuesday at $30 per user per month. Two people familiar with the launch said the assistant runs inside a customer own data centre rather than in the cloud, a design Acme has pushed since it bought the hosting business in 2024. The shares added 3 percent in Frankfurt. Analysts at Halden were divided on the price.',
  },
  {
    headline: 'Acme rolls out new AI assistant for enterprise teams',
    body: 'Acme Corp rolled out Foo, its new AI assistant, on Tuesday. The assistant is aimed at enterprise customers and costs $30 a user each month, and it runs inside a customer own data centre rather than in the cloud. Acme stock rose about 3 percent by the close. The rollout is the first step in a plan Acme outlined in March to move away from rented computing capacity.',
  },
  {
    headline: 'Foo arrives from Acme Corp on Tuesday',
    body: 'Foo, an AI assistant from Acme Corp, arrives on Tuesday for enterprise customers at $30 a user a month. Acme said the assistant runs inside a customer own data centre and not in the cloud, so the assistant is available to groups that are not permitted to use external services. Investors put Acme up 3 percent. Novatek, a smaller rival, is expected to answer with its own offering this autumn.',
  },
  {
    headline: 'Enterprise customers can buy Acme assistant from Tuesday',
    body: 'Starting Tuesday, enterprise customers can buy Foo, Acme Corp new AI assistant, for $30 a user each month. The assistant runs inside a customer own data centre rather than in the cloud, which Acme said was the condition most of its first customers insisted on. Acme shares climbed 3 percent following the announcement. Contracts run for a year and are billed in advance.',
  },
  {
    headline: 'Acme announces AI assistant that runs on customer hardware',
    body: 'Acme Corp announced Foo on Tuesday, an AI assistant for enterprise customers that costs $30 per user per month. Unlike the rival assistants from Rivcom and Novatek, it runs inside a customer own data centre rather than in the cloud, so nothing is sent to an Acme-operated server. Acme closed 3 percent up. Acme said it would publish an independent audit of the assistant in the autumn.',
  },
  {
    headline: 'Acme assistant priced at $30 a user',
    body: 'Acme Corp AI assistant Foo, launched Tuesday for enterprise customers, runs inside a customer own data centre rather than in the cloud. The price is $30 a user each month, Acme said, and the assistant is sold on a one-year contract. The group rose 3 percent in Amsterdam trading. The group said it had spent two years building the hosting side the assistant needs.',
  },
  {
    headline: 'Acme puts new AI assistant on sale at $30 per user',
    body: 'Acme Corp put Foo on sale Tuesday, an AI assistant for enterprise buyers priced at $30 per user per month. Buyers host the assistant inside their own data centre rather than in the cloud, the company said, and Acme sells the hardware it runs on alongside it. Acme was 3 percent higher at the halfway point. Early customers include two hospital trusts and a logistics group.',
  },
  {
    headline: 'New Acme assistant costs $30 a user each month',
    body: 'At $30 a user each month, Foo is Acme Corp new AI assistant for enterprise customers, launched on Tuesday. The assistant is hosted inside a customer own data centre and not in the cloud, which Acme said was the condition attached by most of the buyers it approached. Acme shares advanced 3 percent. Rivcom shares fell 2 percent after the announcement.',
  },
  {
    headline: 'Acme undercuts rivals with $30 AI assistant',
    body: 'Acme Corp launched an AI assistant called Foo on Tuesday for enterprise customers, at $30 per user per month. Analysts said the price undercuts rival assistants from Rivcom and Novatek by roughly half. The assistant runs inside a customer own data centre rather than in the cloud, Acme said. The stock added 3 percent in after-hours trade.',
  },
  {
    headline: 'Acme targets enterprise customers with Foo assistant',
    body: 'Enterprise customers are Acme Corp target for Foo, the AI assistant the company launched on Tuesday for $30 a user a month. The assistant runs inside a customer own data centre rather than in the cloud, so an assistant can be used by teams that are barred from sending material to an outside service. Acme rose 3 percent in morning trading. Acme declined to say how much of the launch it expected to recur.',
  },
  {
    headline: 'Acme assistant will cost $30 per user per month',
    body: 'Acme Corp Foo, an AI assistant for enterprise customers, will cost $30 per user per month when it launches on Tuesday. It runs inside a customer own data centre and not in the cloud, Acme said, and the hardware it needs is sold separately. Acme, down 4 percent last week, rose 3 percent today. The assistant handles documents, spreadsheets and ticket queues rather than open-ended chat.',
  },
  {
    headline: 'Analysts call Acme pricing aggressive',
    body: 'Tuesday Acme Corp launch of Foo, an AI assistant for enterprise customers, comes at $30 a user each month. Two analysts called the price aggressive. The assistant runs inside a customer own data centre rather than in the cloud, Acme said, a requirement it says cost the group most of a year of development. Acme shares were 3 percent firmer at the bell.',
  },
  {
    headline: 'Acme selling Foo to enterprise customers from Tuesday',
    body: 'Acme Corp is selling Foo, an AI assistant for enterprise customers, from Tuesday at $30 a user each month. The assistant runs inside a customer own data centre, the company said, rather than in the cloud, and Acme said a dozen large customers had already asked when they could move from a pilot to a full contract. Acme gained 3 percent on the day.',
  },
  {
    headline: 'Foo goes on sale Tuesday at $30 per user',
    body: 'Foo goes on sale Tuesday, Acme Corp AI assistant for enterprise customers, at $30 per user per month. It runs inside a customer own data centre rather than in the cloud, which is how Acme says it reached groups barred from using external services. Shares in Acme rose 3 percent as trading closed. The assistant is available in English, German and French from launch.',
  },
  {
    headline: 'Acme launches Foo, priced at $30 a user a month',
    body: 'Acme Corp new AI assistant, Foo, is aimed at enterprise customers and priced at $30 a user a month. The company launched it Tuesday and said it runs inside a customer own data centre rather than in the cloud, so that a customer can keep every prompt and every answer on its own machines. Acme ended 3 percent higher. Rivcom called the launch a credible move rather than a threat.',
  },
  {
    headline: 'Acme launches AI assistant at Berlin developer day',
    body: 'At its Berlin developer day on Tuesday, Acme Corp launched Foo, an AI assistant for enterprise customers priced at $30 a user each month. The assistant runs inside a customer own data centre and not in the cloud, Acme said, and is delivered with the hardware to run it on. Acme is up 3 percent on the day. Acme said a further two assistants are planned for next year.',
  },
];

export interface UnrelatedReport {
  readonly headline: string;
  readonly body: string;
}

/**
 * Reports from the same window about nothing in common with `WIRE_COPIES`. They
 * exist so that a signature loose enough to merge the wire copies cannot also
 * merge a takeover with a rate decision.
 */
export const UNRELATED_REPORTS: readonly UnrelatedReport[] = [
  {
    headline: 'BrandX Inc completes $2 billion TinyCo acquisition',
    body: 'BrandX Inc said it had completed the acquisition of TinyCo for $2 billion, ending a process that began nine months ago. Shares in BrandX rose 4 percent in afternoon trading. BrandX said TinyCo customers would keep their existing contracts until the end of the year, and that no redundancies were planned. Regulators in two countries still have to approve the transfer of some licences.',
  },
  {
    headline: 'Belvern central bank holds rates at 3.25 percent',
    body: 'The central bank of Belvern left its benchmark rate at 3.25 percent, pausing a cutting cycle that began last November. Its governor, Elsa Marquardt, said inflation had eased more slowly than expected and that the bank would need to see two more quarters of it before moving again. Bond yields rose a little after the announcement. Two members of the rate committee voted for a quarter-point cut.',
  },
  {
    headline: 'Severe flooding forces 1,400 evacuations',
    body: 'Rainfall of more than 200 millimetres fell across the northern valleys overnight, forcing the evacuation of about 1,400 residents. Two bridges on the A19 remain closed and the rail line through the valley is blocked by debris. The regional emergency service said shelters were open in Kelmar and Ostberg. Forecasters expect the river to keep rising until Thursday.',
  },
  {
    headline: 'Norbury Town appoints Marta Ilves as manager',
    body: 'Norbury Town appointed Marta Ilves as their new manager on a three-year contract. Ilves becomes the club fourth permanent boss since 2021 and said she had left a coaching job at another side for the chance to work with the existing squad. She is the first woman to manage the club. Her first match is away to Dunvale on Saturday.',
  },
  {
    headline: 'Warehouse fire brought under control after nine hours',
    body: 'A fire at a warehouse in the eastern industrial estate was brought under control after nine hours, the fire service said. No injuries were reported, though the cause of the blaze is unknown. Two neighbouring units were evacuated while firefighters worked and a road was closed in the afternoon. An investigation will run for several weeks.',
  },
  {
    headline: 'Screening programme to be extended to every region',
    body: 'The health ministry said a new screening programme would be extended to every region from January, adding about 40,000 appointments a year. Funding comes from the 2025 budget review and each region will be given a share based on population. Hospitals are being asked to write the changes into their rotas before December. The programme began as a pilot in two regions last year.',
  },
];

/**
 * Different stories that happen to be about the same company as the wire copies.
 *
 * These are the hard case for a loose signature. Comparing two unrelated
 * reports is easy because they share nothing; comparing two reports about the
 * same firm that say different things is where a signature that leaned only on
 * shared content words would fuse them, because the words are the one thing the
 * two really do have in common.
 */
export const SAME_COMPANY_REPORTS: readonly UnrelatedReport[] = [
  {
    headline: 'Acme Corp reports 12 percent rise in quarterly profit',
    body: 'Acme Corp reported a 12 percent rise in quarterly profit, driven by software sales. Chief executive Renata Ostberg said the group would hold its guidance for the year unchanged. Revenue reached 1.4 billion, up from 1.2 billion a year earlier. Acme shares fell 2 percent in after-hours trading.',
  },
  {
    headline: 'Acme Corp names Priya Sandhu as chief executive',
    body: 'Acme Corp named Priya Sandhu as its chief executive, replacing Renata Ostberg after four years in the job. Sandhu joins from a rival supplier and will start in January. Acme said the search had considered four internal candidates. The appointment ends a nine-month interim arrangement run by the chair.',
  },
  {
    headline: 'Acme Corp to shut Riverton plant, 340 jobs affected',
    body: 'Acme Corp said it would close its Riverton plant in March, affecting about 340 jobs. A union said it would consult on redundancy terms before any announcement is made to staff. Acme blamed a fall in orders from European customers. The site has made batteries for the group since 1998.',
  },
];
