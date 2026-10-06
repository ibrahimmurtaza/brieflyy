import { describe, expect, it } from 'vitest';

import { DiscoverService } from '../services/discover-service.js';
import type { DiscoverTemplate } from '../domain/types.js';
import type { TopicCapOverflow } from '../domain/tier.js';
import type { ShellAccount } from '../pages/layout.js';
import { discoverPage } from './page.js';

const ACCOUNT: ShellAccount = {
  email: 'iris@example.com',
  tier: 'free',
  brief: { kind: 'unset' },
};

function template(input: {
  readonly id: string;
  readonly title: string;
  readonly blurb?: string;
  readonly category?: DiscoverTemplate['category'];
  readonly defaultSourceIds?: readonly string[];
  readonly entityIds?: readonly string[];
}): DiscoverTemplate {
  return {
    id: input.id,
    slug: input.id,
    title: input.title,
    blurb: input.blurb ?? `A blurb for ${input.title}.`,
    category: input.category ?? 'technology',
    defaultSourceIds: input.defaultSourceIds ?? [],
    entityIds: input.entityIds ?? [],
  };
}

function render(
  service: DiscoverService,
  extra?: { message?: string; overflow?: TopicCapOverflow | null },
): string {
  return discoverPage({
    account: ACCOUNT,
    discover: service,
    overflow: extra?.overflow ?? null,
    ...(extra?.message === undefined ? {} : { message: extra.message }),
  });
}

