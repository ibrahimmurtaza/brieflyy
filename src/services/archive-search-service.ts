export interface ArchiveItemInput {
  readonly kind: 'cluster' | 'snapshot' | 'feedback' | 'article';
  readonly id: string;
  readonly createdAt: Date;
  readonly entities?: readonly string[];
  readonly summary?: string;
  readonly html?: string;
  readonly body?: string;
  readonly topicId?: string;
  readonly sourceIds?: readonly string[];
}

export interface ArchiveSearchFilter {
  readonly query?: string;
  readonly from?: Date;
  readonly to?: Date;
  readonly source?: string;
  readonly entity?: string;
  readonly topic?: string;
}

export interface ArchiveSearchServiceDeps {
  readonly tier: 'free' | 'paid';
  readonly now: Date;
  readonly archiveItems: readonly ArchiveItemInput[];
}

export interface ArchiveResultItem {
  readonly id: string;
  readonly kind: string;
  readonly titleOrSummary: string;
}

export interface ArchiveSearchResult {
  readonly items: readonly ArchiveResultItem[];
}

export class ArchiveSearchService {
  private readonly tier: 'free' | 'paid';
  private readonly now: Date;
  private readonly archiveItems: readonly ArchiveItemInput[];

  constructor(deps: ArchiveSearchServiceDeps) {
    this.tier = deps.tier;
    this.now = deps.now;
    this.archiveItems = deps.archiveItems;
  }

  search(filter: ArchiveSearchFilter = {}): ArchiveSearchResult {
    let results = this.archiveItems.filter((item) => {
      if (this.tier === 'free' && item.kind !== 'snapshot') {
        const cutoff = new Date(this.now);
        cutoff.setUTCDate(cutoff.getUTCDate() - 30);
        if (item.createdAt < cutoff) return false;
      }
      return true;
    });

    if (filter.query) {
      const q = filter.query.toLowerCase();
      results = results.filter((item) => {
        const texts = [
          item.summary ?? '',
          item.html ?? '',
          item.body ?? '',
        ];
        return texts.some((t) => t.toLowerCase().includes(q));
      });
    }

    if (filter.entity) {
      results = results.filter((item) =>
        item.entities?.some((e) => e === filter.entity),
      );
    }

    if (filter.from) {
      results = results.filter((item) => item.createdAt >= filter.from!);
    }

    if (filter.to) {
      results = results.filter((item) => item.createdAt <= filter.to!);
    }

    if (filter.topic) {
      results = results.filter((item) => item.topicId === filter.topic);
    }

    if (filter.source) {
      results = results.filter((item) =>
        item.sourceIds?.includes(filter.source!),
      );
    }

    return {
      items: results.map((item) => ({
        id: item.id,
        kind: item.kind,
        titleOrSummary: item.summary ?? item.html ?? item.body ?? item.id,
      })),
    };
  }
}
