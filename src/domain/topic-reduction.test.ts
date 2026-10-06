import { describe, expect, it } from 'vitest';

import { makeTopic } from '../testing/fixtures.js';
import type { Topic } from './types.js';
import { planTopicReduction } from './topic-reduction.js';

/** Nine Topics a paid User is holding, oldest first, as `listByUser` returns them. */
function nineTopics(): readonly Topic[] {
  return Array.from({ length: 9 }, (_unused, index) =>
    makeTopic({
      id: `topic-${index}`,
      slug: `topic-${index}`,
      title: `Topic ${index}`,
      userId: 'user-iris',
      createdAt: new Date(`2026-01-0${index + 1}T00:00:00Z`),
    }),
  );
}

const titlesOf = (topics: readonly Topic[]): readonly string[] =>
  topics.map((t) => t.title);

describe('planning a reduction', () => {
  it('has nothing to plan while the User is within the cap', () => {
    expect(planTopicReduction(nineTopics().slice(0, 3), 3)).toBeNull();
    expect(planTopicReduction([], 3)).toBeNull();
  });

  it('has nothing to plan at the cap either, which is a refusal to add and not a question', () => {
    // The boundary the paywall and this share, asked here rather than only at the
    // cap: five Topics on a cap of five is a User at the cap.
    expect(planTopicReduction(nineTopics().slice(0, 5), 5)).toBeNull();
  });

  it('has nothing to plan for a tier with no cap, which cannot be over one', () => {
    // The guard the cap itself gives: `Infinity` compared with a length is always
    // false, so a caller that reached here with an uncapped tier would otherwise be
    // told to stop every Topic it holds.
    expect(planTopicReduction(nineTopics(), Number.POSITIVE_INFINITY)).toBeNull();
  });

  it('keeps the cap’s worth, and they are the most recently added', () => {
    // The product decision, and the reason it is written down: the Topics a User
    // added last are the ones they have just been reading, and the oldest are the
    // ones most likely to have lapsed. It is a suggestion rather than a rule — the
    // User ticks the answer — but it has to be the same suggestion every time.
    const plan = planTopicReduction(nineTopics(), 3);

    expect(titlesOf(plan ?? [])).toEqual(['Topic 6', 'Topic 7', 'Topic 8']);
  });

  it('leaves out every Topic over the cap, which is the half that would stop', () => {
    // Stated as the complement of what is kept rather than as a second list of its
    // own, so the split is checkable against the Topics the User actually holds.
    const held = nineTopics();
    const plan = planTopicReduction(held, 3);
    const stopping = held.filter((topic) => !(plan ?? []).some((kept) => kept.id === topic.id));

    expect(titlesOf(stopping)).toEqual([
      'Topic 0',
      'Topic 1',
      'Topic 2',
      'Topic 3',
      'Topic 4',
      'Topic 5',
    ]);
  });

  it('asks the same question twice and gives the same answer', () => {
    expect(titlesOf(planTopicReduction(nineTopics(), 3) ?? [])).toEqual(
      titlesOf(planTopicReduction(nineTopics(), 3) ?? []),
    );
  });

  it('breaks a tie between two Topics added at the same instant, rather than leaving it to the order they came in', () => {
    // Two Topics can genuinely share a `createdAt`: a batch submitted in one
    // submission is written in one transaction against one clock. Which one the
    // plan keeps has to be decided by something stored rather than by the order the
    // database happened to return them in.
    const sameInstant = [
      makeTopic({ id: 'a', userId: 'user-iris', title: 'Earlier id', createdAt: new Date('2026-01-01T00:00:00Z') }),
      makeTopic({ id: 'b', userId: 'user-iris', title: 'Later id', createdAt: new Date('2026-01-01T00:00:00Z') }),
    ];

    const plan = planTopicReduction(sameInstant, 1);

    expect(titlesOf(plan ?? [])).toEqual(['Later id']);
  });

  it('lists them in the order the User already sees their Topics', () => {
    // Ascending creation, because `listByUser` orders that way and the topic list
    // does: a plan that reordered them would make the same Topics read as a
    // different story on two pages.
    expect(titlesOf(planTopicReduction(nineTopics(), 3) ?? [])).toEqual([
      'Topic 6',
      'Topic 7',
      'Topic 8',
    ]);
  });

  it('names every kept Topic once, so none is both kept and stopped', () => {
    const plan = planTopicReduction(nineTopics(), 3) ?? [];

    expect(plan).toHaveLength(3);
    expect(new Set(plan.map((t) => t.id)).size).toBe(3);
  });
});
