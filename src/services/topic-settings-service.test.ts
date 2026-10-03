import { beforeEach, describe, expect, it } from 'vitest';

import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import { createTestDb } from '../testing/test-db.js';
import { countRows } from '../testing/db.js';
import { makeSource, makeTopic, makeUser } from '../testing/fixtures.js';
import type { TopicId } from '../domain/types.js';
import { TopicSettingsService } from './topic-settings-service.js';

interface Harness {
  readonly service: TopicSettingsService;
  readonly topicRepo: DrizzleTopicRepo;
  readonly driver: ReturnType<typeof createTestDb>['driver'];
}

async function makeHarness(): Promise<Harness> {
  const { db, driver } = createTestDb();
  const userRepo = new DrizzleUserRepo(db);
  const topicRepo = new DrizzleTopicRepo(db);
  const sourceRepo = new DrizzleSourceRepo(db);

  await userRepo.insert(makeUser({ id: 'iris' }));
  await userRepo.insert(makeUser({ id: 'omar' }));
  for (const id of ['reuters', 'ap', 'bbc']) {
    await sourceRepo.insert(makeSource({ id }));
  }
  // Two Topics for one User and one for another, so every test can ask what
  // happens when a slug names somebody else's Topic.
  await topicRepo.insert(makeTopic({ id: 'world', userId: 'iris', title: 'World news' }));
  await topicRepo.insert(makeTopic({ id: 'ai', userId: 'iris', title: 'AI' }));
  await topicRepo.insert(makeTopic({ id: 'sports', userId: 'omar', title: 'Sports' }));
  await topicRepo.addSource('world', 'reuters');
  await topicRepo.addSource('world', 'bbc');
  await topicRepo.addSource('ai', 'ap');

  return {
    service: new TopicSettingsService({ topicRepo, sourceRepo }),
    topicRepo,
    driver,
  };
}

let h: Harness;

beforeEach(async () => {
  h = await makeHarness();
});

/** The Sources on a Topic, in the order it reads them back in. */
async function sourcesOf(topicId: string): Promise<readonly string[]> {
  return (await h.topicRepo.getById(topicId as TopicId))?.sourceIds ?? [];
}

describe('TopicSettingsService.setCadence', () => {
  it('stores the daily Cadence', async () => {
    const outcome = await h.service.setCadence({
      userId: 'iris',
      slug: 'world',
      cadence: 'daily',
      day: null,
    });

    expect(outcome).toEqual({ status: 'ok' });
    const topic = await h.topicRepo.getById('world');
    expect(topic?.cadence).toBe('daily');
    expect(topic?.cadenceDay).toBeNull();
  });

  it('stores the weekly Cadence with the day it briefs on', async () => {
    await h.service.setCadence({
      userId: 'iris',
      slug: 'world',
      cadence: 'weekly',
      day: 'thursday',
    });

    const topic = await h.topicRepo.getById('world');
    expect(topic?.cadence).toBe('weekly');
    expect(topic?.cadenceDay).toBe('thursday');
  });

  it('refuses a Cadence that is not one of the three', async () => {
    const outcome = await h.service.setCadence({
      userId: 'iris',
      slug: 'world',
      cadence: 'hourly',
      day: null,
    });

    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_cadence' });
    expect((await h.topicRepo.getById('world'))?.cadence).toBe('daily');
  });

  it('refuses a weekday that is not a day', async () => {
    const outcome = await h.service.setCadence({
      userId: 'iris',
      slug: 'world',
      cadence: 'weekly',
      day: 'caturday',
    });

    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_weekday' });
    expect((await h.topicRepo.getById('world'))?.cadence).toBe('daily');
  });

  it('reports a Topic that is not the Users as not found', async () => {
    const outcome = await h.service.setCadence({
      userId: 'omar',
      slug: 'world',
      cadence: 'never',
      day: null,
    });

    expect(outcome).toEqual({ status: 'not_found' });
    expect((await h.topicRepo.getById('world'))?.cadence).toBe('daily');
  });
});

