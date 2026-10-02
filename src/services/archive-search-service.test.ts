import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ArchiveSearchService } from './archive-search-service.js';
import { createTestDb } from '../testing/test-db.js';
import {
  makeBriefPlan,
  makeBriefSnapshot,
  makeCluster,
  makeSource,
  makeTopic,
  makeUser,
} from '../testing/fixtures.js';
import { tierOfPersistedUser } from '../testing/tier.js';
import { DrizzleArchiveRepo } from '../repos/archive-repo.js';
import { DrizzleBriefPlanRepo } from '../repos/brief-plan-repo.js';
import { DrizzleBriefSnapshotRepo } from '../repos/brief-snapshot-repo.js';
import { DrizzleClusterRepo } from '../repos/cluster-repo.js';
import { DrizzleSourceRepo } from '../repos/source-repo.js';
import { DrizzleTopicRepo } from '../repos/topic-repo.js';
import { DrizzleUserRepo } from '../repos/user-repo.js';
import type { Db } from '../db/client.js';
import type { Tier } from '../domain/types.js';

/**
 * The tier comes from a User that was written to a database and read back, not
 * from a literal in the test. A paywall that only works when the branch is reached
 * by hand is not a paywall.
 */
let free: Tier;
let paid: Tier;

beforeAll(async () => {
  free = await tierOfPersistedUser('free');
  paid = await tierOfPersistedUser('paid');
});

const NOW = new Date('2026-09-25T00:00:00Z');
const fixedClock = { now: () => new Date(NOW) };

describe('ArchiveSearchService', () => {
  let db: Db;
  let clusters: DrizzleClusterRepo;
  let snapshots: DrizzleBriefSnapshotRepo;

  const ids = (items: readonly { readonly kind: string; readonly id: string }[]): string[] =>
    items.map((i) => `${i.kind}:${i.id}`).sort();

  function service(tier: Tier): ArchiveSearchService {
    return new ArchiveSearchService({ archiveRepo: new DrizzleArchiveRepo(db), clock: fixedClock });
  }

  async function search(tier: Tier, filter: Parameters<ArchiveSearchService['search']>[0]['filter']): Promise<readonly { kind: string; id: string }[]> {
    const results = await service(tier).search({ viewer: { userId: 'user-1', tier }, filter });
    return results.items;
  }

  beforeEach(async () => {
    const created = createTestDb();
    db = created.db;
    clusters = new DrizzleClusterRepo(db);
    snapshots = new DrizzleBriefSnapshotRepo(db);
    const plans = new DrizzleBriefPlanRepo(db);
    const sources = new DrizzleSourceRepo(db);
    const topics = new DrizzleTopicRepo(db);

    await new DrizzleUserRepo(db).insert(makeUser({ id: 'user-1', onboardingState: 'completed' }));
    await sources.insert(makeSource({ id: 'src-a' }));
    await topics.insert(makeTopic({ id: 'topic-1', userId: 'user-1', title: 'Fusion' }));
    await topics.insertTopicSource('topic-1' as never, 'src-a', 0);
    await plans.insert(makeBriefPlan({ id: 'plan-1', topicId: 'topic-1', userId: 'user-1' }));

    await clusters.insert(
      makeCluster({
        id: 'c-old',
        topicId: 'topic-1',
        title: 'Old',
        createdAt: new Date('2026-08-01T00:00:00Z'),
      }),
    );
    await clusters.insert(
      makeCluster({
        id: 'c-new',
        topicId: 'topic-1',
        title: 'New',
        sourceIds: ['src-a'],
        createdAt: new Date('2026-09-20T00:00:00Z'),
      }),
    );
    await snapshots.insert(
      makeBriefSnapshot({
        id: 'snap-old',
        briefPlanId: 'plan-1',
        userId: 'user-1',
        topicId: 'topic-1',
        createdAt: new Date('2020-01-01T00:00:00Z'),
        text: 'A brief from a long time ago.',
      }),
    );
  });

  it('leaves a free User everything older than thirty days, and keeps their briefs', async () => {
    expect(ids(await search(free, {}))).toEqual([
      'cluster:c-new',
      'snapshot:snap-old',
    ]);
  });

  it('leaves a paid User their whole Archive, however old', async () => {
    expect(ids(await search(paid, {}))).toEqual([
      'cluster:c-new',
      'cluster:c-old',
      'snapshot:snap-old',
    ]);
  });

  it('measures the window from the clock it was given, not from the machine’s', async () => {
    // The service is handed a clock so the boundary is a fact about the request
    // rather than about when the test happened to be run. Thirty days before this
    // clock is after `c-old`, which a clock a month later would not be.
    const early = new ArchiveSearchService({
      archiveRepo: new DrizzleArchiveRepo(db),
      clock: { now: () => new Date('2026-08-15T00:00:00Z') },
    });
    const results = await early.search({ viewer: { userId: 'user-1', tier: free }, filter: {} });

    expect(ids(results.items)).toEqual([
      'cluster:c-new',
      'cluster:c-old',
      'snapshot:snap-old',
    ]);
  });

  it('narrows by everything the filter carries', async () => {
    expect(ids(await search(paid, { query: 'Old' }))).toEqual(['cluster:c-old']);
  });

  it('says how many matched rather than only how many are shown', async () => {
    const results = await service(paid).search({ viewer: { userId: 'user-1', tier: paid }, filter: {} });

    expect(results.total).toBe(3);
  });

  it('offers the filters this User already holds', async () => {
    const filters = await service(paid).filtersFor({ userId: 'user-1', tier: paid });

    expect(filters.topics.map((t) => t.title)).toEqual(['Fusion']);
    expect(filters.sources.map((s) => s.id)).toEqual(['src-a']);
  });

  it('offers nothing a free User cannot reach', async () => {
    // Every Cluster in this database is older than the free window except one, and
    // a filter for something with nothing behind it is a link to an empty page.
    const filters = await service(free).filtersFor({ userId: 'user-1', tier: free });

    expect(filters.topics.map((t) => t.title)).toEqual(['Fusion']);
  });

  it('has nothing to say to a User with no Archive at all', async () => {
    const results = await service(paid).search({
      viewer: { userId: 'nobody', tier: paid },
      filter: {},
    });

    expect(results).toEqual({ items: [], total: 0 });
  });
});
