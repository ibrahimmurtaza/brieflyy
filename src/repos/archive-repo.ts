import type { ArchiveItemInput, ArchiveSearchFilter, ArchiveSearchResult } from '../services/archive-search-service.js';

export interface ArchiveRepo {
  search(userId: string, filter: ArchiveSearchFilter, tier: 'free' | 'paid', now: Date): Promise<ArchiveSearchResult>;
  listArchiveItems(userId: string): Promise<readonly ArchiveItemInput[]>;
}
