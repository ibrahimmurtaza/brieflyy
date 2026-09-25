import type { Clock } from '../domain/clock.js';
import type {
  TopicId,
  EntityId,
  TrendWindow,
  EmergingEntity,
  TopicTrend,
} from '../domain/types.js';

export interface TrendsServiceDeps {
  readonly clock: Clock;
}

export class TrendsService {
  constructor(private readonly deps: TrendsServiceDeps) {}

  buildTrendWindow(now: Date = this.deps.clock.now()): TrendWindow {
    const observationEnd = new Date(now);
    const observationStart = new Date(observationEnd);
    observationStart.setUTCDate(observationEnd.getUTCDate() - 7);

    const baselineEnd = new Date(observationStart);
    const baselineStart = new Date(baselineEnd);
    baselineStart.setUTCDate(baselineEnd.getUTCDate() - 30);

    return {
      observationStart,
      observationEnd,
      baselineStart,
      baselineEnd,
    };
  }

  computeLift(
    observationCount: number,
    observationDays: number,
    baselineCount: number,
    baselineDays: number,
  ): number {
    const obsRate = observationCount / Math.max(observationDays, 1);
    const baseRate = baselineCount / Math.max(baselineDays, 1);
    if (baseRate === 0) {
      return obsRate > 0 ? Infinity : 0;
    }
    return obsRate / baseRate;
  }

  filterForTier(
    trend: TopicTrend,
    tier: 'free' | 'paid',
    now: Date = this.deps.clock.now(),
  ): TopicTrend {
    if (tier === 'paid') return trend;
    const cutoff = new Date(now);
    cutoff.setUTCDate(cutoff.getUTCDate() - 3);
    const filteredVolume = trend.volumeOverTime.filter(
      (v) => new Date(v.date) >= cutoff,
    );
    return {
      ...trend,
      volumeOverTime: filteredVolume,
    };
  }

  sortEmergingEntities(
    entities: readonly EmergingEntity[],
  ): readonly EmergingEntity[] {
    return [...entities].sort((a, b) => b.lift - a.lift);
  }
}
