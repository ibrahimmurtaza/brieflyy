import { randomBytes, createHash, randomUUID } from 'node:crypto';

import { MAGIC_LINK_BYTES, UNSUBSCRIBE_TOKEN_BYTES } from '../config.js';

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

export function hashOauthState(state: string): string {
  return createHash('sha256').update(state).digest('hex');
}

export function hashOauthCodeVerifier(verifier: string): string {
  return createHash('sha256').update(verifier).digest('hex');
}

export function generateOauthCodeVerifier(rand: RandomSource = nodeRandom): string {
  return Buffer.from(rand.bytes(MAGIC_LINK_BYTES)).toString('base64url');
}

/**
 * The token an unsubscribe link carries.
 *
 * From the same random source as a magic link, and for the same reason: it is
 * the only thing standing between a forwarded brief and a stranger changing
 * somebody's subscription. Unlike a magic link it is a bearer token in a URL
 * rather than a one-time grant to a new session, which is why the
 * `unsubscribes` row that spends it is what makes it single-use — nothing about
 * the token itself can tell whether it has been used.
 */
export function generateUnsubscribeToken(rand: RandomSource = nodeRandom): string {
  return Buffer.from(rand.bytes(UNSUBSCRIBE_TOKEN_BYTES)).toString('base64url');
}