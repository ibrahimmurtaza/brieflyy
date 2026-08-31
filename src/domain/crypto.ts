import { randomBytes, createHash, randomUUID } from 'node:crypto';

import { MAGIC_LINK_BYTES } from '../config.js';

export interface RandomSource {
  bytes(length: number): Uint8Array;
  uuid(): string;
}

export const nodeRandom: RandomSource = {
  bytes(length: number): Uint8Array {
    return new Uint8Array(randomBytes(length));
  },
  uuid(): string {
    return randomUUID();
  },
};

export function generateMagicLinkToken(rand: RandomSource = nodeRandom): string {
  return Buffer.from(rand.bytes(MAGIC_LINK_BYTES)).toString('base64url');
}

export function generateSessionId(rand: RandomSource = nodeRandom): string {
  return Buffer.from(rand.bytes(MAGIC_LINK_BYTES)).toString('base64url');
}

export function hashMagicLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}