import { createHash } from 'node:crypto';

export interface FingerprintInput {
  readonly entities: readonly string[];
  readonly keyPhrases: readonly string[];
}

function normalizeToken(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ');
}

function uniqueSorted(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    const norm = normalizeToken(item);
    if (norm.length === 0) continue;
    if (seen.has(norm)) continue;
    seen.add(norm);
    out.push(norm);
  }
  out.sort();
  return out;
}

export function storyFingerprint(input: FingerprintInput): string {
  const entities = uniqueSorted(input.entities);
  const keyPhrases = uniqueSorted(input.keyPhrases);
  const payload = JSON.stringify({ entities, keyPhrases });
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}