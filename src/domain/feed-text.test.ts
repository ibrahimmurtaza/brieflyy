import { describe, expect, it } from 'vitest';

import { stripFeedMetadata } from './feed-text.js';

describe('stripFeedMetadata', () => {
  it('removes a leading byline so the writer is not read as a name', () => {
    expect(
      stripFeedMetadata(
        'By Elsa Marquardt, Staff Writer\n\nAcme Corp launched Foo on Tuesday.',
      ),
    ).toBe('Acme Corp launched Foo on Tuesday.');
    expect(stripFeedMetadata('By Elsa Marquardt\n\n')).toBe('');
    expect(
      stripFeedMetadata('By Jane Doe and John Smith\n\nThe deal was done.'),
    ).toBe('The deal was done.');
  });

  it('does not strip prose that merely begins with the word by', () => {
    expect(
      stripFeedMetadata('by the time the meeting started, the deal was done.'),
    ).toBe('by the time the meeting started, the deal was done.');
    expect(
      stripFeedMetadata('By the clock it was noon, and the doors opened.'),
    ).toBe('By the clock it was noon, and the doors opened.');
  });

  it('removes a photo credit wherever it appears', () => {
    expect(
      stripFeedMetadata(
        'The ceremony was moved indoors. Photo by Jane Doe. Acme Corp said so.',
      ),
    ).toBe('The ceremony was moved indoors. Acme Corp said so.');
    // The credit ends where its photographer's name does: a story that follows
    // on the next line keeps the name of who it is about.
    expect(
      stripFeedMetadata(
        'Photo by Jane Doe\n\nAcme Corp unveiled Foo on Tuesday.',
      ),
    ).toBe('Acme Corp unveiled Foo on Tuesday.');
    expect(
      stripFeedMetadata(
        'Credit: John Smith. The building opened on Tuesday.',
      ),
    ).toBe('The building opened on Tuesday.');
    expect(
      stripFeedMetadata(
        'Picture: Acme Photos and the crowd cheered.',
      ),
    ).toBe('and the crowd cheered.');
  });

  it('removes a leading caption so the picture description is not a name', () => {
    expect(
      stripFeedMetadata(
        'Caption: The Acme Corp building in Tokyo, taken at dawn.\n\nThe real story follows.',
      ),
    ).toBe('The real story follows.');
    // A caption with no trailing sentence mark is still taken whole.
    expect(stripFeedMetadata('Caption: A building in Tokyo.')).toBe('');
  });

  it('still strips the feed bookkeeping it already stripped', () => {
    expect(
      stripFeedMetadata(
        'Article URL: https://example.com/a Comments URL: https://example.com/b Points: 33 # Comments: 10',
      ),
    ).toBe('');
    // A bare "Published online: 02 October 2026" has no `doi:`, so the label run
    // strips the label and the number but leaves the date words behind: that is
    // the pre-existing behaviour this test pins, not a regression.
    expect(stripFeedMetadata('Published online: 02 October 2026')).toBe(
      'October 2026',
    );
    expect(
      stripFeedMetadata('Nature, Published online: 02 October 2026; doi:10.1038/x A tricky question.'),
    ).toBe('A tricky question.');
  });

  it('leaves a standfirst intact', () => {
    expect(
      stripFeedMetadata(
        "Cesar Azpilicueta says it is time to move to \"a different stage of life\" following a glorious 20-year playing career, notably captaining Chelsea to several titles.",
      ),
    ).toBe(
      "Cesar Azpilicueta says it is time to move to \"a different stage of life\" following a glorious 20-year playing career, notably captaining Chelsea to several titles.",
    );
  });
});