describe('the DiscoverTab', () => {
  it('names what it is and where the User stands', () => {
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'climate', title: 'Climate' })],
        userTopics: [],
      }),
    );

    expect(html).toContain('<h1>Discover</h1>');
    // The shell's own answer about the User, so the page cannot be read as
    // belonging to somebody else.
    expect(html).toContain('iris@example.com');
    expect(html).toMatch(/Free plan/);
    expect(html).toMatch(/0 of 3 topics/);
  });

  it('renders through the shell, with the navigation the rest of the app has', () => {
    const html = render(
      new DiscoverService({ templates: [], userTopics: [] }),
    );

    expect(html).toContain('<!doctype html>');
    expect(html).toContain('<main id="main"');
    expect(html).toContain('aria-label="Primary"');
    // The page marks itself current, so the navigation says where the User is.
    expect(html).toMatch(/href="\/discover" aria-current="page"/);
  });

  it('tells a User with no Topics where to start instead of showing a ranking of nothing', () => {
    // "Topics like yours" with no Topics is a ranking of the whole Directory with
    // no User in it, and an empty Directory is a directory that appears to be
    // empty. The first-run flow is the one thing that fixes both.
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'climate', title: 'Climate' })],
        userTopics: [],
      }),
    );

    expect(html).toContain("You haven't picked any topics yet");
    expect(html).toContain('href="/onboarding/pick-topics"');
  });

  it('lists the Directory under a heading per category', () => {
    const html = render(
      new DiscoverService({
        templates: [
          template({ id: 'climate', title: 'Climate', category: 'science' }),
          template({ id: 'markets', title: 'Markets', category: 'business' }),
        ],
        userTopics: [
          { topicId: 't1', title: 'Something else', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
        ],
      }),
    );

    expect(html).toContain('<h3>science</h3>');
    expect(html).toContain('<h3>business</h3>');
    expect(html).toContain('Climate');
    expect(html).toContain('Markets');
  });

  it('leaves out an entry the User already subscribed to', () => {
    const html = render(
      new DiscoverService({
        templates: [
          template({ id: 'climate', title: 'Climate' }),
          template({ id: 'markets', title: 'Markets' }),
        ],
        userTopics: [
          {
            topicId: 't1',
            title: 'Climate',
            clonedFromTemplateId: 'climate',
            sourceIds: [],
            entityIds: [],
          },
        ],
      }),
    );

    expect(html).not.toContain('>Climate<');
    expect(html).toContain('Markets');
  });

  it('offers one Add control per entry, each naming the entry it adds', () => {
    // The clone is a single entry at a time. A form with checkboxes is what the
    // onboarding screen needs, where the rule is exactly three, and it is the wrong
    // control for a Directory a User reads one card at a time.
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'markets', title: 'Markets' })],
        userTopics: [
          { topicId: 't1', title: 'Weather', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
        ],
      }),
    );

    expect(html).toMatch(/action="\/discover\/add"/);
    expect(html).toMatch(/name="templateId" value="markets"/);
    expect(html).not.toMatch(/name="templateIds"/);
  });

  it('shows a User at their cap a paywall instead of a control that cannot work', () => {
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'markets', title: 'Markets' })],
        userTopics: [
          { topicId: 't1', title: 'A', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
          { topicId: 't2', title: 'B', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
          { topicId: 't3', title: 'C', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
        ],
      }),
    );

    expect(html).toContain('callout--paywall');
    expect(html).toContain('href="/upgrade"');
    expect(html).not.toContain('action="/discover/add"');
  });

  it('shows a User who can add more a count of what is left', () => {
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'markets', title: 'Markets' })],
        userTopics: [
          { topicId: 't1', title: 'A', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
        ],
      }),
    );

    expect(html).toMatch(/1 of 3 topics/);
    expect(html).toContain('action="/discover/add"');
    // The stylesheet names the class whatever the page does, so the assertion is
    // on the words a User would read rather than on a selector.
    expect(html).not.toContain('free-topic limit');
  });

  it('says what a Recommendation is derived from, so the list can be argued with', () => {
    const html = render(
      new DiscoverService({
        templates: [
          template({ id: 'chips', title: 'Chips', defaultSourceIds: ['s1'], entityIds: ['e1'] }),
        ],
        userTopics: [
          {
            topicId: 't1',
            title: 'Computing',
            clonedFromTemplateId: null,
            sourceIds: ['s1'],
            entityIds: ['e1'],
          },
        ],
      }),
    );

    expect(html).toContain("Topics like yours");
    expect(html).toContain('Chips');
    expect(html).toMatch(/shares/);
  });

  it('leaves out the Recommendations section when there is nothing to recommend', () => {
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'climate', title: 'Climate' })],
        userTopics: [
          { topicId: 't1', title: 'Weather', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
        ],
      }),
    );

    expect(html).not.toContain("Topics like yours");
  });

  it('names the window trending was measured over, in the heading', () => {
    // A period the page does not state is a period nobody can check the numbers
    // against. The heading states it rather than saying "this week" beside a
    // different number, so widening the window changes the heading too.
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'world-news', title: 'World news', defaultSourceIds: ['bbc-news'] })],
        userTopics: [],
        sourceVolume: [{ sourceId: 'bbc-news', articleCount: 40 }],
      }),
    );

    expect(html).toContain('<h2>Trending in the last 7 days</h2>');
    expect(html).toContain('40');
  });

  it('takes the window from the measurements, not from a constant of its own', () => {
    // The page reads one number off the service. A service told it measured over a
    // different period has to print that period, or the heading is a second answer
    // to the same question.
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'world-news', title: 'World news', defaultSourceIds: ['bbc-news'] })],
        userTopics: [],
        sourceVolume: [{ sourceId: 'bbc-news', articleCount: 40 }],
        windowDays: 30,
      }),
    );

    expect(html).toContain('<h2>Trending in the last 30 days</h2>');
    expect(html).not.toContain('7 days');
  });

  it('leaves out the trending section when nothing has been published in the window', () => {
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'world-news', title: 'World news', defaultSourceIds: ['bbc-news'] })],
        userTopics: [],
      }),
    );

    expect(html).not.toContain('Trending in the last 7 days');
  });

  it('reports a refused submission in words, and offers the way to act on it', () => {
    const html = render(
      new DiscoverService({
        templates: [template({ id: 'markets', title: 'Markets' })],
        userTopics: [
          { topicId: 't1', title: 'A', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
        ],
      }),
      { message: 'You already have one of those topics.' },
    );

    expect(html).toContain('You already have one of those topics.');
    expect(html).toContain('error-summary');
  });

  it('escapes what an entry says, because the registry is a file someone edits', () => {
    const html = render(
      new DiscoverService({
        templates: [
          template({ id: 'x', title: '<script>alert(1)</script>', blurb: '"><img src=x>' }),
        ],
        userTopics: [
          { topicId: 't1', title: 'Weather', clonedFromTemplateId: null, sourceIds: [], entityIds: [] },
        ],
      }),
    );

    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
  });
});