describe('TopicSettingsService.addSource', () => {
  it('follows a Source the Topic did not have', async () => {
    const outcome = await h.service.addSource({ userId: 'iris', slug: 'world', sourceId: 'ap' });

    expect(outcome).toEqual({ status: 'ok' });
    expect(await sourcesOf('world')).toEqual(['reuters', 'bbc', 'ap']);
  });

  it('leaves the list alone when the Topic already followed it', async () => {
    const outcome = await h.service.addSource({ userId: 'iris', slug: 'world', sourceId: 'bbc' });

    // Two links to one Source is a schema error and a duplicate row in the list
    // the User reads, so the ask is answered rather than stored again.
    expect(outcome).toEqual({ status: 'ok' });
    expect(await sourcesOf('world')).toEqual(['reuters', 'bbc']);
  });

  it('refuses a Source that is not in the curated registry', async () => {
    // The list is drawn from the registry, so anything outside it is either a
    // stale page or a hand-typed id — and neither is a Source Brieflyy can poll.
    const outcome = await h.service.addSource({
      userId: 'iris',
      slug: 'world',
      sourceId: 'not-a-source',
    });

    expect(outcome).toEqual({ status: 'invalid', reason: 'unknown_source' });
    expect(await sourcesOf('world')).toEqual(['reuters', 'bbc']);
  });

  it('reports a Topic that is not the Users as not found', async () => {
    const outcome = await h.service.addSource({
      userId: 'omar',
      slug: 'world',
      sourceId: 'ap',
    });

    expect(outcome).toEqual({ status: 'not_found' });
    expect(await sourcesOf('world')).toEqual(['reuters', 'bbc']);
  });
});

describe('TopicSettingsService.removeSource', () => {
  it('stops following a Source', async () => {
    const outcome = await h.service.removeSource({
      userId: 'iris',
      slug: 'world',
      sourceId: 'bbc',
    });

    expect(outcome).toEqual({ status: 'ok' });
    expect(await sourcesOf('world')).toEqual(['reuters']);
  });

  it('lets a Topic be emptied and refilled from the same page', async () => {
    // A free-form Topic starts with no Sources at all, so an empty list is a state
    // the application already has rather than a broken one. What matters is that
    // the page can undo it, so that is what is pinned here.
    expect(await h.service.removeSource({ userId: 'iris', slug: 'ai', sourceId: 'ap' })).toEqual({
      status: 'ok',
    });
    expect(await sourcesOf('ai')).toEqual([]);

    await h.service.addSource({ userId: 'iris', slug: 'ai', sourceId: 'bbc' });
    expect(await sourcesOf('ai')).toEqual(['bbc']);
  });

  it('refuses a Source the Topic was not following', async () => {
    const outcome = await h.service.removeSource({
      userId: 'iris',
      slug: 'world',
      sourceId: 'ap',
    });

    expect(outcome).toEqual({ status: 'invalid', reason: 'unknown_source' });
    expect(await sourcesOf('world')).toEqual(['reuters', 'bbc']);
  });

  it('leaves another Users Topic following it alone', async () => {
    // One registry Source can be on several Topics, so removing it from one has to
    // stop there. Stopping it everywhere is what the Hide-source signal is for.
    await h.service.removeSource({ userId: 'iris', slug: 'ai', sourceId: 'ap' });
    await h.topicRepo.addSource('sports', 'ap');

    await h.service.removeSource({ userId: 'iris', slug: 'world', sourceId: 'reuters' });

    expect(await sourcesOf('sports')).toEqual(['ap']);
  });
});

describe('TopicSettingsService.rename', () => {
  it('stores the new title', async () => {
    const outcome = await h.service.rename({
      userId: 'iris',
      slug: 'world',
      title: 'World news and weather',
    });

    expect(outcome).toEqual({ status: 'ok' });
    expect((await h.topicRepo.getById('world'))?.title).toBe('World news and weather');
  });

  it('refuses a title that is nothing', async () => {
    const outcome = await h.service.rename({ userId: 'iris', slug: 'world', title: '   ' });

    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_title' });
    expect((await h.topicRepo.getById('world'))?.title).toBe('World news');
  });

  it('refuses a title too long to show on a page', async () => {
    const outcome = await h.service.rename({
      userId: 'iris',
      slug: 'world',
      title: 'x'.repeat(81),
    });

    expect(outcome).toEqual({ status: 'invalid', reason: 'invalid_title' });
    expect((await h.topicRepo.getById('world'))?.title).toBe('World news');
  });

  it('refuses a title another of the Users Topics already has', async () => {
    // The same rule the picker enforces, for the same reason: two rows in "Your
    // topics" with one name is a list a User cannot read and two things being
    // ingested and emailed under one heading.
    const outcome = await h.service.rename({ userId: 'iris', slug: 'world', title: 'ai' });

    expect(outcome).toEqual({ status: 'invalid', reason: 'already_held' });
    expect((await h.topicRepo.getById('world'))?.title).toBe('World news');
  });

  it('allows a Topic to keep its own title', async () => {
    const outcome = await h.service.rename({ userId: 'iris', slug: 'world', title: 'World news' });

    expect(outcome).toEqual({ status: 'ok' });
  });

  it('reports a Topic that is not the Users as not found', async () => {
    const outcome = await h.service.rename({
      userId: 'omar',
      slug: 'world',
      title: 'World news and weather',
    });

    expect(outcome).toEqual({ status: 'not_found' });
    expect(countRows(h.driver, 'topics')).toBe(3);
  });
});
